//! Desktop shell: windows, native web views for web accounts, tray, notifications,
//! and the bridge from the React interface to mail-core.

mod commands;
mod events;
mod state;
mod tray;
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

            create_main_window(app)?;
            tray::create(&handle)?;
            if !demo {
                // New mail within ~10 seconds; folders, other mail folders and calendars every 2 minutes.
                let (inbox_every, full_every) = (std::time::Duration::from_secs(10), std::time::Duration::from_secs(120));
                tauri::async_runtime::spawn(mail_core::sync::run_loop(svc.clone(), clients, wake, inbox_every, full_every));
            }
            tauri::async_runtime::spawn(events::reminder_loop(handle.clone()));
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
            commands::create_draft,
            commands::get_draft,
            commands::update_draft,
            commands::change_draft_account,
            commands::add_attachment,
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
            commands::mcp_info,
            commands::pop_out,
            commands::dock_back,
            commands::open_external,
            webaccounts::show_web_account,
            webaccounts::hide_web_accounts,
            webaccounts::reload_web_account,
            webaccounts::web_account_report,
            webaccounts::web_account_notify,
        ])
        .run(context())
        .expect("error while running the mail app");
}
