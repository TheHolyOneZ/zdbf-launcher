mod app;
mod bots;
mod cfgread;
mod config;
mod dashboard;
mod docs;
mod error;
mod extensions;
mod fsx;
mod install;
mod instances;
mod logs;
mod paths;
mod procs;
mod python;
mod release;
mod store;
mod sys;
mod token;
mod tray;
mod updater;

use std::sync::Arc;

use tauri::{Emitter, Manager, RunEvent, WindowEvent};

use crate::app::{App, QUIT_EXIT, QUIT_RESTART};

const BACKGROUND_ARG: &str = "--background";

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|handle, _args, _cwd| {
            tray::show_main(handle);
        }))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::DECORATIONS
                        - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![BACKGROUND_ARG]),
        ))
        .setup(|tauri_app| {
            let handle = tauri_app.handle().clone();
            let data_dir = handle.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let app = Arc::new(App::new(handle.clone(), data_dir));
            handle.manage(app.clone());
            bots::adopt_orphans(&app);
            tray::install(&app)?;

            let background = std::env::args().any(|a| a == BACKGROUND_ARG);
            if let Some(w) = handle.get_webview_window("main")
                && !background
            {
                let _ = w.show();
            }

            let starter = app.clone();
            tauri::async_runtime::spawn(async move {
                for rec in starter.store.instances() {
                    if rec.start_with_launcher && rec.setup_done && !starter.bots.is_live(&rec.id) {
                        let _ = bots::start(&starter, &rec.id).await;
                    }
                }
                let _ = release::check(&starter, false).await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let Some(app) = window.app_handle().try_state::<Arc<App>>() else {
                    return;
                };
                if app.quitting() || !app.bots.any_live() {
                    return;
                }
                api.prevent_close();
                if app.store.prefs().close_to_tray {
                    let _ = window.hide();
                } else {
                    let _ = window.emit("close-requested", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            sys::app_info,
            sys::get_prefs,
            sys::set_prefs,
            sys::open_in_system,
            sys::open_extension,
            sys::open_url,
            sys::quit_app,
            instances::list_instances,
            instances::suggest_path,
            instances::create_instance,
            instances::import_instance,
            instances::remove_instance,
            instances::rename_instance,
            instances::set_instance_options,
            instances::finish_setup,
            instances::token_state,
            instances::inspect_token,
            instances::set_token,
            install::install_instance,
            install::repair_instance,
            bots::start_bot,
            bots::stop_bot,
            bots::restart_bot,
            bots::bot_status,
            bots::console_snapshot,
            bots::clear_console,
            release::release_check,
            config::read_config,
            config::save_config,
            config::remove_override,
            extensions::list_extensions,
            extensions::set_extension_enabled,
            updater::update_plan,
            updater::update_bot,
            updater::list_backups,
            updater::restore_backup,
            docs::docs_bundle,
            docs::doc_asset,
            dashboard::dashboard_state,
            dashboard::dashboard_setup,
            dashboard::dashboard_start,
            dashboard::dashboard_stop,
            dashboard::dashboard_disable,
            dashboard::dashboard_open,
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("the launcher could not start");
    app.run(|handle, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } = event
        {
            tray::show_main(handle);
            return;
        }
        if let RunEvent::ExitRequested { api, code, .. } = event {
            let Some(app) = handle.try_state::<Arc<App>>() else {
                return;
            };
            let app = app.inner().clone();
            if app.bots.any_live() {
                api.prevent_exit();
                app.set_quit(if code == Some(tauri::RESTART_EXIT_CODE) {
                    QUIT_RESTART
                } else {
                    QUIT_EXIT
                });
                sys::begin_quit(&app);
            } else {
                app.dashboards.stop_everything();
            }
        }
    });
}
