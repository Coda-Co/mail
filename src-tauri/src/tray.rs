//! Tray (Windows) / menu-bar (macOS) icon with the total unread count.

use crate::state::AppState;
use crate::MAIN;
use crate::updater::{UpdateState, UpdateStatus, Updates};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

const TRAY_ID: &str = "mail-tray";

/// The tray's update item, kept so its label can follow the update status.
struct UpdateItem(MenuItem<tauri::Wry>);

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Mail", true, None::<&str>)?;
    let sync = MenuItem::with_id(app, "sync", "Sync now", true, None::<&str>)?;
    let updates_on = app.try_state::<Updates>().is_some_and(|u| u.status().state != UpdateState::Unavailable);
    let update = MenuItem::with_id(app, "update", "Check for updates…", updates_on, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &sync, &PredefinedMenuItem::separator(app)?, &update, &PredefinedMenuItem::separator(app)?, &quit])?;
    app.manage(UpdateItem(update));
    let mut b = TrayIconBuilder::with_id(TRAY_ID).tooltip(crate::app_name()).menu(&menu).show_menu_on_left_click(false).on_menu_event(|app, e| match e.id.as_ref() {
        "show" => show_main(app),
        "sync" => {
            if let Some(s) = app.try_state::<AppState>() {
                s.wake.notify_one();
            }
        }
        "update" => on_update_clicked(app),
        "quit" => app.exit(0),
        _ => {}
    });
    b = b.on_tray_icon_event(|tray, event| {
        if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = event {
            show_main(tray.app_handle());
        }
    });
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.build(app)?;
    Ok(())
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_window(MAIN) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn set_unread(app: &AppHandle, total: i64) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let tip = if total > 0 { format!("{} · {total} unread", crate::app_name()) } else { crate::app_name().to_string() };
        let _ = tray.set_tooltip(Some(&tip));
        #[cfg(target_os = "macos")]
        let _ = tray.set_title(if total > 0 { Some(total.to_string()) } else { None });
    }
    if let Some(w) = app.get_window(MAIN) {
        // Dock badge on macOS, launcher badge on Linux. Windows shows the count in the tray tooltip.
        #[cfg(not(target_os = "windows"))]
        let _ = w.set_badge_count(if total > 0 { Some(total) } else { None });
        let _ = &w;
    }
}

/// "Check for updates…" checks and says what it found; once an update is downloaded the same
/// item reads "Restart to update" and installs it.
fn on_update_clicked(app: &AppHandle) {
    let Some(u) = app.try_state::<Updates>() else { return };
    if u.is_ready() {
        crate::updater::install_and_restart(app);
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let s = crate::updater::check(&app, true).await;
        let name = crate::app_name();
        let (title, body) = match s.state {
            UpdateState::Ready => (format!("{name} {} is ready", s.version.unwrap_or_default()), format!("{} Choose it in this menu.", crate::updater::RESTART_HINT)),
            UpdateState::UpToDate => (format!("{name} is up to date"), format!("You have the latest version, {}.", s.current_version)),
            UpdateState::Error => ("Couldn't check for updates".to_string(), s.error.unwrap_or_default()),
            _ => return,
        };
        // The user asked, so answer even if mail notifications are off.
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title(title).body(body).show();
    });
}

/// Keep the tray's update item in step with the update status.
pub fn set_update(app: &AppHandle, s: &UpdateStatus) {
    let Some(item) = app.try_state::<UpdateItem>() else { return };
    let (text, enabled) = match s.state {
        UpdateState::Unavailable => ("Check for updates…".to_string(), false),
        UpdateState::Checking => ("Checking for updates…".to_string(), false),
        UpdateState::Downloading => (format!("Downloading {}…", s.version.as_deref().unwrap_or("update")), false),
        UpdateState::Ready => (format!("Restart to update to {}", s.version.as_deref().unwrap_or("the new version")), true),
        UpdateState::Installing => ("Installing update…".to_string(), false),
        UpdateState::Idle | UpdateState::UpToDate | UpdateState::Error => ("Check for updates…".to_string(), true),
    };
    let _ = item.0.set_text(text);
    let _ = item.0.set_enabled(enabled);
}
