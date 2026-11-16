use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::store::{lock, State};

const LABEL: &str = "main";

/// Chromium switches for steady animation. Tauri's defaults have to be restated
/// because this setting replaces them.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
    --enable-gpu-rasterization --enable-zero-copy --ignore-gpu-blocklist \
    --autoplay-policy=no-user-gesture-required --disable-background-timer-throttling";

/// Shows the launcher, creating its window if the interface was dropped.
pub fn open(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let state = app.state::<State>();
    let (fullscreen, display) = {
        let settings = lock(&state.settings);
        (settings.start_fullscreen, settings.display.clone())
    };
    // VELA_DEBUG_PORT opens the DevTools protocol for automated interface tests.
    let args = match std::env::var("VELA_DEBUG_PORT") {
        Ok(port) => format!("{BROWSER_ARGS} --remote-debugging-port={port}"),
        Err(_) => BROWSER_ARGS.to_string(),
    };
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()));
    // Test runs keep their browser storage with their data, away from the real profile.
    if std::env::var_os("VELA_DATA_DIR").is_some() {
        builder = builder.data_directory(state.dir.join("webview"));
    }
    let built = builder
        .title("Vela")
        .inner_size(1440.0, 900.0)
        .min_inner_size(960.0, 600.0)
        .decorations(false)
        .shadow(true)
        .visible(false)
        .background_color(tauri::webview::Color(7, 9, 15, 255))
        .center()
        .additional_browser_args(&args)
        .build();
    match built {
        // Still hidden: it moves to its screen and goes full screen before anyone sees it.
        Ok(window) => {
            place(&window, &display);
            if fullscreen {
                let _ = window.set_fullscreen(true);
            }
        }
        Err(e) => eprintln!("window: {e}"),
    }
}

/// Moves the window to the chosen screen, centered, keeping full screen and maximized as they were.
pub fn place(window: &WebviewWindow, display: &str) {
    if display.is_empty() {
        return;
    }
    let monitors = window.available_monitors().unwrap_or_default();
    let Some(monitor) = monitors.iter().find(|m| m.name().is_some_and(|n| n == display)) else { return };
    if window.current_monitor().ok().flatten().and_then(|m| m.name().cloned()).as_deref() == Some(display) {
        return;
    }
    let full = window.is_fullscreen().unwrap_or(false);
    let maximized = window.is_maximized().unwrap_or(false);
    if full {
        let _ = window.set_fullscreen(false);
    }
    if maximized {
        let _ = window.unmaximize();
    }
    let size = window.outer_size().unwrap_or_default();
    let (origin, area) = (monitor.position(), monitor.size());
    let x = origin.x + (area.width.saturating_sub(size.width) / 2) as i32;
    let y = origin.y + (area.height.saturating_sub(size.height) / 2) as i32;
    let _ = window.set_position(PhysicalPosition::new(x, y));
    if maximized {
        let _ = window.maximize();
    }
    if full {
        let _ = window.set_fullscreen(true);
    }
}

/// Puts an open launcher on the screen the settings name.
pub fn place_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let display = lock(&app.state::<State>().settings).display.clone();
        place(&window, &display);
    }
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
}

pub fn minimize(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.minimize();
    }
}

/// Releases the interface and every browser process behind it.
pub fn destroy(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
}
