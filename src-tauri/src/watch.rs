//! Keeps the library current: file watchers catch installs and removals as they
//! happen, and a slow timer catches anything that leaves no trace in those folders.

use std::path::PathBuf;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::{Duration, Instant};

use notify::{recommended_watcher, Event, EventKind, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

use crate::scan;
use crate::store::{lock, now, ScanRequest, State};
use crate::{art, meta, window};

const QUIET: Duration = Duration::from_millis(2500);
/// Downloads write constantly; this keeps progress moving instead of waiting for silence.
const MAX_WAIT: Duration = Duration::from_secs(12);
const PERIODIC: Duration = Duration::from_secs(300);

/// `announce` is off for startup's two passes: games appearing then aren't news.
fn run_scan(app: &AppHandle, full: bool, announce: bool) {
    let state = app.state::<State>();
    *lock(&state.scanning) = true;
    let _ = app.emit("scan-state", true);
    let settings = lock(&state.settings).clone();
    let mut lookups = lock(&state.cache).lookups.clone();
    let games = if full {
        scan::scan_all(&settings, &mut lookups, settings.online())
    } else {
        // A quick pass only refreshes stores; local finds from the last full pass stand.
        let mut quick = scan::scan_stores(&mut lookups, settings.online());
        let keep: Vec<_> = lock(&state.scanned).iter().filter(|g| g.source == "local").cloned().collect();
        quick.extend(keep);
        quick
    };
    lock(&state.cache).lookups = lookups;
    {
        let mut user = lock(&state.user);
        let stamp = now();
        for game in &games {
            user.first_seen.entry(game.id.clone()).or_insert(stamp);
        }
    }
    *lock(&state.scanned) = games;
    let change = state.rebuild();
    state.save_library();
    state.save_user();
    *lock(&state.scanning) = false;
    let _ = app.emit("scan-state", false);
    let _ = app.emit("library-updated", ());
    if announce && (!change.added.is_empty() || !change.removed.is_empty()) {
        let _ = app.emit("library-changed", change);
    }
}

/// Owns all scanning, one pass at a time, folding queued requests together.
pub fn start_scanner(app: AppHandle) {
    let (tx, rx) = channel::<ScanRequest>();
    *lock(&app.state::<State>().scans) = Some(tx);
    std::thread::spawn(move || {
        // First paint comes from the stores, then the slower folder pass completes it.
        run_scan(&app, false, false);
        run_scan(&app, true, false);
        spawn_catalogs(&app);
        let mut last_periodic = Instant::now();
        loop {
            let first = rx.recv_timeout(Duration::from_secs(30));
            let mut full = false;
            let mut any = false;
            match first {
                Ok(request) => {
                    any = true;
                    full = matches!(request, ScanRequest::Full);
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            let state = app.state::<State>();
            // Never scan while a game runs: the point of closing the interface is
            // leaving the machine to the game.
            if lock(&state.session).is_some() {
                continue;
            }
            if !any && last_periodic.elapsed() < PERIODIC {
                continue;
            }
            for extra in rx.try_iter() {
                full |= matches!(extra, ScanRequest::Full);
            }
            let periodic = !any;
            if periodic {
                last_periodic = Instant::now();
            }
            run_scan(&app, full || periodic, true);
            spawn_catalogs(&app);
        }
    });
}

fn spawn_catalogs(app: &AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            meta::refresh(&app);
            let state = app.state::<State>();
            if lock(&state.settings).online() {
                art::prefetch(&app);
            }
            art::prune(&state);
        }));
        RUNNING.store(false, Ordering::SeqCst);
    });
}

fn watched_paths(app: &AppHandle) -> Vec<PathBuf> {
    let state = app.state::<State>();
    let mut paths = scan::steam::watch_paths();
    paths.extend(scan::epic::watch_paths());
    paths.extend(scan::xbox::watch_paths());
    paths.extend(lock(&state.settings).scan_folders.iter().map(PathBuf::from));
    paths.into_iter().filter(|p| p.exists()).collect()
}

pub fn start_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let folders = lock(&app.state::<State>().settings).scan_folders.clone();
        let (tx, rx) = channel::<bool>();
        let watcher = recommended_watcher(move |event: Result<Event, notify::Error>| {
            if let Ok(event) = event {
                if !matches!(event.kind, EventKind::Access(_)) {
                    // Stores are re-read quickly; the user's own folders need the folder pass.
                    let full = event.paths.iter().any(|p| folders.iter().any(|f| p.starts_with(f)));
                    let _ = tx.send(full);
                }
            }
        });
        let Ok(mut watcher) = watcher else { return };
        for path in watched_paths(&app) {
            let _ = watcher.watch(&path, RecursiveMode::NonRecursive);
        }
        // Wait until a burst of file activity settles, then scan once.
        while let Ok(first) = rx.recv() {
            let mut full = first;
            let began = Instant::now();
            while let Ok(next) = rx.recv_timeout(QUIET) {
                full |= next;
                if began.elapsed() > MAX_WAIT {
                    break;
                }
            }
            app.state::<State>().request_scan(if full { ScanRequest::Full } else { ScanRequest::Quick });
        }
    });
}

/// Tray icon: the way back while the interface is closed.
pub fn start_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let open = MenuItem::with_id(app, "open", "Open Vela", true, None::<&str>)?;
    let rescan = MenuItem::with_id(app, "rescan", "Rescan games", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &rescan, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut tray = TrayIconBuilder::with_id("vela").tooltip("Vela").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, event| match event.id.as_ref() {
        "open" => window::open(app),
        "rescan" => app.state::<State>().request_scan(ScanRequest::Full),
        "quit" => app.exit(0),
        _ => {}
    })
    .on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
            window::open(tray.app_handle());
        }
    })
    .build(app)?;
    Ok(())
}
