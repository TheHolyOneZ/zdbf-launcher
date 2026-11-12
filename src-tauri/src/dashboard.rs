use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json};
use sha2::{Digest, Sha256};
use tauri::State;
use tauri_plugin_opener::OpenerExt;

use crate::app::App;
use crate::config;
use crate::error::{Ctx, Res};
use crate::fsx;
use crate::install::Reporter;
use crate::instances;
use crate::paths::Inst;
use crate::python;

const KEY_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const FIRST_PORT: u16 = 8090;

struct PhpBuild {
    version: &'static str,
    urls: &'static [&'static str],
    sha256: &'static str,
    zip: bool,
}

fn php_build() -> Option<PhpBuild> {
    let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
    Some(match (os, arch) {
        ("linux", "x86_64") => PhpBuild {
            version: "8.5.8",
            urls: &["https://dl.static-php.dev/static-php-cli/common/php-8.5.8-cli-linux-x86_64.tar.gz"],
            sha256: "517a18e0f0874de35669fe134eb3c52508e128a6d1da5bf890760cb800ada410",
            zip: false,
        },
        ("linux", "aarch64") => PhpBuild {
            version: "8.5.8",
            urls: &["https://dl.static-php.dev/static-php-cli/common/php-8.5.8-cli-linux-aarch64.tar.gz"],
            sha256: "af995ef6b3187b39932a00714dfb97e44bfa40a9243c4c29f61f19d583950753",
            zip: false,
        },
        ("macos", "x86_64") => PhpBuild {
            version: "8.5.8",
            urls: &["https://dl.static-php.dev/static-php-cli/common/php-8.5.8-cli-macos-x86_64.tar.gz"],
            sha256: "05751000c6643f82e8377ed19d55bc159f84bbed46ace1fcc6f62be9866c787c",
            zip: false,
        },
        ("macos", "aarch64") => PhpBuild {
            version: "8.5.8",
            urls: &["https://dl.static-php.dev/static-php-cli/common/php-8.5.8-cli-macos-aarch64.tar.gz"],
            sha256: "cba9bd8b38b51ef2c7cebf02af689e4481bbd07f65edc0b63d3a43b04e0c9db7",
            zip: false,
        },
        ("windows", "x86_64") => PhpBuild {
            version: "8.5.12",
            urls: &[
                "https://windows.php.net/downloads/releases/php-8.5.12-1-nts-Win32-vs17-x64.zip",
                "https://windows.php.net/downloads/releases/archives/php-8.5.12-1-nts-Win32-vs17-x64.zip",
            ],
            sha256: "2a36a2edcb7a5b9252f638fd5e4cf84d7f6e066092654220dc0b63e5cf4e9723",
            zip: true,
        },
        _ => return None,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct LocalState {
    port: Option<u16>,
    setup_key: Option<String>,
    prepared_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardState {
    enabled: bool,
    php_ready: bool,
    php_version: Option<String>,
    prepared: bool,
    running: bool,
    port: Option<u16>,
    url: Option<String>,
    setup_key: Option<String>,
    setup_done: bool,
    paired: bool,
    needs_runtime: bool,
    supported: bool,
}

struct Server {
    child: tokio::process::Child,
    by_bot: bool,
}

#[derive(Default)]
pub struct Dashboards {
    servers: Mutex<HashMap<String, Server>>,
}

impl Dashboards {
    pub fn is_running(&self, id: &str) -> bool {
        let mut map = self.servers.lock().unwrap_or_else(|e| e.into_inner());
        match map.get_mut(id) {
            Some(s) => matches!(s.child.try_wait(), Ok(None)),
            None => false,
        }
    }

    pub fn is_enabled(&self, _id: &str) -> bool {
        true
    }

    pub fn stop(&self, id: &str) {
        let mut map = self.servers.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut s) = map.remove(id) {
            let _ = s.child.start_kill();
        }
    }

    pub fn stop_if_by_bot(&self, id: &str) {
        let by_bot = {
            let map = self.servers.lock().unwrap_or_else(|e| e.into_inner());
            map.get(id).map(|s| s.by_bot).unwrap_or(false)
        };
        if by_bot {
            self.stop(id);
        }
    }

    pub fn stop_everything(&self) {
        let mut map = self.servers.lock().unwrap_or_else(|e| e.into_inner());
        for (_, mut s) in map.drain() {
            let _ = s.child.start_kill();
        }
    }
}

fn dirs_of(inst: &Inst) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    let base = inst.dashboard();
    (
        base.join("web"),
        base.join("data"),
        base.join("router.php"),
        base.join("state.json"),
    )
}

fn load_state(inst: &Inst) -> LocalState {
    fsx::read_json(&dirs_of(inst).3).unwrap_or_default()
}

fn save_state(inst: &Inst, s: &LocalState) -> Res<()> {
    fsx::write_json(&dirs_of(inst).3, s)
}

fn php_dir(app: &App) -> Option<PathBuf> {
    php_build().map(|b| app.data_dir.join("php").join(b.version))
}

fn php_exe(app: &App) -> Option<PathBuf> {
    php_dir(app).map(|d| d.join(if cfg!(windows) { "php.exe" } else { "php" }))
}

pub fn new_setup_key() -> String {
    let mut raw = [0u8; 16];
    getrandom(&mut raw);
    let chars: String = raw
        .iter()
        .map(|b| KEY_ALPHABET[(*b as usize) % 32] as char)
        .collect();
    format!(
        "{}-{}-{}-{}",
        &chars[0..4],
        &chars[4..8],
        &chars[8..12],
        &chars[12..16]
    )
}

fn getrandom(buf: &mut [u8]) {
    if getrandom::fill(buf).is_err() {
        for chunk in buf.chunks_mut(16) {
            let u = uuid::Uuid::new_v4();
            let b = u.as_bytes();
            for (i, v) in chunk.iter_mut().enumerate() {
                *v = b[(i * 7 + 3) % 16] ^ b[i];
            }
        }
    }
}

fn key_file_contents(key: &str) -> String {
    format!(
        "<?php\nif (!defined('ZDBF_DASHBOARD')) {{\n    http_response_code(404);\n    exit;\n}}\nreturn '{key}';\n"
    )
}

fn setup_done(data: &Path) -> bool {
    fs::read_to_string(data.join("config.php"))
        .map(|t| t.contains("'installed' => true"))
        .unwrap_or(false)
}

fn paired(root: &Path) -> bool {
    root.join("data").join("dashboard").join("link.json").is_file()
}

fn module_enabled(root: &Path) -> bool {
    let overrides = crate::cfgread::overrides(root);
    if let Some(v) = overrides
        .get("modules")
        .and_then(|m| m.get("dashboard"))
        .and_then(|v| v.as_bool())
    {
        return v;
    }
    config::load_doc(root)
        .ok()
        .and_then(|(d, _)| d.get("modules")?.get("dashboard")?.as_bool())
        .unwrap_or(false)
}

fn free_port(preferred: Option<u16>) -> u16 {
    if let Some(p) = preferred
        && TcpListener::bind(("127.0.0.1", p)).is_ok()
    {
        return p;
    }
    (FIRST_PORT..FIRST_PORT + 200)
        .find(|p| TcpListener::bind(("127.0.0.1", *p)).is_ok())
        .unwrap_or(FIRST_PORT)
}

async fn php_version(exe: &Path, ini: Option<&Path>) -> Result<String, i32> {
    let mut cmd = tokio::process::Command::new(exe);
    if let Some(i) = ini {
        cmd.arg("-c").arg(i);
    }
    cmd.args([
        "-r",
        "echo PHP_VERSION, ' ', extension_loaded('pdo_sqlite') ? 1 : 0, extension_loaded('openssl') ? 1 : 0;",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    python::hide_window(&mut cmd);
    let out = cmd.output().await.map_err(|_| -1)?;
    if !out.status.success() {
        return Err(out.status.code().unwrap_or(-1));
    }
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let mut parts = text.split_whitespace();
    let version = parts.next().unwrap_or("").to_string();
    if parts.next() != Some("11") {
        return Err(-2);
    }
    Ok(version)
}

fn ini_path(app: &App) -> Option<PathBuf> {
    if cfg!(windows) {
        php_dir(app).map(|d| d.join("php.ini"))
    } else {
        None
    }
}

const WINDOWS_INI: &str = "extension_dir = \"ext\"\nextension=pdo_sqlite\nextension=sqlite3\nextension=openssl\nextension=curl\nextension=mbstring\nextension=fileinfo\nmemory_limit = 256M\ndisplay_errors = Off\n";

async fn ensure_php(app: &Arc<App>, rep: &Reporter) -> Res<String> {
    let build = php_build().ctx(|| "The local dashboard is not available for this system yet.".into())?;
    let dir = php_dir(app).ctx(|| "No PHP folder.".into())?;
    let exe = php_exe(app).ctx(|| "No PHP program.".into())?;
    let ini = ini_path(app);
    if exe.is_file()
        && let Ok(v) = php_version(&exe, ini.as_deref()).await
    {
        return Ok(v);
    }
    let label = format!("Downloading PHP {}", build.version);
    rep.step("php", &label);
    let mut bytes = None;
    let mut last_err = String::new();
    for url in build.urls {
        match app.http.get(*url).timeout(Duration::from_secs(600)).send().await {
            Ok(mut resp) if resp.status().is_success() => {
                let total = resp.content_length();
                let mut buf = Vec::new();
                while let Some(chunk) = resp
                    .chunk()
                    .await
                    .map_err(|e| format!("The PHP download was interrupted: {e}"))?
                {
                    buf.extend_from_slice(&chunk);
                    if buf.len() % (512 * 1024) < chunk.len() {
                        rep.detail(
                            "php",
                            &label,
                            &format!("{:.1} MB", buf.len() as f64 / 1_048_576.0),
                            total.map(|t| buf.len() as f64 / t as f64),
                        );
                    }
                }
                bytes = Some(buf);
                break;
            }
            Ok(resp) => last_err = format!("status {}", resp.status().as_u16()),
            Err(e) => last_err = e.to_string(),
        }
    }
    let bytes =
        bytes.ctx(|| format!("PHP could not be downloaded ({last_err}). Check your internet connection."))?;
    let hash = hex::encode(Sha256::digest(&bytes));
    if hash != build.sha256 {
        return Err(
            "The downloaded PHP does not match the expected checksum, so it was not used. Try again later."
                .into(),
        );
    }
    rep.step("php", "Unpacking PHP");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).ctx(|| format!("Could not create {}", dir.display()))?;
    let d2 = dir.clone();
    let zip = build.zip;
    tokio::task::spawn_blocking(move || unpack(&bytes, &d2, zip))
        .await
        .map_err(|e| e.to_string())??;
    if let Some(i) = &ini {
        fsx::atomic_write(i, WINDOWS_INI.as_bytes())?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&exe, fs::Permissions::from_mode(0o755));
    }
    match php_version(&exe, ini.as_deref()).await {
        Ok(v) => Ok(v),
        Err(-1073741515) | Err(-1073741701) => Err(
            "PHP needs the Microsoft Visual C++ Redistributable. Install it from https://aka.ms/vs/17/release/vc_redist.x64.exe and try again."
                .into(),
        ),
        Err(-2) => Err("This PHP build lacks SQLite or OpenSSL support.".into()),
        Err(code) => Err(format!("PHP does not start (exit code {code}).")),
    }
}

fn unpack(bytes: &[u8], dir: &Path, zip: bool) -> Res<()> {
    if zip {
        let mut ar = zip::ZipArchive::new(std::io::Cursor::new(bytes))
            .map_err(|e| format!("The PHP archive is damaged: {e}"))?;
        for i in 0..ar.len() {
            let mut f = ar.by_index(i).map_err(|e| e.to_string())?;
            let Some(rel) = f.enclosed_name() else { continue };
            let out = dir.join(rel);
            if f.is_dir() {
                fs::create_dir_all(&out).ok();
                continue;
            }
            if let Some(p) = out.parent() {
                fs::create_dir_all(p).ok();
            }
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            fs::write(&out, buf).ctx(|| format!("Could not write {}", out.display()))?;
        }
    } else {
        let mut ar = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
        for entry in ar.entries().map_err(|e| e.to_string())? {
            let mut entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path().map_err(|e| e.to_string())?.into_owned();
            let Some(name) = path.file_name() else { continue };
            if entry.header().entry_type().is_file() {
                let out = dir.join(name);
                let mut buf = Vec::new();
                entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
                fs::write(&out, buf).ctx(|| format!("Could not write {}", out.display()))?;
            }
        }
    }
    Ok(())
}

pub fn refresh_web(app: &App, id: &str) -> Res<()> {
    let rec = app.store.instance(id)?;
    let inst = Inst::new(&rec.path);
    let (web, _, router, _) = dirs_of(&inst);
    if !web.exists() {
        return Ok(());
    }
    copy_web(&inst, &web, &router)?;
    let mut st = load_state(&inst);
    st.prepared_version = instances::read_meta(&rec.path).version;
    save_state(&inst, &st)
}

fn copy_web(inst: &Inst, web: &Path, router: &Path) -> Res<()> {
    let src = inst.root.join("dashboard");
    if !src.join("index.php").is_file() {
        return Err("This ZDBF version has no dashboard folder.".into());
    }
    let staging = web.with_extension("new");
    let _ = fs::remove_dir_all(&staging);
    fsx::copy_dir(&src, &staging, &|p| {
        let rel = p
            .strip_prefix(&src)
            .ok()
            .map(|r| r.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        rel == "data" || rel.starts_with("data/")
    })?;
    let old = web.with_extension("old");
    let _ = fs::remove_dir_all(&old);
    if web.exists() {
        fs::rename(web, &old).ctx(|| format!("Could not replace {}", web.display()))?;
    }
    fs::rename(&staging, web).ctx(|| format!("Could not create {}", web.display()))?;
    let _ = fs::remove_dir_all(&old);
    let r = inst.root.join("tools").join("dashboard_dev_router.php");
    fs::copy(&r, router).ctx(|| "The dashboard router is missing from this ZDBF version.".to_string())?;
    Ok(())
}

pub async fn start_server(app: &Arc<App>, id: &str) -> Res<()> {
    start_inner(app, id, true).await
}

async fn start_inner(app: &Arc<App>, id: &str, by_bot: bool) -> Res<()> {
    let rec = app.store.instance(id)?;
    let inst = Inst::new(&rec.path);
    let (web, data, router, _) = dirs_of(&inst);
    if !web.join("index.php").is_file() {
        return Ok(());
    }
    if app.dashboards.is_running(id) {
        if by_bot
            && let Some(s) = app
                .dashboards
                .servers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get_mut(id)
        {
            s.by_bot = true;
        }
        return Ok(());
    }
    if by_bot && !module_enabled(&rec.path) {
        return Ok(());
    }
    let exe = php_exe(app).ctx(|| "PHP is not available for this system.".into())?;
    if !exe.is_file() {
        return Err("PHP is not installed yet. Set up the dashboard first.".into());
    }
    let mut st = load_state(&inst);
    let port = free_port(st.port);
    st.port = Some(port);
    save_state(&inst, &st)?;
    fs::create_dir_all(&data).ctx(|| format!("Could not create {}", data.display()))?;
    let log = fs::File::create(inst.dashboard().join("server.log"))
        .ctx(|| "Could not create the server log".into())?;
    let log2 = log.try_clone().ctx(|| "Could not create the server log".into())?;
    let mut cmd = tokio::process::Command::new(&exe);
    if let Some(ini) = ini_path(app) {
        cmd.arg("-c").arg(ini);
    }
    cmd.args(["-d", "display_errors=0", "-d", "opcache.enable_cli=0", "-S"])
        .arg(format!("127.0.0.1:{port}"))
        .arg("-t")
        .arg(&web)
        .arg(&router)
        .current_dir(&web)
        .env("ZDBF_DASHBOARD_DATA", &data)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log2))
        .kill_on_drop(true);
    if cfg!(windows) {
        cmd.env("ZDBF_DASHBOARD_HOLD", "0");
    } else {
        cmd.env("PHP_CLI_SERVER_WORKERS", "8")
            .env("ZDBF_DASHBOARD_HOLD", "5");
    }
    python::hide_window(&mut cmd);
    let child = cmd
        .spawn()
        .map_err(|e| format!("The local web server could not start: {e}"))?;
    app.dashboards
        .servers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.to_string(), Server { child, by_bot });
    for _ in 0..30 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if !app.dashboards.is_running(id) {
        let log = fs::read_to_string(inst.dashboard().join("server.log")).unwrap_or_default();
        let last = log
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .to_string();
        return Err(format!("The local web server stopped right away. {last}"));
    }
    app.bots.launcher_line(
        app,
        id,
        "INFO",
        &format!("The local dashboard runs at http://127.0.0.1:{port}"),
    );
    crate::bots::emit_status(app, id);
    Ok(())
}

fn state_of(app: &App, id: &str) -> Res<DashboardState> {
    let rec = app.store.instance(id)?;
    let inst = Inst::new(&rec.path);
    let (web, data, _, _) = dirs_of(&inst);
    let st = load_state(&inst);
    let running = app.dashboards.is_running(id);
    let done = setup_done(&data);
    let exe = php_exe(app);
    Ok(DashboardState {
        enabled: module_enabled(&rec.path),
        php_ready: exe.as_ref().map(|e| e.is_file()).unwrap_or(false),
        php_version: php_build().map(|b| b.version.to_string()),
        prepared: web.join("index.php").is_file(),
        running,
        port: st.port,
        url: st.port.map(|p| format!("http://127.0.0.1:{p}")),
        setup_key: if done { None } else { st.setup_key.clone() },
        setup_done: done,
        paired: paired(&rec.path),
        needs_runtime: false,
        supported: php_build().is_some(),
    })
}

#[tauri::command]
pub fn dashboard_state(app: State<'_, Arc<App>>, id: String) -> Res<DashboardState> {
    state_of(&app, &id)
}

#[tauri::command]
pub async fn dashboard_setup(app: State<'_, Arc<App>>, id: String) -> Res<DashboardState> {
    let app = app.inner().clone();
    let rec = app.store.instance(&id)?;
    if !instances::is_installed(&rec.path) {
        return Err("Install ZDBF for this bot first.".into());
    }
    {
        let mut running = app.tasks.lock().unwrap_or_else(|e| e.into_inner());
        if !running.insert(id.clone()) {
            return Err("The launcher is already working on this bot.".into());
        }
    }
    let rep = Reporter {
        app: app.clone(),
        id: id.clone(),
        task: "dashboard",
    };
    let result: Res<()> = async {
        let inst = Inst::new(&rec.path);
        if !module_enabled(&rec.path) {
            rep.step("module", "Turning on the dashboard module");
            let mut ch = Map::new();
            ch.insert("modules.dashboard".into(), Json::Bool(true));
            let res = config::save_changes(&app, &rec.path, &ch).await?;
            if !res.ok {
                return Err(res.errors.join(" "));
            }
            if !module_enabled(&rec.path) {
                return Err("The dashboard module was turned off in Discord. Turn it on with /fw modules module:dashboard enabled:true, or remove that change under Settings.".into());
            }
        }
        ensure_php(&app, &rep).await?;
        rep.step("web", "Preparing the dashboard files");
        let (web, data, router, _) = dirs_of(&inst);
        let (i2, w2, r2) = (Inst::new(&rec.path), web.clone(), router.clone());
        tokio::task::spawn_blocking(move || copy_web(&i2, &w2, &r2)).await.map_err(|e| e.to_string())??;
        fs::create_dir_all(&data).ctx(|| format!("Could not create {}", data.display()))?;
        let mut st = load_state(&inst);
        st.prepared_version = instances::read_meta(&rec.path).version;
        if !setup_done(&data) {
            let key = st.setup_key.clone().unwrap_or_else(new_setup_key);
            fsx::atomic_write(&data.join("setup-key.php"), key_file_contents(&key).as_bytes())?;
            st.setup_key = Some(key);
        }
        save_state(&inst, &st)?;
        rep.step("server", "Starting the local web server");
        app.dashboards.stop(&id);
        start_inner(&app, &id, app.bots.is_live(&id)).await?;
        Ok(())
    }
    .await;
    app.tasks.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    match &result {
        Ok(()) => rep.done("The dashboard is ready"),
        Err(e) => rep.fail(e),
    }
    result?;
    state_of(&app, &id)
}

#[tauri::command]
pub async fn dashboard_start(app: State<'_, Arc<App>>, id: String) -> Res<DashboardState> {
    let app = app.inner().clone();
    start_inner(&app, &id, false).await?;
    state_of(&app, &id)
}

#[tauri::command]
pub fn dashboard_stop(app: State<'_, Arc<App>>, id: String) -> Res<DashboardState> {
    app.dashboards.stop(&id);
    let app2 = app.inner().clone();
    crate::bots::emit_status(&app2, &id);
    state_of(&app, &id)
}

#[tauri::command]
pub async fn dashboard_disable(app: State<'_, Arc<App>>, id: String) -> Res<DashboardState> {
    let app = app.inner().clone();
    let rec = app.store.instance(&id)?;
    app.dashboards.stop(&id);
    let mut ch = Map::new();
    ch.insert("modules.dashboard".into(), Json::Bool(false));
    let res = config::save_changes(&app, &rec.path, &ch).await?;
    if !res.ok {
        return Err(res.errors.join(" "));
    }
    crate::bots::emit_status(&app, &id);
    state_of(&app, &id)
}

#[tauri::command]
pub fn dashboard_open(app: State<'_, Arc<App>>, id: String, page: String) -> Res<()> {
    let st = state_of(&app, &id)?;
    if !st.running {
        return Err("The local web server is not running. Start it first.".into());
    }
    let base = st.url.ctx(|| "No address yet.".into())?;
    let url = if page == "setup" {
        format!("{base}/setup.php")
    } else {
        format!("{base}/")
    };
    app.handle
        .opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("The browser could not be opened: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_key_format() {
        let k = new_setup_key();
        assert_eq!(k.len(), 19);
        assert!(
            k.split('-')
                .all(|g| g.len() == 4 && g.bytes().all(|b| KEY_ALPHABET.contains(&b)))
        );
        assert!(key_file_contents(&k).contains(&format!("return '{k}';")));
    }
}
