//! App updates: check the release channel in the background, download a new version as soon
//! as it is published, and install it when the user restarts (or quits, on macOS).
//!
//! Only release builds with the `updater` feature can update (see docs/RELEASING.md). Other
//! builds still register the commands, so the interface works the same and reports updates as
//! unavailable.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub const STATUS_EVENT: &str = "update://status";

/// What to tell the user once an update has downloaded (see `install_on_quit`).
pub const RESTART_HINT: &str = if cfg!(target_os = "macos") { "Restart to update. It also installs the next time you quit." } else { "Restart to update." };

/// Check this long after launch, so startup and the first sync aren't competing with it.
#[cfg(feature = "updater")]
const FIRST_CHECK: std::time::Duration = std::time::Duration::from_secs(15);
/// Check again once the last check is this old.
#[cfg(feature = "updater")]
const CHECK_EVERY: chrono::TimeDelta = chrono::TimeDelta::hours(4);
/// How often the loop wakes to see whether a check is due. Short, so a laptop that slept
/// through the interval checks soon after it wakes.
#[cfg(feature = "updater")]
const TICK: std::time::Duration = std::time::Duration::from_secs(10 * 60);

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum UpdateState {
    /// This build can't update itself (development builds, or built without the `updater` feature).
    Unavailable,
    /// Not checked yet.
    Idle,
    Checking,
    Downloading,
    /// Downloaded and verified; installs on restart.
    Ready,
    UpToDate,
    Error,
    Installing,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub state: UpdateState,
    pub current_version: String,
    /// The new version, while downloading, ready or installing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Release notes for the new version.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// Download progress, 0 to 1, when the size is known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// When the release channel last answered (RFC 3339).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
}

pub struct Updates {
    status: Mutex<UpdateStatus>,
    /// One check at a time: a manual check while the background one runs waits for it.
    busy: tokio::sync::Mutex<()>,
    #[cfg(feature = "updater")]
    pending: Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>,
    /// The version the user was last told about, so each version notifies once.
    #[cfg(feature = "updater")]
    notified: Mutex<Option<String>>,
}

impl Updates {
    pub fn new(app: &tauri::App) -> Self {
        let state = if cfg!(feature = "updater") && !crate::IS_DEV { UpdateState::Idle } else { UpdateState::Unavailable };
        Updates {
            status: Mutex::new(UpdateStatus {
                state,
                current_version: app.package_info().version.to_string(),
                version: None,
                notes: None,
                progress: None,
                error: None,
                checked_at: None,
            }),
            busy: tokio::sync::Mutex::new(()),
            #[cfg(feature = "updater")]
            pending: Mutex::new(None),
            #[cfg(feature = "updater")]
            notified: Mutex::new(None),
        }
    }

    pub fn status(&self) -> UpdateStatus {
        self.status.lock().unwrap().clone()
    }

    pub fn is_ready(&self) -> bool {
        self.status.lock().unwrap().state == UpdateState::Ready
    }

    #[cfg(feature = "updater")]
    fn set(&self, app: &AppHandle, f: impl FnOnce(&mut UpdateStatus)) {
        let status = {
            let mut s = self.status.lock().unwrap();
            f(&mut s);
            s.clone()
        };
        let _ = app.emit(STATUS_EVENT, &status);
        crate::tray::set_update(app, &status);
    }
}

/// Check now. `manual` means the user asked (Settings or the tray): report the outcome to them
/// even when there's nothing new, and check even if a background check ran recently.
pub async fn check(app: &AppHandle, manual: bool) -> UpdateStatus {
    let Some(u) = app.try_state::<Updates>() else { return unavailable(app) };
    #[cfg(feature = "updater")]
    {
        if u.status().state == UpdateState::Unavailable {
            return u.status();
        }
        let _guard = u.busy.lock().await;
        // Already downloaded: nothing more to do until it's installed.
        if u.is_ready() {
            return u.status();
        }
        if !manual {
            let recent = u.status().checked_at.and_then(|t| chrono::DateTime::parse_from_rfc3339(&t).ok()).is_some_and(|t| chrono::Utc::now() - t.with_timezone(&chrono::Utc) < CHECK_EVERY);
            if recent {
                return u.status();
            }
        }
        let outcome = check_and_download(app, &u).await;
        let now = chrono::Utc::now().to_rfc3339();
        match outcome {
            Ok(None) => u.set(app, |s| {
                *s = UpdateStatus { state: UpdateState::UpToDate, checked_at: Some(now), version: None, notes: None, progress: None, error: None, ..s.clone() };
            }),
            Ok(Some((update, bytes))) => {
                let version = update.version.clone();
                let notes = update.body.clone().filter(|b| !b.trim().is_empty());
                *u.pending.lock().unwrap() = Some((update, bytes));
                u.set(app, |s| {
                    *s = UpdateStatus { state: UpdateState::Ready, version: Some(version.clone()), notes, checked_at: Some(now), progress: None, error: None, ..s.clone() };
                });
                let first_time = u.notified.lock().unwrap().replace(version.clone()).as_deref() != Some(version.as_str());
                if first_time && !manual {
                    crate::events::notify(app, &format!("{} {version} is ready", crate::app_name()), RESTART_HINT);
                }
            }
            Err(e) => {
                tracing::warn!("update check failed: {e}");
                u.set(app, |s| {
                    s.state = UpdateState::Error;
                    s.error = Some(e);
                    s.progress = None;
                });
            }
        }
        return u.status();
    }
    #[cfg(not(feature = "updater"))]
    {
        let _ = manual;
        u.status()
    }
}

fn unavailable(app: &AppHandle) -> UpdateStatus {
    UpdateStatus { state: UpdateState::Unavailable, current_version: app.package_info().version.to_string(), version: None, notes: None, progress: None, error: None, checked_at: None }
}

#[cfg(feature = "updater")]
async fn check_and_download(app: &AppHandle, u: &Updates) -> Result<Option<(tauri_plugin_updater::Update, Vec<u8>)>, String> {
    use tauri_plugin_updater::UpdaterExt;
    u.set(app, |s| {
        s.state = UpdateState::Checking;
        s.error = None;
    });
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let Some(update) = update else { return Ok(None) };
    let version = update.version.clone();
    u.set(app, |s| {
        s.state = UpdateState::Downloading;
        s.version = Some(version);
        s.progress = Some(0.0);
    });
    let mut done = 0usize;
    let mut last_emit = 0.0;
    let bytes = update
        .download(
            |chunk, total| {
                done += chunk;
                if let Some(total) = total.filter(|t| *t > 0) {
                    let p = (done as f64 / total as f64).min(1.0);
                    // Every 2% is plenty for a progress bar.
                    if p - last_emit >= 0.02 {
                        last_emit = p;
                        u.set(app, |s| s.progress = Some(p));
                    }
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some((update, bytes)))
}

/// Background checks: shortly after launch, then whenever the last check is a few hours old.
pub async fn check_loop(app: AppHandle) {
    #[cfg(feature = "updater")]
    {
        if crate::IS_DEV {
            return;
        }
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            check(&app, false).await;
            tokio::time::sleep(TICK).await;
        }
    }
    #[cfg(not(feature = "updater"))]
    let _ = app;
}

/// Install the downloaded update and relaunch. Web-account sign-ins are saved first, as on quit.
pub fn install_and_restart(app: &AppHandle) {
    #[cfg(feature = "updater")]
    {
        let Some(u) = app.try_state::<Updates>() else { return };
        let Some((update, bytes)) = u.pending.lock().unwrap().take() else { return };
        u.set(app, |s| s.state = UpdateState::Installing);
        crate::PERSISTED.store(true, std::sync::atomic::Ordering::SeqCst);
        let h = app.clone();
        crate::webaccounts::persist_all_then(app.clone(), move || {
            // Windows: the installer replaces the running app, so close the web-account views
            // first (that flushes their cookies and releases their profile locks) and give them
            // a moment. `install` then starts the installer, which relaunches the app, and exits.
            #[cfg(target_os = "windows")]
            {
                let c = h.clone();
                let _ = h.run_on_main_thread(move || crate::webaccounts::close_all(&c));
                std::thread::sleep(std::time::Duration::from_millis(1500));
            }
            match update.install(&bytes) {
                Ok(()) => h.request_restart(),
                Err(e) => {
                    tracing::warn!("update install failed: {e}");
                    crate::PERSISTED.store(false, std::sync::atomic::Ordering::SeqCst);
                    if let Some(u) = h.try_state::<Updates>() {
                        u.set(&h, |s| {
                            s.state = UpdateState::Error;
                            s.error = Some(format!("Couldn't install the update: {e}"));
                        });
                    }
                }
            }
        });
    }
    #[cfg(not(feature = "updater"))]
    let _ = app;
}

/// On quit, install a downloaded update so the next launch is the new version. macOS only:
/// there it just replaces the app bundle. On Windows the installer would show its window and
/// relaunch the app the user just quit, so there it installs only on "Restart to update".
/// Runs off the main thread, before the app exits.
pub fn install_on_quit(app: &AppHandle) {
    #[cfg(all(feature = "updater", target_os = "macos"))]
    if let Some(u) = app.try_state::<Updates>() {
        if let Some((update, bytes)) = u.pending.lock().unwrap().take() {
            if let Err(e) = update.install(&bytes) {
                tracing::warn!("update install on quit failed: {e}");
            }
        }
    }
    let _ = app;
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub async fn update_status(app: AppHandle) -> Result<UpdateStatus, mail_core::Error> {
    Ok(app.try_state::<Updates>().map(|u| u.status()).unwrap_or_else(|| unavailable(&app)))
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateStatus, mail_core::Error> {
    Ok(check(&app, true).await)
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), mail_core::Error> {
    install_and_restart(&app);
    Ok(())
}
