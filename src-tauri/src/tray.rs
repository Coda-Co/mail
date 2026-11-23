//! Tray (Windows) / menu-bar (macOS) icon with the total unread count.

use crate::state::AppState;
use crate::MAIN;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

const TRAY_ID: &str = "mail-tray";

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Mail", true, None::<&str>)?;
    let sync = MenuItem::with_id(app, "sync", "Sync now", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &sync, &quit])?;
    let mut b = TrayIconBuilder::with_id(TRAY_ID).tooltip("Mail").menu(&menu).show_menu_on_left_click(false).on_menu_event(|app, e| match e.id.as_ref() {
        "show" => show_main(app),
        "sync" => {
            if let Some(s) = app.try_state::<AppState>() {
                s.wake.notify_one();
            }
        }
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
        let tip = if total > 0 { format!("Mail · {total} unread") } else { "Mail".to_string() };
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
