use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::app::App;
use crate::error::Res;
use crate::paths::Inst;

pub const PYTHON_VERSION: &str = "3.13";

pub fn uv_path() -> PathBuf {
    let name = if cfg!(windows) { "zdbf-uv.exe" } else { "zdbf-uv" };
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));
    if let Some(dir) = &exe_dir {
        let p = dir.join(name);
        if p.is_file() {
            return p;
        }
        #[cfg(target_os = "macos")]
        {
            let p = dir.join("../Resources").join(name);
            if p.is_file() {
                return p;
            }
        }
    }
    if let Ok(p) = std::env::var("ZDBF_LAUNCHER_UV") {
        return PathBuf::from(p);
    }
    exe_dir.unwrap_or_default().join(name)
}

pub fn uv_dir(app: &App) -> PathBuf {
    app.data_dir.join("uv")
}

fn uv_shim(app: &App) -> Option<PathBuf> {
    let dir = uv_dir(app).join("bin");
    let link = dir.join(if cfg!(windows) { "uv.exe" } else { "uv" });
    let source = uv_path();
    let fresh = match (std::fs::metadata(&link), std::fs::metadata(&source)) {
        (Ok(a), Ok(b)) => a.len() == b.len(),
        _ => false,
    };
    if fresh {
        return Some(dir);
    }
    std::fs::create_dir_all(&dir).ok()?;
    let _ = std::fs::remove_file(&link);
    if std::fs::hard_link(&source, &link).is_ok() {
        return Some(dir);
    }
    #[cfg(unix)]
    if std::os::unix::fs::symlink(&source, &link).is_ok() {
        return Some(dir);
    }
    None
}

const LEAKY_VARS: &[&str] = &[
    "PYTHONHOME",
    "PYTHONPATH",
    "PYTHONDONTWRITEBYTECODE",
    "PYTHONSTARTUP",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "PERLLIB",
    "GDK_PIXBUF_MODULE_FILE",
    "GIO_MODULE_DIR",
    "GTK_DATA_PREFIX",
    "GTK_EXE_PREFIX",
    "GTK_IM_MODULE_FILE",
    "GTK_PATH",
    "GTK_THEME",
    "QT_PLUGIN_PATH",
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "OWD",
    "VIRTUAL_ENV",
    "CONDA_PREFIX",
];

fn bundle_dir() -> Option<PathBuf> {
    std::env::var_os("APPDIR").map(PathBuf::from)
}

fn system_path() -> Vec<PathBuf> {
    let bundle = bundle_dir();
    std::env::var_os("PATH")
        .map(|p| {
            std::env::split_paths(&p)
                .filter(|d| bundle.as_ref().map(|b| !d.starts_with(b)).unwrap_or(true))
                .collect()
        })
        .unwrap_or_default()
}

pub fn hide_window(cmd: &mut Command) {
    for v in LEAKY_VARS {
        cmd.env_remove(v);
    }
    if bundle_dir().is_some() {
        cmd.env("PATH", std::env::join_paths(system_path()).unwrap_or_default());
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
}

fn path_with(first: &[PathBuf]) -> OsString {
    let mut parts: Vec<PathBuf> = first.to_vec();
    parts.extend(system_path());
    std::env::join_paths(parts).unwrap_or_default()
}

pub fn uv_command(app: &App) -> Command {
    let mut cmd = Command::new(uv_path());
    let base = uv_dir(app);
    cmd.env("UV_PYTHON_INSTALL_DIR", base.join("python"))
        .env("UV_CACHE_DIR", base.join("cache"))
        .env("UV_PYTHON_PREFERENCE", "only-managed")
        .env("UV_NO_CONFIG", "1")
        .env("UV_NO_PROGRESS", "1")
        .env("NO_COLOR", "1")
        .env_remove("VIRTUAL_ENV")
        .env_remove("UV_SYSTEM_PYTHON")
        .env_remove("PYTHONHOME")
        .env_remove("PYTHONPATH")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_window(&mut cmd);
    cmd
}

pub fn bot_env(app: &App, inst: &Inst, cmd: &mut Command) {
    hide_window(cmd);
    let venv_bin = if cfg!(windows) {
        inst.venv().join("Scripts")
    } else {
        inst.venv().join("bin")
    };
    let mut first = vec![venv_bin];
    first.extend(uv_shim(app));
    let base = uv_dir(app);
    cmd.env("PATH", path_with(&first))
        .env("VIRTUAL_ENV", inst.venv())
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .env("COLUMNS", "200")
        .env("UV_PYTHON_INSTALL_DIR", base.join("python"))
        .env("UV_CACHE_DIR", base.join("cache"))
        .env("UV_PYTHON_PREFERENCE", "only-managed")
        .env("ZDBF_LAUNCHER", "1")
        .env_remove("PYTHONHOME")
        .env_remove("PYTHONPATH")
        .env_remove("ZDBF_CONFIG");
}

pub async fn run_streaming(
    mut cmd: Command,
    on_line: impl Fn(&str) + Send + Sync + 'static,
) -> Res<Vec<String>> {
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start {}: {e}", describe(&cmd)))?;
    let on_line = Arc::new(on_line);
    let tail = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let mut tasks = Vec::new();
    for stream in [
        child.stdout.take().map(Either::A),
        child.stderr.take().map(Either::B),
    ]
    .into_iter()
    .flatten()
    {
        let (on_line, tail) = (on_line.clone(), tail.clone());
        tasks.push(tokio::spawn(async move {
            let reader: Box<dyn tokio::io::AsyncRead + Unpin + Send> = match stream {
                Either::A(s) => Box::new(s),
                Either::B(s) => Box::new(s),
            };
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let clean = line.trim().to_string();
                if clean.is_empty() {
                    continue;
                }
                on_line(&clean);
                let mut t = tail.lock().unwrap_or_else(|e| e.into_inner());
                if t.len() > 60 {
                    t.remove(0);
                }
                t.push(clean);
            }
        }));
    }
    let status = child
        .wait()
        .await
        .map_err(|e| format!("{} did not finish: {e}", describe(&cmd)))?;
    for t in tasks {
        let _ = t.await;
    }
    let lines = tail.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if status.success() {
        Ok(lines)
    } else {
        let last: Vec<String> = lines.iter().rev().take(6).rev().cloned().collect();
        Err(format!(
            "{} failed (exit code {}).\n{}",
            describe(&cmd),
            status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "unknown".into()),
            last.join("\n")
        ))
    }
}

enum Either<A, B> {
    A(A),
    B(B),
}

fn describe(cmd: &Command) -> String {
    let std = cmd.as_std();
    let prog = Path::new(std.get_program())
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let args: Vec<String> = std
        .get_args()
        .take(3)
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    format!("{prog} {}", args.join(" ")).trim().to_string()
}

pub async fn python_version(python: &Path) -> Option<String> {
    let mut cmd = Command::new(python);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut cmd);
    let out = cmd.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    text.split_whitespace().nth(1).map(str::to_string)
}

pub fn supported(version: &str) -> bool {
    let mut p = version.split('.');
    matches!(
        (p.next(), p.next().and_then(|m| m.parse::<u32>().ok())),
        (Some("3"), Some(12..=14))
    )
}
