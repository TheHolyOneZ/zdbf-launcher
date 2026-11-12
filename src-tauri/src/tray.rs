use std::sync::Arc;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, Wry};
use tauri_plugin_notification::NotificationExt;

use crate::app::App;
use crate::bots::ExitInfo;
use crate::instances;

const TRAY_ID: &str = "main";

pub fn show_main(handle: &tauri::AppHandle) {
    if let Some(w) = handle.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn build_menu(app: &Arc<App>) -> tauri::Result<Menu<Wry>> {
    let h = &app.handle;
    let menu = Menu::new(h)?;
    menu.append(&MenuItem::with_id(
        h,
        "open",
        "Open ZDBF Launcher",
        true,
        None::<&str>,
    )?)?;
    let list = instances::all(app);
    if !list.is_empty() {
        menu.append(&PredefinedMenuItem::separator(h)?)?;
    }
    for i in &list {
        let (id, label, enabled) = match i.state.as_str() {
            "running" | "starting" => (format!("stop:{}", i.id), format!("Stop {}", i.name), true),
            "waiting" => (
                format!("stop:{}", i.id),
                format!("Cancel restart of {}", i.name),
                true,
            ),
            "stopped" | "crashed" => (format!("start:{}", i.id), format!("Start {}", i.name), true),
            "stopping" => (format!("noop:{}", i.id), format!("{} is stopping", i.name), false),
            _ => (
                format!("noop:{}", i.id),
                format!("{} is not ready", i.name),
                false,
            ),
        };
        menu.append(&MenuItem::with_id(h, id, label, enabled, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(h)?)?;
    menu.append(&MenuItem::with_id(
        h,
        "quit",
        "Quit (stops all bots)",
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

fn tooltip(app: &Arc<App>) -> String {
    let running = app.bots.live_ids().len();
    match running {
        0 => "ZDBF Launcher".into(),
        1 => "ZDBF Launcher: 1 bot running".into(),
        n => format!("ZDBF Launcher: {n} bots running"),
    }
}

pub fn install(app: &Arc<App>) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    let icon = app.handle.default_window_icon().cloned();
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip(tooltip(app))
        .show_menu_on_left_click(false);
    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }
    let app_for_menu = app.clone();
    builder
        .on_menu_event(move |handle, event| {
            let id = event.id().as_ref().to_string();
            let app = app_for_menu.clone();
            if id == "open" {
                show_main(handle);
            } else if id == "quit" {
                crate::sys::quit(&app);
            } else if let Some(bot) = id.strip_prefix("start:") {
                let bot = bot.to_string();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::bots::start(&app, &bot).await;
                });
            } else if let Some(bot) = id.strip_prefix("stop:") {
                let bot = bot.to_string();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::bots::stop(&app, &bot).await;
                });
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(&app.handle)?;
    Ok(())
}

pub fn refresh(app: &Arc<App>) {
    let Some(tray) = app.handle.tray_by_id(TRAY_ID) else {
        return;
    };
    if let Ok(menu) = build_menu(app) {
        let _ = tray.set_menu(Some(menu));
    }
    let _ = tray.set_tooltip(Some(tooltip(app)));
}

pub fn notify_crash(app: &Arc<App>, id: &str, exit: &ExitInfo) {
    let focused = app
        .handle
        .get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
        .unwrap_or(false);
    if focused {
        return;
    }
    let name = app
        .store
        .instance(id)
        .map(|r| r.name)
        .unwrap_or_else(|_| "Your bot".into());
    let body = match exit.reason.as_str() {
        "token_invalid" => "Discord did not accept the bot token.",
        "token_missing" => "No bot token is set.",
        "intents" => "Discord refused the privileged intents.",
        "config" => "config.toml has a mistake.",
        "python" => "The Python environment is not working.",
        _ => "It stopped with an error. Open the launcher for details.",
    };
    let _ = app
        .handle
        .notification()
        .builder()
        .title(format!("{name} stopped"))
        .body(body)
        .show();
}
