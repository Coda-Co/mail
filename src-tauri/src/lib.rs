//! Desktop shell: windows, native web views for web accounts, tray, notifications,
//! and the bridge from the React interface to mail-core.

mod commands;
mod clipboard;
mod events;
mod state;
mod tray;
mod updater;
mod webaccounts;

use mail_core::MailService;
use state::AppState;
use std::sync::Arc;
use tauri::{LogicalPosition, Manager, WebviewBuilder, WebviewUrl};

pub const MAIN: &str = "main";

/// Debug builds (`pnpm tauri dev`) run as a separate app, "Mail Dev": their own identifier,
/// so their own data folder, credential-store entries, web-view storage and single-instance
/// lock. They can run beside the installed app without touching its mail or sign-ins.
pub const IS_DEV: bool = cfg!(debug_assertions);

pub fn app_name() -> &'static str {
    if IS_DEV {
        "Mail Dev"
    } else {
        "Mail"
    }
}

fn context() -> tauri::Context<tauri::Wry> {
    let mut ctx = tauri::generate_context!();
    if IS_DEV {
        let cfg = ctx.config_mut();
        cfg.identifier = format!("{}.dev", cfg.identifier);
        cfg.product_name = Some(app_name().to_string());
    }
    ctx
}

/// The main window holds the interface as a child web view, so web-account views can sit
/// beside it as siblings (one window, several web views) on every platform.
fn create_main_window(app: &tauri::App) -> tauri::Result<()> {
    let win = tauri::window::WindowBuilder::new(app, MAIN).title(app_name()).inner_size(1440.0, 900.0).min_inner_size(720.0, 520.0).center().build()?;
    let size = win.inner_size()?.to_logical::<f64>(win.scale_factor()?);
    win.add_child(
        WebviewBuilder::new(MAIN, WebviewUrl::App("index.html".into())).auto_resize().disable_drag_drop_handler(),
        LogicalPosition::new(0.0, 0.0),
        size,
    )?;
    Ok(())
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch focuses the running app (one process owns the databases).
            if let Some(w) = app.get_window(MAIN) {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(feature = "updater")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .setup(|app| {
            let handle = app.handle().clone();
            let demo = std::env::var("MAIL_APP_DEMO").map(|v| v == "1").unwrap_or(false);
            let svc = if demo {
                let s = MailService::in_memory()?;
                mail_core::demo::seed(&s)?;
                s
            } else {
                let dir = app.path().app_data_dir()?;
                MailService::open(&dir)?
            };
            let svc = Arc::new(svc);
            svc.set_events(Arc::new(events::TauriEvents::new(handle.clone())));
            let state = AppState::new(svc.clone(), demo, &app.config().identifier);
            let wake = state.wake.clone();
            let clients = state.client_factory();
            app.manage(state);
            app.manage(webaccounts::WebCalendars::default());

            app.manage(updater::Updates::new(app));
            create_main_window(app)?;
            tray::create(&handle)?;
            if !demo {
                // New mail within ~10 seconds; folders, other mail folders and calendars every 2 minutes.
                let (inbox_every, full_every) = (std::time::Duration::from_secs(10), std::time::Duration::from_secs(120));
                tauri::async_runtime::spawn(mail_core::sync::run_loop(svc.clone(), clients, wake, inbox_every, full_every));
            }
            tauri::async_runtime::spawn(events::reminder_loop(handle.clone()));
            tauri::async_runtime::spawn(webaccounts::calendar_loop(handle.clone()));
            tauri::async_runtime::spawn(updater::check_loop(handle.clone()));
            // Web accounts stay loaded in the background so counts and notifications stay live.
            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                webaccounts::preload_all(&h);
            });
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Sync on focus.
            tauri::WindowEvent::Focused(true) if window.label() == MAIN => {
                if let Some(s) = window.try_state::<AppState>() {
                    s.wake.notify_one();
                }
            }
            // Closing a pop-out compose window docks the draft back.
            tauri::WindowEvent::Destroyed => commands::on_window_closed(window.app_handle(), window.label()),
            // Closing the main window keeps the app in the tray so mail keeps syncing.
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == MAIN && cfg!(not(target_os = "linux")) => {
                api.prevent_close();
                let _ = window.hide();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::me,
            commands::list_accounts,
            commands::add_account,
            commands::add_web_account,
            commands::upgrade_web_account,
            commands::update_account,
            commands::remove_account,
            commands::list_folders,
            commands::list_messages,
            commands::get_thread,
            commands::get_message,
            commands::mark_read,
            commands::set_flag,
            commands::archive,
            commands::delete_messages,
            commands::move_messages,
            commands::allow_remote_images,
            commands::show_remote_images_once,
            commands::open_attachment,
            commands::copy_attachments,
            commands::create_draft,
            commands::get_draft,
            commands::update_draft,
            commands::change_draft_account,
            commands::set_draft_signature,
            commands::add_attachment,
            commands::add_attachment_data,
            commands::remove_attachment,
            commands::discard_draft,
            commands::send_draft,
            commands::search,
            commands::search_server,
            commands::list_people,
            commands::get_person,
            commands::list_calendars,
            commands::set_calendar_visible,
            commands::list_events,
            commands::search_events,
            commands::agenda,
            commands::create_event,
            commands::update_event,
            commands::respond_event,
            commands::delete_event,
            commands::list_signatures,
            commands::save_signature,
            commands::delete_signature,
            commands::get_settings,
            commands::update_settings,
            commands::sync_now,
            commands::sync_status,
            commands::disk_encryption,
            commands::pop_out,
            commands::dock_back,
            commands::open_external,
            webaccounts::show_web_account,
            webaccounts::hide_web_accounts,
            webaccounts::reload_web_account,
            webaccounts::web_account_report,
            webaccounts::web_account_notify,
            webaccounts::web_account_calendar_report,
            webaccounts::web_account_event_attendees_report,
            webaccounts::fetch_web_event_attendees,
            webaccounts::open_web_event,
            webaccounts::refresh_web_calendars,
            updater::update_status,
            updater::check_for_update,
            updater::install_update,
        ])
        .build(context())
        .expect("error while building the mail app")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                // Quit cleanly so the next launch keeps its Outlook sign-in:
                // 1. First pass — hold the exit, make each web account's sign-in cookies
                //    persistent on a worker (reading them blocks on the main loop, which stays
                //    free because we haven't exited), then ask to exit again.
                // 2. Second pass (PERSISTED set) — close the web-account views, which lets their
                //    WebView2 browser processes flush cookies and release the profile locks, then
                //    fall through to a real exit.
                if PERSISTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    webaccounts::close_all(app);
                } else {
                    api.prevent_exit();
                    let h = app.clone();
                    webaccounts::persist_all_then(app.clone(), move || {
                        // A downloaded update installs now, so the next launch is the new version.
                        updater::install_on_quit(&h);
                        h.exit(0);
                    });
                }
            }
        });
}

/// Set once the quit handler has persisted the sign-in cookies, so the re-triggered exit runs for
/// real instead of persisting again (see the ExitRequested handler).
pub(crate) static PERSISTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(test)]
mod tests {
    /// The names between `start` and `end`: `"name"` in build.rs and app.toml, `call('name'`
    /// in the interface.
    fn names(src: &str, start: &str, end: char) -> Vec<String> {
        src.split(start).skip(1).filter_map(|s| s.split(end).next()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
    }

    /// A command the interface calls must be registered, listed in build.rs and allowed in
    /// app.toml, or Tauri refuses it at run time.
    #[test]
    fn every_command_is_allowed() {
        let lib = include_str!("lib.rs");
        let handlers = &lib[lib.find("generate_handler![").unwrap()..];
        let handlers: Vec<String> = handlers["generate_handler![".len()..handlers.find(']').unwrap()]
            .split(',')
            .filter_map(|h| h.trim().rsplit("::").next())
            .filter(|h| !h.is_empty())
            .map(String::from)
            .collect();
        let build = include_str!("../build.rs");
        let listed = names(&build[build.find("COMMANDS").unwrap()..build.find("];").unwrap()], "\"", '"');
        let toml = include_str!("../permissions/app.toml");
        let allowed = names(toml, "\"allow-", '"');
        let called = names(include_str!("../../src/api/tauri.ts"), "call('", '\'');
        assert!(handlers.len() > 40, "parsed {} handlers", handlers.len());
        for c in &called {
            assert!(handlers.contains(c), "the interface calls `{c}`, which isn't in generate_handler!");
        }
        for h in &handlers {
            assert!(listed.contains(h), "`{h}` is missing from COMMANDS in build.rs");
            assert!(allowed.contains(&h.replace('_', "-")), "`allow-{}` is missing from permissions/app.toml", h.replace('_', "-"));
        }
    }
}
