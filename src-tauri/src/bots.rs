use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};
use tokio::process::Command;

use crate::app::App;
use crate::cfgread;
use crate::error::Res;
use crate::fsx::{self, now_ms};
use crate::instances;
use crate::logs::{self, LogLine};
use crate::paths::Inst;
use crate::procs;
use crate::python;
use crate::store::InstanceRecord;
use crate::token;

const CONSOLE_CAP: usize = 4000;
const RAW_OUTPUT: &str = "current.raw";
const STOP_TIMEOUT: Duration = Duration::from_secs(30);
const BACKOFF: [u64; 4] = [5, 15, 60, 300];
const STABLE_MS: u64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BotState {
    NotInstalled,
    Installing,
    #[default]
    Stopped,
    Starting,
    Running,
    Stopping,
    Crashed,
    Waiting,
    Updating,
}

impl BotState {
    pub fn as_str(self) -> &'static str {
        match self {
            BotState::NotInstalled => "not_installed",
            BotState::Installing => "installing",
            BotState::Stopped => "stopped",
            BotState::Starting => "starting",
            BotState::Running => "running",
            BotState::Stopping => "stopping",
            BotState::Crashed => "crashed",
            BotState::Waiting => "waiting",
            BotState::Updating => "updating",
        }
    }

    pub fn is_live(self) -> bool {
        matches!(self, BotState::Starting | BotState::Running | BotState::Stopping)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub reason: String,
    pub message: String,
    pub at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub generated_at: String,
    pub status: String,
    pub uptime_seconds: f64,
    pub bot_user: Option<String>,
    pub bot_id: Option<String>,
    pub latency_ms: Option<f64>,
    pub guilds: Option<i64>,
    pub version: Option<String>,
    pub python: Option<String>,
    pub discord_py: Option<String>,
    pub extensions_loaded: usize,
    pub extensions_failed: Vec<String>,
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotStatus {
    pub id: String,
    pub state: BotState,
    pub pid: Option<u32>,
    pub started_at: Option<u64>,
    pub ready_at: Option<u64>,
    pub bot_user: Option<String>,
    pub guilds: Option<i64>,
    pub last_exit: Option<ExitInfo>,
    pub restart_at: Option<u64>,
    pub restart_attempt: u32,
    pub diagnostics: Option<Diagnostics>,
    pub dashboard_running: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PidFile {
    pid: u32,
    started_at: u64,
}

#[derive(Default)]
struct Bot {
    state: BotState,
    busy: Option<BotState>,
    pid: Option<u32>,
    guard: Option<Arc<procs::Guard>>,
    started_at: Option<u64>,
    ready_at: Option<u64>,
    bot_user: Option<String>,
    guilds: Option<i64>,
    last_exit: Option<ExitInfo>,
    restart_at: Option<u64>,
    restart_attempt: u32,
    generation: u64,
    stop_requested: bool,
    killed: bool,
    adopted: bool,
    console: VecDeque<LogLine>,
    seq: u64,
    output: VecDeque<String>,
    problems: VecDeque<String>,
    rich_mode: bool,
    traceback: Option<Vec<String>>,
}

#[derive(Default)]
pub struct Bots {
    inner: Mutex<HashMap<String, Bot>>,
    secrets: Mutex<HashMap<String, String>>,
}

static READY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^ready as (.+?) \((\d+)\) \| (\d+) guilds").unwrap());
static RECONNECTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^reconnected as (.+)$").unwrap());

fn status_of(id: &str, bot: &Bot, root: Option<&Path>) -> BotStatus {
    let state = bot.busy.unwrap_or(bot.state);
    let diagnostics = match (root, state) {
        (Some(r), BotState::Running) => read_diagnostics(r, bot.started_at.unwrap_or(0)),
        _ => None,
    };
    BotStatus {
        id: id.to_string(),
        state,
        pid: bot.pid,
        started_at: bot.started_at,
        ready_at: bot.ready_at,
        bot_user: bot
            .bot_user
            .clone()
            .or_else(|| diagnostics.as_ref().and_then(|d| d.bot_user.clone())),
        guilds: bot.guilds.or_else(|| diagnostics.as_ref().and_then(|d| d.guilds)),
        last_exit: bot.last_exit.clone(),
        restart_at: bot.restart_at,
        restart_attempt: bot.restart_attempt,
        diagnostics,
        dashboard_running: false,
    }
}

pub fn read_diagnostics(root: &Path, since_ms: u64) -> Option<Diagnostics> {
    let text = std::fs::read_to_string(Inst::new(root).diagnostics()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let generated_at = v.get("generated_at")?.as_str()?.to_string();
    let generated_ms = parse_iso_ms(&generated_at)?;
    if generated_ms + 5_000 < since_ms {
        return None;
    }
    let interval = cfgread::health_interval_minutes(root) as u64 * 60_000;
    let stale = now_ms().saturating_sub(generated_ms) > interval * 2 + 60_000;
    let ext = v.get("extensions");
    let failed = match ext.and_then(|e| e.get("failed")) {
        Some(serde_json::Value::Object(m)) => m.keys().cloned().collect(),
        Some(serde_json::Value::Array(a)) => {
            a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()
        }
        _ => Vec::new(),
    };
    let bot = v.get("bot");
    let env = v.get("environment");
    Some(Diagnostics {
        generated_at,
        status: v
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("healthy")
            .to_string(),
        uptime_seconds: v.get("uptime_seconds").and_then(|s| s.as_f64()).unwrap_or(0.0),
        bot_user: bot
            .and_then(|b| b.get("user"))
            .and_then(|s| s.as_str())
            .map(str::to_string),
        bot_id: bot
            .and_then(|b| b.get("id"))
            .map(|s| s.to_string().trim_matches('"').to_string()),
        latency_ms: bot.and_then(|b| b.get("latency_ms")).and_then(|s| s.as_f64()),
        guilds: v.get("guilds").and_then(|g| g.as_i64()),
        version: v.get("version").and_then(|s| s.as_str()).map(str::to_string),
        python: env
            .and_then(|e| e.get("python"))
            .and_then(|s| s.as_str())
            .map(str::to_string),
        discord_py: env
            .and_then(|e| e.get("discord_py"))
            .and_then(|s| s.as_str())
            .map(str::to_string),
        extensions_loaded: ext
            .and_then(|e| e.get("loaded"))
            .and_then(|l| l.as_array())
            .map(|a| a.len())
            .unwrap_or(0),
        extensions_failed: failed,
        stale,
    })
}

pub fn parse_iso_ms(s: &str) -> Option<u64> {
    let s = s.trim();
    let (date, rest) = s.split_once('T')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>());
    let (y, m, day) = (d.next()?.ok()?, d.next()?.ok()?, d.next()?.ok()?);
    let time_end = rest
        .find(|c: char| c == '+' || c == 'Z' || (c == '-' && rest.find(':').is_some()))
        .unwrap_or(rest.len());
    let (time, tz) = rest.split_at(time_end);
    let mut t = time.split(':');
    let hh: i64 = t.next()?.parse().ok()?;
    let mm: i64 = t.next()?.parse().ok()?;
    let ss: f64 = t.next().unwrap_or("0").parse().ok()?;
    let offset_min: i64 = if tz.is_empty() || tz == "Z" {
        0
    } else {
        let sign = if tz.starts_with('-') { -1 } else { 1 };
        let mut p = tz[1..].split(':');
        let oh: i64 = p.next()?.parse().ok()?;
        let om: i64 = p.next().unwrap_or("0").parse().ok()?;
        sign * (oh * 60 + om)
    };
    let days = days_from_civil(y, m, day);
    let secs = days * 86400 + hh * 3600 + mm * 60 - offset_min * 60;
    Some((secs as f64 * 1000.0 + ss * 1000.0) as u64)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

impl Bots {
    pub fn remember_secret(&self, id: &str, token: &str) {
        self.secrets
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.to_string(), token.to_string());
    }

    fn secrets(&self) -> Vec<String> {
        self.secrets
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect()
    }

    fn with<R>(&self, id: &str, f: impl FnOnce(&mut Bot) -> R) -> R {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        f(map.entry(id.to_string()).or_default())
    }

    pub fn state_for(&self, rec: &InstanceRecord, installed: bool) -> (String, Option<String>) {
        let map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let bot = map.get(&rec.id);
        let state = match bot {
            Some(b) if b.busy.is_some() => b.busy.unwrap_or_default(),
            Some(b) if b.state != BotState::Stopped || installed => {
                if installed || b.state.is_live() {
                    b.state
                } else {
                    BotState::NotInstalled
                }
            }
            _ if installed => BotState::Stopped,
            _ => BotState::NotInstalled,
        };
        let health = if state == BotState::Running {
            bot.and_then(|b| b.started_at)
                .and_then(|s| read_diagnostics(&rec.path, s))
                .map(|d| d.status)
        } else {
            None
        };
        (state.as_str().to_string(), health)
    }

    pub fn is_live(&self, id: &str) -> bool {
        let map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        map.get(id)
            .map(|b| b.state.is_live() || b.state == BotState::Waiting)
            .unwrap_or(false)
    }

    pub fn any_live(&self) -> bool {
        let map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        map.values().any(|b| b.state.is_live())
    }

    pub fn live_ids(&self) -> Vec<String> {
        let map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        map.iter()
            .filter(|(_, b)| b.state.is_live() || b.state == BotState::Waiting)
            .map(|(k, _)| k.clone())
            .collect()
    }

    pub fn snapshot(&self, id: &str, root: &Path, installed: bool) -> BotStatus {
        let map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match map.get(id) {
            Some(b) => {
                let mut s = status_of(id, b, Some(root));
                if !installed && b.busy.is_none() && !b.state.is_live() {
                    s.state = BotState::NotInstalled;
                }
                s
            }
            None => {
                let b = Bot::default();
                let mut s = status_of(id, &b, Some(root));
                s.state = if installed {
                    BotState::Stopped
                } else {
                    BotState::NotInstalled
                };
                s
            }
        }
    }

    pub fn console(&self, id: &str) -> Vec<LogLine> {
        let map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        map.get(id)
            .map(|b| b.console.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn clear_console(&self, id: &str) {
        self.with(id, |b| b.console.clear());
    }

    pub fn set_busy(&self, app: &Arc<App>, id: &str, busy: Option<BotState>) {
        self.with(id, |b| b.busy = busy);
        emit_status(app, id);
    }

    pub fn launcher_line(&self, app: &Arc<App>, id: &str, level: &str, message: &str) {
        let line = self.with(id, |b| {
            b.seq += 1;
            let line = LogLine {
                seq: b.seq,
                time: local_time(),
                level: level.into(),
                logger: "launcher".into(),
                message: message.into(),
                trace: Vec::new(),
                source: "launcher".into(),
            };
            push_console(b, line.clone());
            line
        });
        let _ = app
            .handle
            .emit("bot-log", serde_json::json!({ "id": id, "lines": [line] }));
    }

    pub async fn stop_and_wait(&self, id: &str) {
        let pid = self.with(id, |b| {
            if b.state == BotState::Waiting {
                b.state = BotState::Stopped;
                b.restart_at = None;
                b.generation += 1;
            }
            if b.state.is_live() { b.pid } else { None }
        });
        if pid.is_some() {
            let _ = request_stop(self, id);
            for _ in 0..((STOP_TIMEOUT.as_millis() / 100) as u64 + 50) {
                if !self.is_live(id) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

fn local_time() -> String {
    let ms = now_ms();
    let secs = (ms / 1000) as i64;
    let tz = local_offset_secs();
    let t = secs + tz;
    let days = t.div_euclid(86400);
    let rem = t.rem_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02},{:03}",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        ms % 1000
    )
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(unix)]
fn local_offset_secs() -> i64 {
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&now, &mut tm);
        tm.tm_gmtoff
    }
}

#[cfg(windows)]
fn local_offset_secs() -> i64 {
    use windows_sys::Win32::System::Time::{GetTimeZoneInformation, TIME_ZONE_INFORMATION};
    unsafe {
        let mut tz: TIME_ZONE_INFORMATION = std::mem::zeroed();
        let r = GetTimeZoneInformation(&mut tz);
        let bias = tz.Bias + if r == 2 { tz.DaylightBias } else { tz.StandardBias };
        -(bias as i64) * 60
    }
}

fn push_console(b: &mut Bot, line: LogLine) {
    if b.console.len() >= CONSOLE_CAP {
        b.console.pop_front();
    }
    b.console.push_back(line);
}

pub fn emit_status(app: &Arc<App>, id: &str) {
    let Ok(rec) = app.store.instance(id) else { return };
    let installed = instances::is_installed(&rec.path);
    let mut status = app.bots.snapshot(id, &rec.path, installed);
    status.dashboard_running = app.dashboards.is_running(id);
    let _ = app.handle.emit("bot-status", &status);
    crate::tray::refresh(app);
}

fn request_stop(bots: &Bots, id: &str) -> Option<u32> {
    let (pid, guard) = bots.with(id, |b| {
        if !b.state.is_live() {
            return (None, None);
        }
        b.stop_requested = true;
        b.state = BotState::Stopping;
        (b.pid, b.guard.clone())
    });
    let pid = pid?;
    let sent = procs::graceful(pid, guard.as_deref());
    if !sent {
        procs::force(pid, guard.as_deref());
        bots.with(id, |b| b.killed = true);
    }
    Some(pid)
}

pub async fn stop(app: &Arc<App>, id: &str) -> Res<()> {
    let waiting = app.bots.with(id, |b| {
        if b.state == BotState::Waiting {
            b.state = BotState::Stopped;
            b.restart_at = None;
            b.generation += 1;
            true
        } else {
            false
        }
    });
    if waiting {
        app.bots
            .launcher_line(app, id, "INFO", "Automatic restart cancelled.");
        emit_status(app, id);
        return Ok(());
    }
    let Some(pid) = request_stop(&app.bots, id) else {
        emit_status(app, id);
        return Ok(());
    };
    app.bots.launcher_line(app, id, "INFO", "Stopping the bot.");
    emit_status(app, id);
    let (generation, guard) = app.bots.with(id, |b| (b.generation, b.guard.clone()));
    let app2 = app.clone();
    let id2 = id.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(STOP_TIMEOUT).await;
        let still = app2
            .bots
            .with(&id2, |b| b.generation == generation && b.state.is_live());
        if still {
            app2.bots.with(&id2, |b| b.killed = true);
            app2.bots.launcher_line(
                &app2,
                &id2,
                "WARNING",
                "The bot did not stop within 30 seconds and was ended.",
            );
            procs::force(pid, guard.as_deref());
        }
    });
    Ok(())
}

pub async fn start(app: &Arc<App>, id: &str) -> Res<()> {
    let rec = app.store.instance(id)?;
    let inst = Inst::new(&rec.path);
    if !instances::is_installed(&rec.path) {
        return Err("ZDBF is not installed for this bot yet. Finish the setup first.".into());
    }
    let can = app.bots.with(id, |b| {
        b.busy.is_none() && matches!(b.state, BotState::Stopped | BotState::Crashed | BotState::Waiting)
    });
    if !can {
        return Err("The bot is already running or busy.".into());
    }
    let tok = token::read(&inst.env_file());
    let Some(tok) = tok else {
        app.bots.with(id, |b| {
            b.state = BotState::Crashed;
            b.last_exit = Some(ExitInfo {
                code: None,
                reason: "token_missing".into(),
                message: String::new(),
                at: now_ms(),
            });
        });
        emit_status(app, id);
        return Ok(());
    };
    app.bots.remember_secret(id, &tok);
    if app.dashboards.is_enabled(id) {
        let _ = crate::dashboard::start_server(app, id).await;
    }
    spawn(app, &rec).await
}

async fn spawn(app: &Arc<App>, rec: &InstanceRecord) -> Res<()> {
    let id = rec.id.clone();
    let inst = Inst::new(&rec.path);
    let started_at = now_ms();
    let generation = app.bots.with(&id, |b| {
        b.generation += 1;
        b.state = BotState::Starting;
        b.pid = None;
        b.guard = None;
        b.started_at = Some(started_at);
        b.ready_at = None;
        b.bot_user = None;
        b.guilds = None;
        b.restart_at = None;
        b.stop_requested = false;
        b.killed = false;
        b.adopted = false;
        b.output.clear();
        b.problems.clear();
        b.rich_mode = false;
        b.traceback = None;
        b.generation
    });
    emit_status(app, &id);

    let log_file = cfgread::logs_dir(&rec.path).join("zdbf.log");
    let tail = logs::Tail::starting_at_end(log_file);

    let _ = std::fs::create_dir_all(inst.run_output_dir());
    prune_runs(&inst.run_output_dir(), 20);
    let raw_path = inst.run_output_dir().join(RAW_OUTPUT);
    let raw = match std::fs::File::create(&raw_path).and_then(|f| f.try_clone().map(|g| (f, g))) {
        Ok(pair) => pair,
        Err(e) => {
            app.bots.with(&id, |b| b.state = BotState::Stopped);
            emit_status(app, &id);
            return Err(format!("Could not create {}: {e}", raw_path.display()));
        }
    };

    let mut cmd = Command::new(inst.python());
    cmd.arg("-m")
        .arg("zdbf")
        .current_dir(&rec.path)
        .stdin(Stdio::null())
        .stdout(Stdio::from(raw.0))
        .stderr(Stdio::from(raw.1))
        .kill_on_drop(false);
    python::bot_env(app, &inst, &mut cmd);
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            app.bots.with(&id, |b| {
                b.state = BotState::Crashed;
                b.last_exit = Some(ExitInfo {
                    code: None,
                    reason: "python".into(),
                    message: format!("Python could not be started: {e}"),
                    at: now_ms(),
                });
            });
            emit_status(app, &id);
            return Ok(());
        }
    };
    let pid = child.id().unwrap_or(0);
    let guard = procs::after_spawn(pid).map(Arc::new);
    app.bots.with(&id, |b| {
        b.pid = Some(pid);
        b.guard = guard;
    });
    let _ = fsx::write_json(&inst.pidfile(), &PidFile { pid, started_at });
    app.bots.launcher_line(app, &id, "INFO", "Starting the bot.");
    emit_status(app, &id);

    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let run_file = inst.run_output_dir().join(format!("{started_at}.txt"));
    {
        let (app, id, done) = (app.clone(), id.clone(), done.clone());
        let out = logs::Tail {
            path: raw_path.clone(),
            offset: 0,
        };
        tokio::spawn(async move { output_loop(app, id, generation, out, run_file, done).await });
    }
    {
        let (app, id, done) = (app.clone(), id.clone(), done.clone());
        tokio::spawn(async move { tail_loop(app, id, generation, tail, done).await });
    }

    let app2 = app.clone();
    tokio::spawn(async move {
        let status = child.wait().await;
        let code = status.as_ref().ok().and_then(|s| s.code());
        tokio::time::sleep(Duration::from_millis(400)).await;
        done.store(true, std::sync::atomic::Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(400)).await;
        on_exit(&app2, &id, generation, code);
    });
    Ok(())
}

fn prune_runs(dir: &Path, keep: usize) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
    files.sort();
    if files.len() > keep {
        for f in &files[..files.len() - keep] {
            let _ = std::fs::remove_file(f);
        }
    }
}

async fn output_loop(
    app: Arc<App>,
    id: String,
    generation: u64,
    mut tail: logs::Tail,
    keep: PathBuf,
    done: Arc<std::sync::atomic::AtomicBool>,
) {
    let mut writer = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&keep)
        .ok();
    let mut partial = String::new();
    loop {
        let finished = done.load(std::sync::atomic::Ordering::SeqCst);
        let polled = tokio::task::spawn_blocking({
            let mut t = std::mem::replace(
                &mut tail,
                logs::Tail {
                    path: PathBuf::new(),
                    offset: 0,
                },
            );
            move || {
                let s = t.poll();
                (t, s)
            }
        })
        .await;
        let Ok((t, text)) = polled else { break };
        tail = t;
        partial.push_str(&text);
        while let Some(nl) = partial.find('\n') {
            let line: String = partial.drain(..=nl).collect();
            on_output(&app, &id, generation, &line, &mut writer);
        }
        if finished {
            if !partial.trim().is_empty() {
                let rest = std::mem::take(&mut partial);
                on_output(&app, &id, generation, &rest, &mut writer);
            }
            let _ = std::fs::remove_file(&tail.path);
            break;
        }
        if app.bots.with(&id, |b| b.generation != generation) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

fn on_output(app: &Arc<App>, id: &str, generation: u64, raw: &str, writer: &mut Option<std::fs::File>) {
    let secrets = app.bots.secrets();
    let line = logs::mask(raw.trim_end(), &secrets);
    if let Some(f) = writer.as_mut() {
        let _ = writeln!(f, "{line}");
    }
    let forward = app.bots.with(id, |b| {
        if b.generation != generation {
            return Vec::new();
        }
        if b.output.len() >= 120 {
            b.output.pop_front();
        }
        b.output.push_back(line.clone());
        let mut out = Vec::new();
        if let Some(tb) = b.traceback.as_mut() {
            tb.push(line.clone());
            if !line.starts_with(' ') && !line.starts_with("Traceback") {
                let tb = b.traceback.take().unwrap_or_default();
                b.seq += 1;
                let entry = LogLine {
                    seq: b.seq,
                    time: local_time(),
                    level: "ERROR".into(),
                    logger: "python".into(),
                    message: line.clone(),
                    trace: tb[..tb.len().saturating_sub(1)].to_vec(),
                    source: "output".into(),
                };
                push_problem(b, &line);
                push_console(b, entry.clone());
                out.push(entry);
            }
            return out;
        }
        if line.starts_with("Traceback (most recent call last)") {
            b.traceback = Some(vec![line.clone()]);
            return out;
        }
        if b.rich_mode {
            return out;
        }
        if logs::is_rich_line(&line) {
            b.rich_mode = true;
            return out;
        }
        if line.trim().is_empty() {
            return out;
        }
        let level = if line.starts_with('✗') || line.contains("Error") {
            "ERROR"
        } else {
            "INFO"
        };
        if level == "ERROR" {
            push_problem(b, &line);
        }
        b.seq += 1;
        let entry = LogLine {
            seq: b.seq,
            time: local_time(),
            level: level.into(),
            logger: String::new(),
            message: line.clone(),
            trace: Vec::new(),
            source: "output".into(),
        };
        push_console(b, entry.clone());
        out.push(entry);
        out
    });
    if !forward.is_empty() {
        let _ = app
            .handle
            .emit("bot-log", serde_json::json!({ "id": id, "lines": forward }));
    }
}

fn push_problem(b: &mut Bot, text: &str) {
    if b.problems.len() >= 20 {
        b.problems.pop_front();
    }
    b.problems.push_back(text.to_string());
}

async fn tail_loop(
    app: Arc<App>,
    id: String,
    generation: u64,
    mut tail: logs::Tail,
    done: Arc<std::sync::atomic::AtomicBool>,
) {
    let mut parser = logs::Parser::new();
    let mut idle_rounds = 0u32;
    loop {
        let finished = done.load(std::sync::atomic::Ordering::SeqCst);
        let text = tokio::task::spawn_blocking({
            let mut t = std::mem::replace(
                &mut tail,
                logs::Tail {
                    path: PathBuf::new(),
                    offset: 0,
                },
            );
            move || {
                let s = t.poll();
                (t, s)
            }
        })
        .await;
        let Ok((t, text)) = text else { break };
        tail = t;
        let secrets = app.bots.secrets();
        if text.is_empty() {
            idle_rounds += 1;
        } else {
            idle_rounds = 0;
        }
        let flush = idle_rounds >= 2 || finished;
        let lines = app.bots.with(&id, |b| {
            let mut seq = b.seq;
            let mut lines = parser.feed(&text, &secrets, &mut seq);
            if flush
                && parser.has_pending()
                && let Some(l) = parser.flush()
            {
                lines.push(l);
            }
            b.seq = seq;
            lines
        });
        if !lines.is_empty() {
            let changed = app.bots.with(&id, |b| {
                if b.generation != generation {
                    return false;
                }
                let mut changed = false;
                for l in &lines {
                    changed |= interpret(b, l);
                    push_console(b, l.clone());
                }
                changed
            });
            let _ = app
                .handle
                .emit("bot-log", serde_json::json!({ "id": id, "lines": lines }));
            if changed {
                emit_status(&app, &id);
            }
        }
        if finished {
            break;
        }
        let gone = app.bots.with(&id, |b| b.generation != generation);
        if gone {
            break;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

fn interpret(b: &mut Bot, l: &LogLine) -> bool {
    if l.level == "ERROR" || l.level == "CRITICAL" {
        let mut text = l.message.clone();
        if let Some(last) = l.trace.iter().rev().find(|t| !t.trim().is_empty()) {
            text = format!("{text}\n{last}");
        }
        push_problem(b, &text);
    }
    if l.logger == "zdbf.bot" {
        if let Some(c) = READY.captures(&l.message) {
            b.bot_user = Some(c[1].to_string());
            b.guilds = c[3].parse().ok();
            if b.state == BotState::Starting {
                b.state = BotState::Running;
                b.ready_at = Some(now_ms());
            }
            return true;
        }
        if let Some(c) = RECONNECTED.captures(&l.message) {
            b.bot_user = Some(c[1].to_string());
            if b.state == BotState::Starting {
                b.state = BotState::Running;
                b.ready_at = Some(now_ms());
            }
            return true;
        }
        if l.message.starts_with("joined guild ") {
            b.guilds = b.guilds.map(|g| g + 1);
            return true;
        }
        if l.message.starts_with("left guild ") {
            b.guilds = b.guilds.map(|g| (g - 1).max(0));
            return true;
        }
    }
    false
}

fn classify(b: &Bot, code: Option<i32>) -> ExitInfo {
    let problems: Vec<&String> = b.problems.iter().collect();
    let has = |needle: &str| {
        problems.iter().any(|p| p.contains(needle)) || b.output.iter().any(|o| o.contains(needle))
    };
    let at = now_ms();
    let (reason, message) = if b.stop_requested {
        if b.killed {
            ("killed", String::new())
        } else {
            ("stopped", String::new())
        }
    } else if has("DISCORD_TOKEN is not set") {
        ("token_missing", String::new())
    } else if has("Login failed") || has("Improper token") {
        ("token_invalid", String::new())
    } else if has("rejected the privileged intents") || has("PrivilegedIntentsRequired") {
        ("intents", String::new())
    } else if code == Some(2) {
        let mut lines = Vec::new();
        let mut on = false;
        for o in &b.output {
            if o.starts_with('✗') {
                on = true;
                lines.push(o.trim_start_matches('✗').trim().to_string());
            } else if on && o.starts_with(' ') {
                lines.push(o.trim().to_string());
            } else {
                on = false;
            }
        }
        ("config", lines.join("\n"))
    } else if has("No module named") || has("ModuleNotFoundError") || has("ImportError") {
        let msg = problems
            .iter()
            .rev()
            .chain(b.output.iter().rev().collect::<Vec<_>>().iter())
            .find(|p| p.contains("No module named") || p.contains("ImportError"))
            .map(|s| s.lines().last().unwrap_or("").to_string())
            .unwrap_or_default();
        ("python", msg)
    } else if code == Some(0) {
        ("shutdown", String::new())
    } else {
        let msg = problems.last().map(|s| s.to_string()).unwrap_or_else(|| {
            b.output
                .iter()
                .rev()
                .find(|o| !o.trim().is_empty())
                .cloned()
                .unwrap_or_default()
        });
        ("crash", msg)
    };
    ExitInfo {
        code,
        reason: reason.into(),
        message,
        at,
    }
}

fn retryable(reason: &str) -> bool {
    matches!(reason, "crash" | "killed")
}

fn on_exit(app: &Arc<App>, id: &str, generation: u64, code: Option<i32>) {
    let auto_restart = app.store.instance(id).map(|r| r.auto_restart).unwrap_or(false);
    let outcome = app.bots.with(id, |b| {
        if b.generation != generation {
            return None;
        }
        let exit = classify(b, code);
        let ran_for = b.started_at.map(|s| now_ms().saturating_sub(s)).unwrap_or(0);
        if ran_for > STABLE_MS {
            b.restart_attempt = 0;
        }
        b.pid = None;
        b.guard = None;
        let intended = exit.reason == "stopped" || exit.reason == "shutdown";
        let mut restart_in = None;
        if intended || (b.stop_requested && exit.reason == "killed") {
            b.state = BotState::Stopped;
            b.restart_attempt = 0;
        } else if auto_restart && retryable(&exit.reason) {
            let idx = (b.restart_attempt as usize).min(BACKOFF.len() - 1);
            let wait = BACKOFF[idx];
            b.restart_attempt += 1;
            b.state = BotState::Waiting;
            b.restart_at = Some(now_ms() + wait * 1000);
            restart_in = Some(wait);
        } else {
            b.state = BotState::Crashed;
        }
        b.last_exit = Some(exit.clone());
        Some((
            exit,
            b.started_at.unwrap_or(0),
            restart_in,
            b.generation,
            intended || b.stop_requested,
        ))
    });
    let Some((exit, started_at, restart_in, generation, intended)) = outcome else {
        return;
    };
    if let Ok(rec) = app.store.instance(id) {
        let inst = Inst::new(&rec.path);
        let _ = std::fs::remove_file(inst.pidfile());
        let entry = serde_json::json!({
            "startedAt": started_at, "endedAt": exit.at, "code": exit.code,
            "reason": exit.reason, "message": exit.message,
        });
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(inst.runs())
        {
            let _ = writeln!(f, "{entry}");
        }
    }
    let msg = match exit.reason.as_str() {
        "stopped" => "The bot stopped.".to_string(),
        "killed" => "The bot was ended.".to_string(),
        "shutdown" => "The bot shut down.".to_string(),
        _ => format!(
            "The bot stopped unexpectedly (exit code {}).",
            exit.code.map(|c| c.to_string()).unwrap_or("unknown".into())
        ),
    };
    app.bots
        .launcher_line(app, id, if intended { "INFO" } else { "ERROR" }, &msg);
    emit_status(app, id);
    if !intended {
        crate::tray::notify_crash(app, id, &exit);
    }
    if app.quitting() {
        if !app.bots.any_live() {
            app.finish_quit();
        }
        return;
    }
    if let Some(wait) = restart_in {
        let app = app.clone();
        let id = id.to_string();
        app.bots.launcher_line(
            &app,
            &id,
            "WARNING",
            &format!("Starting again in {wait} seconds."),
        );
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(wait)).await;
            let go = app.bots.with(&id, |b| {
                b.generation == generation && b.state == BotState::Waiting
            });
            if go && let Ok(rec) = app.store.instance(&id) {
                let _ = spawn(&app, &rec).await;
            }
        });
    }
    if !matches!(app.bots.with(id, |b| b.state), BotState::Waiting) {
        app.dashboards.stop_if_by_bot(id);
        emit_status(app, id);
    }
}

pub fn adopt_orphans(app: &Arc<App>) {
    if cfg!(windows) {
        return;
    }
    for rec in app.store.instances() {
        let inst = Inst::new(&rec.path);
        let Some(pf) = fsx::read_json::<PidFile>(&inst.pidfile()) else {
            continue;
        };
        if !procs::alive(pf.pid) || !looks_like_bot(pf.pid, &rec.path) {
            let _ = std::fs::remove_file(inst.pidfile());
            continue;
        }
        if let Some(t) = token::read(&inst.env_file()) {
            app.bots.remember_secret(&rec.id, &t);
        }
        let generation = app.bots.with(&rec.id, |b| {
            b.generation += 1;
            b.state = BotState::Running;
            b.pid = Some(pf.pid);
            b.started_at = Some(pf.started_at);
            b.ready_at = Some(pf.started_at);
            b.adopted = true;
            b.rich_mode = true;
            b.generation
        });
        app.bots.launcher_line(
            app,
            &rec.id,
            "INFO",
            "The bot was still running. The launcher reconnected to it.",
        );
        let tail = logs::Tail::starting_at_end(cfgread::logs_dir(&rec.path).join("zdbf.log"));
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        {
            let (app, id, done) = (app.clone(), rec.id.clone(), done.clone());
            tauri::async_runtime::spawn(async move { tail_loop(app, id, generation, tail, done).await });
        }
        {
            let (app, id, done) = (app.clone(), rec.id.clone(), done.clone());
            let out = logs::Tail::starting_at_end(inst.run_output_dir().join(RAW_OUTPUT));
            let keep = inst.run_output_dir().join(format!("{}.txt", pf.started_at));
            tauri::async_runtime::spawn(
                async move { output_loop(app, id, generation, out, keep, done).await },
            );
        }
        let (app2, id) = (app.clone(), rec.id.clone());
        let pid = pf.pid;
        tauri::async_runtime::spawn(async move {
            while procs::alive(pid) {
                tokio::time::sleep(Duration::from_millis(1000)).await;
            }
            done.store(true, std::sync::atomic::Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(500)).await;
            let stopped = app2.bots.with(&id, |b| b.stop_requested);
            on_exit(&app2, &id, generation, if stopped { Some(0) } else { None });
        });
    }
}

#[cfg(target_os = "linux")]
fn looks_like_bot(pid: u32, root: &Path) -> bool {
    let cmd = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
    let cmd = String::from_utf8_lossy(&cmd).replace('\0', " ");
    let cwd = std::fs::read_link(format!("/proc/{pid}/cwd")).ok();
    cmd.contains("-m zdbf") && cwd.as_deref().map(|c| same_path(c, root)).unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
fn looks_like_bot(pid: u32, root: &Path) -> bool {
    let out = std::process::Command::new("ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output();
    let cmd = out
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    cmd.contains("-m zdbf") && cmd.contains(&*root.join(".venv").to_string_lossy())
        || (cmd.contains("-m zdbf") && Inst::new(root).pidfile().exists())
}

#[cfg(target_os = "linux")]
fn same_path(a: &Path, b: &Path) -> bool {
    let ca = std::fs::canonicalize(a).unwrap_or_else(|_| a.to_path_buf());
    let cb = std::fs::canonicalize(b).unwrap_or_else(|_| b.to_path_buf());
    ca == cb
}

#[tauri::command]
pub async fn start_bot(app: State<'_, Arc<App>>, id: String) -> Res<()> {
    let app = app.inner().clone();
    start(&app, &id).await
}

#[tauri::command]
pub async fn stop_bot(app: State<'_, Arc<App>>, id: String) -> Res<()> {
    let app = app.inner().clone();
    stop(&app, &id).await
}

#[tauri::command]
pub async fn restart_bot(app: State<'_, Arc<App>>, id: String) -> Res<()> {
    let app = app.inner().clone();
    if app.bots.is_live(&id) {
        app.bots.stop_and_wait(&id).await;
    }
    start(&app, &id).await
}

#[tauri::command]
pub fn bot_status(app: State<'_, Arc<App>>, id: String) -> Res<BotStatus> {
    let rec = app.store.instance(&id)?;
    let installed = instances::is_installed(&rec.path);
    let mut s = app.bots.snapshot(&id, &rec.path, installed);
    s.dashboard_running = app.dashboards.is_running(&id);
    Ok(s)
}

#[tauri::command]
pub fn console_snapshot(app: State<'_, Arc<App>>, id: String) -> Vec<LogLine> {
    app.bots.console(&id)
}

#[tauri::command]
pub fn clear_console(app: State<'_, Arc<App>>, id: String) {
    app.bots.clear_console(&id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_iso_dates() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:01+00:00"), Some(1000));
        assert_eq!(
            parse_iso_ms("2026-11-12T16:53:31.500000+00:00"),
            Some(1_794_502_411_500)
        );
        assert_eq!(parse_iso_ms("2026-11-12T17:53:31+01:00"), Some(1_794_502_411_000));
    }

    #[test]
    fn classifies_exits() {
        let mut b = Bot::default();
        b.problems
            .push_back("Login failed - the DISCORD_TOKEN in .env is invalid.".into());
        assert_eq!(classify(&b, Some(1)).reason, "token_invalid");
        let mut b = Bot::default();
        b.output.push_back("✗ Invalid config.toml:".into());
        b.output
            .push_back("  backup.max_per_guild: Input should be a valid integer".into());
        let e = classify(&b, Some(2));
        assert_eq!(e.reason, "config");
        assert!(e.message.contains("backup.max_per_guild"));
        let b = Bot {
            stop_requested: true,
            ..Default::default()
        };
        assert_eq!(classify(&b, Some(0)).reason, "stopped");
        let b = Bot::default();
        assert_eq!(classify(&b, Some(0)).reason, "shutdown");
        assert_eq!(classify(&b, Some(1)).reason, "crash");
    }

    #[test]
    fn detects_ready() {
        let mut b = Bot {
            state: BotState::Starting,
            ..Default::default()
        };
        let l = LogLine {
            seq: 1,
            time: String::new(),
            level: "INFO".into(),
            logger: "zdbf.bot".into(),
            message: "ready as Test#0001 (123) | 3 guilds | 1 shard(s) | ZDBF 2.0.0 | discord.py 2.7.1"
                .into(),
            trace: vec![],
            source: "log".into(),
        };
        assert!(interpret(&mut b, &l));
        assert_eq!(b.state, BotState::Running);
        assert_eq!(b.guilds, Some(3));
        assert_eq!(b.bot_user.as_deref(), Some("Test#0001"));
    }
}
