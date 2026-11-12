use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

use crate::app::{App, QUIT_EXIT};
use crate::error::Res;
use crate::paths::{self, Inst};
use crate::store::Prefs;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    os: String,
    arch: String,
    data_dir: String,
    default_install_root: String,
}

#[tauri::command]
pub fn app_info(app: State<'_, Arc<App>>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        data_dir: app.data_dir.display().to_string(),
        default_install_root: paths::default_install_root().display().to_string(),
    }
}

#[tauri::command]
pub fn get_prefs(app: State<'_, Arc<App>>) -> Prefs {
    let mut p = app.store.prefs();
    if let Ok(enabled) = app.handle.autolaunch().is_enabled() {
        p.launch_at_login = enabled;
    }
    p
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefsPatch {
    theme: Option<String>,
    close_to_tray: Option<bool>,
    launch_at_login: Option<bool>,
    check_launcher_updates: Option<bool>,
    last_instance: Option<String>,
}

#[tauri::command]
pub fn set_prefs(app: State<'_, Arc<App>>, prefs: PrefsPatch) -> Res<Prefs> {
    if let Some(v) = prefs.launch_at_login {
        let al = app.handle.autolaunch();
        let r = if v { al.enable() } else { al.disable() };
        r.map_err(|e| format!("Starting with your computer could not be changed: {e}"))?;
    }
    app.store.update(|f| {
        if let Some(t) = prefs.theme
            && matches!(t.as_str(), "system" | "dark" | "light")
        {
            f.prefs.theme = t;
        }
        if let Some(v) = prefs.close_to_tray {
            f.prefs.close_to_tray = v;
        }
        if let Some(v) = prefs.launch_at_login {
            f.prefs.launch_at_login = v;
        }
        if let Some(v) = prefs.check_launcher_updates {
            f.prefs.check_launcher_updates = v;
        }
        if let Some(v) = prefs.last_instance {
            f.prefs.last_instance = Some(v);
        }
        Ok(f.prefs.clone())
    })
}

fn open_or_reveal(app: &App, path: &Path) -> Res<()> {
    let opener = app.handle.opener();
    if path.is_dir() {
        return opener
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|e| format!("The folder could not be opened: {e}"));
    }
    if !path.exists() {
        return Err(format!(
            "{} does not exist yet. It is created when the bot starts.",
            path.display()
        ));
    }
    if opener.open_path(path.to_string_lossy(), None::<&str>).is_ok() {
        return Ok(());
    }
    opener
        .reveal_item_in_dir(path)
        .map_err(|e| format!("The file could not be opened: {e}"))
}

#[tauri::command]
pub fn open_in_system(app: State<'_, Arc<App>>, id: String, what: String) -> Res<()> {
    let rec = app.store.instance(&id)?;
    let inst = Inst::new(&rec.path);
    let target: PathBuf = match what.as_str() {
        "folder" => rec.path.clone(),
        "config" => inst.config(),
        "env" => inst.env_file(),
        "logs" => crate::cfgread::logs_dir(&rec.path),
        "extensions" => inst.extensions(),
        "data" => inst.data(),
        _ => return Err("Unknown place.".into()),
    };
    if what == "logs" || what == "extensions" || what == "data" {
        std::fs::create_dir_all(&target).ok();
    }
    open_or_reveal(&app, &target)
}

#[tauri::command]
pub fn open_extension(app: State<'_, Arc<App>>, id: String, file: String) -> Res<()> {
    let rec = app.store.instance(&id)?;
    let ext = Inst::new(&rec.path).extensions();
    let target = crate::fsx::from_slash(&ext, &file);
    if !target.starts_with(&ext) {
        return Err("That file is outside the extensions folder.".into());
    }
    open_or_reveal(&app, &target)
}

pub fn allowed_url(url: &str) -> bool {
    url.starts_with("https://")
        || url.starts_with("http://127.0.0.1:")
        || url.starts_with("http://localhost:")
}

#[tauri::command]
pub fn open_url(app: State<'_, Arc<App>>, url: String) -> Res<()> {
    if !allowed_url(&url) {
        return Err("Only https links can be opened.".into());
    }
    app.handle
        .opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("The browser could not be opened: {e}"))
}

pub fn quit(app: &Arc<App>) {
    app.set_quit(QUIT_EXIT);
    begin_quit(app);
}

pub fn begin_quit(app: &Arc<App>) {
    let live = app.bots.live_ids();
    if live.is_empty() {
        app.finish_quit();
        return;
    }
    for id in live {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = crate::bots::stop(&app, &id).await;
        });
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(40)).await;
        app.finish_quit();
    });
}

#[tauri::command]
pub fn quit_app(app: State<'_, Arc<App>>, stop_bots: bool) {
    let _ = stop_bots;
    quit(app.inner());
}
