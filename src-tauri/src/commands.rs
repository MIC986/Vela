use std::path::Path;
use std::process::Command;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State as Tauri, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::model::{Collection, Game, GameDetail, GameView, Launch, Look, Settings};
use crate::scan::{local, title_key, xbox};
use crate::store::{lock, ScanRequest, State};
use crate::titles::clean_folder_name;
use crate::{art, launch, win, window};

#[derive(Serialize)]
pub struct Library {
    games: Vec<GameView>,
    scanning: bool,
    ask_gamepass: bool,
    collections: Vec<String>,
}

#[tauri::command]
pub fn get_library(state: Tauri<State>) -> Library {
    let collections = lock(&state.user).collections.iter().map(|c| c.name.clone()).collect();
    Library { games: state.views(), scanning: *lock(&state.scanning), ask_gamepass: state.asks_about_pass(), collections }
}

/// Everything Vela watched being played, for Statistics.
#[tauri::command]
pub fn get_stats(state: Tauri<State>) -> Value {
    let history = lock(&state.user).history.clone();
    json!({"history": history, "drives": win::drives()})
}

fn edit_collections(app: &AppHandle, change: impl FnOnce(&mut Vec<Collection>) -> Result<(), String>) -> Result<(), String> {
    let state = app.state::<State>();
    change(&mut lock(&state.user).collections)?;
    state.save_user();
    let _ = app.emit("library-updated", ());
    Ok(())
}

/// Adds a game to a collection, making the collection if it's new, or takes it out.
#[tauri::command]
pub fn set_in_collection(app: AppHandle, id: String, name: String, member: bool) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("A collection needs a name.".into());
    }
    let game = app.state::<State>().game(&id).ok_or("That game is no longer in your library.")?;
    let key = title_key(&game.title);
    edit_collections(&app, |all| {
        let index = match all.iter().position(|c| c.name.eq_ignore_ascii_case(&name)) {
            Some(i) => i,
            None => {
                all.push(Collection { name, games: Vec::new() });
                all.len() - 1
            }
        };
        let games = &mut all[index].games;
        games.retain(|k| *k != key);
        if member {
            games.push(key);
        }
        Ok(())
    })
}

#[tauri::command]
pub fn rename_collection(app: AppHandle, name: String, to: String) -> Result<(), String> {
    let to = to.trim().to_string();
    edit_collections(&app, |all| {
        if to.is_empty() || all.iter().any(|c| c.name.eq_ignore_ascii_case(&to) && !c.name.eq_ignore_ascii_case(&name)) {
            return Err("Pick a name no other collection has.".into());
        }
        if let Some(c) = all.iter_mut().find(|c| c.name == name) {
            c.name = to;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn delete_collection(app: AppHandle, name: String) -> Result<(), String> {
    edit_collections(&app, |all| {
        all.retain(|c| c.name != name);
        Ok(())
    })
}

/// The screens Vela can open on.
#[tauri::command]
pub fn list_displays(window: WebviewWindow) -> Vec<Value> {
    let primary = window.primary_monitor().ok().flatten().and_then(|m| m.name().cloned());
    let monitors = window.available_monitors().unwrap_or_default();
    monitors
        .iter()
        .enumerate()
        .filter_map(|(i, m)| {
            let name = m.name()?.clone();
            let size = m.size();
            Some(json!({"id": name, "label": format!("Screen {} · {}×{}", i + 1, size.width, size.height), "primary": primary.as_ref() == Some(&name)}))
        })
        .collect()
}

#[tauri::command]
pub fn get_game(state: Tauri<State>, id: String) -> Option<GameDetail> {
    state.detail(&id)
}

#[tauri::command]
pub fn get_settings(state: Tauri<State>) -> Settings {
    lock(&state.settings).clone()
}

#[tauri::command]
pub fn set_settings(app: AppHandle, state: Tauri<State>, settings: Settings) -> Result<(), String> {
    let previous = lock(&state.settings).clone();
    if previous.start_with_windows != settings.start_with_windows {
        win::set_run_at_startup(settings.start_with_windows)?;
    }
    let folders_changed = previous.scan_folders != settings.scan_folders;
    let library_changed =
        previous.gamepass_on != settings.gamepass_on || previous.gamepass_plan != settings.gamepass_plan || previous.show_uninstalled != settings.show_uninstalled;
    let online_enabled = !previous.online() && settings.online();
    let moved = previous.display != settings.display;
    *lock(&state.settings) = settings;
    state.save_settings();
    if moved {
        window::place_main(&app);
    }
    if library_changed {
        state.rebuild();
        let _ = app.emit("library-updated", ());
    }
    if online_enabled {
        art::forget_misses();
    }
    if folders_changed {
        state.request_scan(ScanRequest::Full);
    } else if online_enabled || library_changed {
        state.request_scan(ScanRequest::Quick);
    }
    Ok(())
}

#[tauri::command]
pub fn ui_ready(window: WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

#[tauri::command]
pub fn launch_game(app: AppHandle, id: String) -> Result<(), String> {
    launch::launch(&app, &id)
}

/// Brings the launcher back while a game is starting, without touching the game.
#[tauri::command]
pub fn cancel_launch(app: AppHandle) {
    launch::cancel(&app);
}

#[tauri::command]
pub fn current_session(state: Tauri<State>) -> Option<launch::Session> {
    lock(&state.session).clone()
}

#[tauri::command]
pub fn take_last_session(state: Tauri<State>) -> Option<launch::Finished> {
    lock(&state.last_session).take()
}

#[tauri::command]
pub fn install_game(state: Tauri<State>, id: String) -> Result<(), String> {
    let game = state.game(&id).ok_or("That game is no longer in your library.")?;
    let target = game.install.clone().ok_or("This store doesn't offer an install link.")?;
    win::shell_open(&target)
}

/// Xbox games are removed by Vela itself; every other store is asked to do it.
/// Reports whether the game is already gone.
#[tauri::command]
pub async fn uninstall_game(app: AppHandle, id: String) -> Result<bool, String> {
    let state = app.state::<State>();
    let game = state.copies_of(&id).iter().filter_map(|c| state.game(c)).find(|g| g.installed).ok_or("That game isn't installed.")?;
    if let Some(family) = game.pfn.clone().filter(|_| game.source == "xbox") {
        tauri::async_runtime::spawn_blocking(move || xbox::remove_package(&family)).await.map_err(|e| e.to_string())??;
        state.request_scan(ScanRequest::Full);
        return Ok(true);
    }
    let target = game.uninstall.clone().ok_or("Remove this game from its own folder or store.")?;
    win::shell_open(&target)?;
    Ok(false)
}

#[tauri::command]
pub fn open_game_folder(state: Tauri<State>, id: String) -> Result<(), String> {
    let game = state.game(&id).ok_or("That game is no longer in your library.")?;
    let dir = game.install_dir.clone().filter(|d| Path::new(d).exists()).ok_or("The game's folder wasn't found.")?;
    win::shell_open(&Launch::Exe { path: "explorer.exe".into(), args: format!("\"{dir}\""), cwd: None })
}

#[tauri::command]
pub fn set_favorite(app: AppHandle, state: Tauri<State>, id: String, favorite: bool) {
    let copies = state.copies_of(&id);
    {
        let mut user = lock(&state.user);
        user.favorites.retain(|f| !copies.contains(f));
        if favorite {
            user.favorites.push(id);
        }
    }
    state.save_user();
    let _ = app.emit("library-updated", ());
}

#[tauri::command]
pub fn set_hidden(app: AppHandle, state: Tauri<State>, id: String, hidden: bool) {
    let copies = state.copies_of(&id);
    {
        let mut user = lock(&state.user);
        user.hidden.retain(|h| !copies.contains(h));
        if hidden {
            user.hidden.push(id);
        }
    }
    state.save_user();
    let _ = app.emit("library-updated", ());
}

#[tauri::command]
pub fn hidden_games(state: Tauri<State>) -> Vec<Value> {
    let hidden = lock(&state.user).hidden.clone();
    hidden.iter().filter_map(|id| state.game(id)).map(|g| json!({"id": g.id, "title": g.title, "source": g.source})).collect()
}

#[tauri::command]
pub fn rescan(state: Tauri<State>) {
    state.request_scan(ScanRequest::Full);
}

#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder.and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().into_owned()));
    });
    tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten()).await.ok().flatten()
}

/// Adds a program the scanner didn't find. The user's word overrides every heuristic.
#[tauri::command]
pub async fn add_game(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().add_filter("Games", &["exe"]).pick_file(move |file| {
        let _ = tx.send(file.and_then(|f| f.into_path().ok()));
    });
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten()).await.map_err(|e| e.to_string())?;
    let Some(exe) = picked else { return Ok(None) };
    let root = local::game_root(&exe);
    let folder = root.file_name().unwrap_or_default().to_string_lossy().to_string();
    let path = exe.to_string_lossy().into_owned();
    let title = win::version_info(&exe).product_name.filter(|n| n.len() > 2).unwrap_or_else(|| clean_folder_name(&folder));
    let mut game = Game::new(format!("custom:{:016x}", crate::store::fnv(&path.to_lowercase())), title.clone(), "local");
    game.installed = true;
    game.install_dir = Some(root.to_string_lossy().into_owned());
    game.exe = Some(path.clone());
    game.launch = Some(Launch::Exe { cwd: exe.parent().map(|p| p.to_string_lossy().into_owned()), path, args: String::new() });

    let state = app.state::<State>();
    {
        let mut user = lock(&state.user);
        user.custom.retain(|g| g.id != game.id);
        user.custom.push(game);
    }
    state.save_user();
    state.rebuild();
    let _ = app.emit("library-updated", ());
    Ok(Some(title))
}

#[tauri::command]
pub fn storage_info(state: Tauri<State>) -> Value {
    json!({"drives": win::drives(), "cache": art::cache_size(&state)})
}

#[tauri::command]
pub fn clear_art_cache(state: Tauri<State>) -> u64 {
    art::clear_cache(&state)
}

/// Throws away one game's art and catalog entries, so both are fetched anew.
#[tauri::command]
pub fn refresh_art(app: AppHandle, state: Tauri<State>, id: String) {
    for copy in state.copies_of(&id) {
        if let Some(game) = state.game(&copy) {
            art::forget(&state, &game);
            let mut cache = lock(&state.cache);
            if let Some(item) = game.steam_appid.and_then(|appid| cache.steam.get_mut(&appid)) {
                item.fetched = 0;
            }
            if let Some(item) = game.store_id.as_ref().and_then(|store_id| cache.microsoft.get_mut(store_id)) {
                item.fetched = 0;
            }
            let key = title_key(&game.title);
            if matches!(cache.search.get(&key), Some((None, _))) {
                cache.search.remove(&key);
            }
        }
        *lock(&state.user).art_bust.entry(copy).or_default() += 1;
    }
    state.save_user();
    state.rebuild();
    let _ = app.emit("library-updated", ());
    state.request_scan(ScanRequest::Quick);
}

/// Changes one game's look, and drops it entirely once nothing is left customized.
fn edit_look(app: &AppHandle, id: &str, change: impl FnOnce(&mut Look)) -> Result<(), String> {
    let state = app.state::<State>();
    let game = state.game(id).ok_or("That game is no longer in your library.")?;
    {
        let mut user = lock(&state.user);
        let look = user.looks.entry(title_key(&game.title)).or_default();
        change(look);
        if look.is_empty() {
            user.looks.remove(&title_key(&game.title));
        }
    }
    state.save_user();
    state.rebuild();
    let _ = app.emit("library-updated", ());
    Ok(())
}

#[tauri::command]
pub fn rename_game(app: AppHandle, id: String, title: String) -> Result<(), String> {
    let title = Some(title.trim().to_string()).filter(|t| !t.is_empty());
    edit_look(&app, &id, |look| look.title = title)
}

/// Lets the user pick their own image. A copy is kept, so it survives the original
/// moving. Reports whether anything was chosen.
#[tauri::command]
pub async fn pick_game_art(app: AppHandle, id: String, kind: String) -> Result<bool, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().add_filter("Images", &["png", "jpg", "jpeg", "webp"]).pick_file(move |file| {
        let _ = tx.send(file.and_then(|f| f.into_path().ok()));
    });
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten()).await.map_err(|e| e.to_string())?;
    let Some(source) = picked else { return Ok(false) };
    let state = app.state::<State>();
    let saved = art::keep_custom(&state, &source, &id, &kind)?;
    edit_look(&app, &id, |look| {
        let slot = match kind.as_str() {
            "cover" => &mut look.cover,
            "hero" => &mut look.hero,
            _ => &mut look.logo,
        };
        art::drop_custom(slot.replace(saved));
    })?;
    Ok(true)
}

/// Back to the store's name and art.
#[tauri::command]
pub fn reset_game_look(app: AppHandle, id: String) -> Result<(), String> {
    edit_look(&app, &id, |look| {
        for image in [look.cover.take(), look.hero.take(), look.logo.take()] {
            art::drop_custom(image);
        }
        look.title = None;
    })
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn set_fullscreen(window: WebviewWindow, state: Tauri<State>, on: bool) -> Result<(), String> {
    if on {
        window::place(&window, &lock(&state.settings).display);
    }
    window.set_fullscreen(on).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn is_fullscreen(window: WebviewWindow) -> bool {
    window.is_fullscreen().unwrap_or(false)
}

#[tauri::command]
pub fn minimize_window(window: WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
pub fn toggle_maximize(window: WebviewWindow) {
    let maximized = window.is_maximized().unwrap_or(false);
    let _ = if maximized { window.unmaximize() } else { window.maximize() };
}

/// Steps back to the Windows desktop, leaving Vela in the tray.
#[tauri::command]
pub fn to_desktop(app: AppHandle) {
    window::destroy(&app);
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn power(action: String) -> Result<(), String> {
    let result = match action.as_str() {
        "sleep" => Command::new("rundll32.exe").args(["powrprof.dll,SetSuspendState", "0,1,0"]).spawn(),
        "restart" => Command::new("shutdown.exe").args(["/r", "/t", "0"]).spawn(),
        "shutdown" => Command::new("shutdown.exe").args(["/s", "/t", "0"]).spawn(),
        _ => return Err("Unknown power action.".into()),
    };
    result.map(|_| ()).map_err(|e| e.to_string())
}
