#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod art;
mod commands;
mod launch;
mod meta;
mod model;
mod scan;
mod store;
mod titles;
mod vdf;
mod watch;
mod win;
mod window;

use tauri::{Manager, RunEvent};

use store::{lock, State};

/// `--dump-scan` prints what detection finds, for checking it without the interface.
fn dump_scan() {
    let state = State::load();
    let settings = lock(&state.settings).clone();
    let mut lookups = lock(&state.cache).lookups.clone();
    let started = std::time::Instant::now();
    let games = scan::scan_all(&settings, &mut lookups, true);
    let elapsed = started.elapsed();
    lock(&state.cache).lookups = lookups;
    state.save_cache();
    let report: Vec<_> = games
        .iter()
        .map(|g| {
            serde_json::json!({
                "id": g.id, "title": g.title, "source": g.source, "installed": g.installed,
                "dir": g.install_dir, "exe": g.exe, "launch": g.launch, "install": g.install,
                "last_played": g.last_played, "playtime": g.playtime,
            })
        })
        .collect();
    println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
    eprintln!("{} entries in {:.1}s", games.len(), elapsed.as_secs_f32());
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--dump-scan") {
        dump_scan();
        return;
    }
    let from_startup = args.iter().any(|a| a == "--startup");

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| window::open(app)))
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("art", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let uri = request.uri().clone();
            std::thread::spawn(move || responder.respond(art::respond(&app, uri.path(), uri.query())));
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_library,
            commands::get_game,
            commands::get_settings,
            commands::set_settings,
            commands::ui_ready,
            commands::launch_game,
            commands::cancel_launch,
            commands::current_session,
            commands::take_last_session,
            commands::install_game,
            commands::uninstall_game,
            commands::open_game_folder,
            commands::set_favorite,
            commands::set_hidden,
            commands::hidden_games,
            commands::rescan,
            commands::pick_folder,
            commands::add_game,
            commands::storage_info,
            commands::clear_art_cache,
            commands::refresh_art,
            commands::rename_game,
            commands::pick_game_art,
            commands::reset_game_look,
            commands::app_version,
            commands::set_fullscreen,
            commands::is_fullscreen,
            commands::minimize_window,
            commands::toggle_maximize,
            commands::to_desktop,
            commands::quit_app,
            commands::power,
            commands::get_stats,
            commands::set_in_collection,
            commands::rename_collection,
            commands::delete_collection,
            commands::list_displays,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            app.manage(State::load());
            watch::start_tray(&handle)?;
            watch::start_scanner(handle.clone());
            watch::start_watcher(handle.clone());
            let start_hidden = from_startup && lock(&app.state::<State>().settings).start_minimized;
            if !start_hidden {
                window::open(&handle);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start Vela");

    app.run(|_app, event| {
        // Closing the last window isn't quitting: the interface comes and goes
        // around games. Quit is explicit, through the app or the tray.
        if let RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}
