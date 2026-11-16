use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

use super::galaxy::{unix_year, Galaxy};
use crate::model::{Game, Launch};
use crate::vdf::{self, AppInfo, Value};

const CDN: &str = "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps";

/// Steam's own tooling. Installed like games, never played like them.
const NOT_GAMES: &[&str] = &[
    "steamworks common redistributables",
    "steamvr",
    "steam linux runtime",
    "proton",
    "wallpaper engine",
];

fn root() -> Option<PathBuf> {
    let from_registry = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Valve\Steam")
        .ok()
        .and_then(|k| k.get_value::<String, _>("SteamPath").ok())
        .map(PathBuf::from);
    from_registry.filter(|p| p.exists()).or_else(|| {
        let p = PathBuf::from(std::env::var("ProgramFiles(x86)").ok()?).join("Steam");
        p.exists().then_some(p)
    })
}

fn libraries(root: &Path) -> Vec<PathBuf> {
    let mut libs = vec![root.to_path_buf()];
    if let Ok(text) = fs::read_to_string(root.join("steamapps/libraryfolders.vdf")) {
        let data = vdf::parse_text(&text);
        if let Some(folders) = data.get("libraryfolders") {
            for (_, entry) in folders.items() {
                if let Some(path) = entry.str("path") {
                    libs.push(PathBuf::from(path));
                }
            }
        }
    }
    let mut seen = HashSet::new();
    libs.retain(|p| seen.insert(p.to_string_lossy().to_lowercase().replace('/', "\\")) && p.exists());
    libs
}

/// The folder of whichever account last used Steam on this PC.
fn user_folder(root: &Path) -> Option<PathBuf> {
    let userdata = root.join("userdata");
    let active: Option<u32> = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Valve\Steam\ActiveProcess")
        .ok()
        .and_then(|k| k.get_value("ActiveUser").ok())
        .filter(|id| *id != 0);
    if let Some(dir) = active.map(|id| userdata.join(id.to_string())).filter(|d| d.join("config/localconfig.vdf").exists()) {
        return Some(dir);
    }
    fs::read_dir(&userdata)
        .ok()?
        .flatten()
        .filter(|e| e.path().join("config/localconfig.vdf").exists())
        .max_by_key(|e| e.path().join("config/localconfig.vdf").metadata().and_then(|m| m.modified()).ok())
        .map(|e| e.path())
}

#[derive(Default)]
struct Played {
    last: Option<i64>,
    minutes: u64,
}

fn play_records(user: Option<&Path>) -> HashMap<u32, Played> {
    let mut out = HashMap::new();
    let Some(text) = user.and_then(|u| fs::read_to_string(u.join("config/localconfig.vdf")).ok()) else { return out };
    let data = vdf::parse_text(&text);
    let apps = data.path(&["UserLocalConfigStore", "Software", "Valve", "Steam", "apps"]);
    for (id, entry) in apps.map(Value::items).unwrap_or_default() {
        if let Ok(id) = id.parse() {
            out.insert(
                id,
                Played { last: entry.int("LastPlayed").filter(|t| *t > 0), minutes: entry.int("Playtime").unwrap_or(0).max(0) as u64 },
            );
        }
    }
    out
}

fn is_game(app: Option<&AppInfo>, name: &str) -> bool {
    let lower = name.to_lowercase();
    if NOT_GAMES.iter().any(|n| lower.starts_with(n)) {
        return false;
    }
    match app.map(|a| a.kind.as_str()) {
        Some("game" | "demo" | "beta") => true,
        Some("" ) | None => true,
        Some(_) => false,
    }
}

/// Fills in local artwork first, then the CDN's predictable paths as a fallback.
fn set_art(game: &mut Game, cache: &Path, id: u32) {
    let (mut cover, mut hero, mut logo, mut header) = (None, None, None, None);
    let mut visit = |dir: &Path| {
        for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            let path = entry.path().to_string_lossy().into_owned();
            if name.starts_with("library_600x900") || name.starts_with("library_capsule") {
                cover.get_or_insert(path);
            } else if name.starts_with("library_hero") && !name.contains("blur") {
                hero.get_or_insert(path);
            } else if name.starts_with("logo") && name.ends_with(".png") {
                logo.get_or_insert(path);
            } else if name.starts_with("header") {
                header.get_or_insert(path);
            }
        }
    };
    let dir = cache.join(id.to_string());
    visit(&dir);
    for sub in fs::read_dir(&dir).into_iter().flatten().flatten().filter(|e| e.path().is_dir()) {
        visit(&sub.path());
    }
    game.art.cover.extend(cover);
    game.art.cover.push(format!("{CDN}/{id}/library_600x900_2x.jpg"));
    game.art.hero.extend(hero);
    game.art.hero.push(format!("{CDN}/{id}/library_hero.jpg"));
    game.art.logo.extend(logo);
    game.art.logo.push(format!("{CDN}/{id}/logo.png"));
    game.art.hero.extend(header);
    game.art.hero.push(format!("{CDN}/{id}/header.jpg"));
}

fn fill_info(game: &mut Game, info: Option<&AppInfo>) {
    let Some(info) = info else { return };
    game.meta.developer = info.developer.clone();
    game.meta.publisher = info.publisher.clone();
    game.meta.year = info.release.filter(|r| *r > 0).map(unix_year);
    game.meta.score = info.metacritic.filter(|s| *s > 0).or(info.review.filter(|s| *s > 0));
}

fn entry(id: u32, name: &str) -> Game {
    let mut game = Game::new(format!("steam:{id}"), name, "steam");
    game.steam_appid = Some(id);
    game.launch = Some(Launch::Url { url: format!("steam://rungameid/{id}") });
    game.install = Some(Launch::Url { url: format!("steam://install/{id}") });
    game.uninstall = Some(Launch::Url { url: format!("steam://uninstall/{id}") });
    game
}

pub fn scan(galaxy: Option<&Galaxy>) -> Vec<Game> {
    let Some(root) = root() else { return Vec::new() };
    let apps = fs::read(root.join("appcache/appinfo.vdf")).map(|d| vdf::parse_appinfo(&d)).unwrap_or_default();
    let cache = root.join("appcache/librarycache");
    let user = user_folder(&root);
    let played = play_records(user.as_deref());
    let mut games: HashMap<u32, Game> = HashMap::new();

    for lib in libraries(&root) {
        let steamapps = lib.join("steamapps");
        for file in fs::read_dir(&steamapps).into_iter().flatten().flatten() {
            let name = file.file_name().to_string_lossy().to_lowercase();
            if !(name.starts_with("appmanifest_") && name.ends_with(".acf")) {
                continue;
            }
            let Ok(text) = fs::read_to_string(file.path()) else { continue };
            let parsed = vdf::parse_text(&text);
            let Some(state) = parsed.get("AppState") else { continue };
            let Some(id) = state.int("appid").and_then(|v| u32::try_from(v).ok()) else { continue };
            let title = state.str("name").unwrap_or_default();
            let info = apps.get(&id);
            if title.is_empty() || !is_game(info, title) {
                continue;
            }
            let flags = state.int("StateFlags").unwrap_or(0);
            let mut game = entry(id, title);
            game.installed = flags & 4 != 0;
            let dir = state.str("installdir").map(|d| steamapps.join("common").join(d));
            game.install_dir = dir.filter(|d| d.exists()).map(|d| d.to_string_lossy().replace('/', "\\"));
            game.size = state.int("SizeOnDisk").and_then(|s| u64::try_from(s).ok()).filter(|s| *s > 0);
            let (done, total) = (state.int("BytesDownloaded").unwrap_or(0), state.int("BytesToDownload").unwrap_or(0));
            if !game.installed && total > 0 {
                game.progress = Some((done as f32 / total as f32).clamp(0.0, 1.0));
            }
            game.last_played = state.int("LastPlayed").filter(|t| *t > 0);
            fill_info(&mut game, info);
            set_art(&mut game, &cache, id);
            games.insert(id, game);
        }
    }

    // Owned but absent from disk: everything Steam keeps library art for or has
    // played, plus what Galaxy recorded, as long as appinfo says it's a game.
    let mut owned: HashSet<u32> = played.keys().copied().collect();
    for dir in fs::read_dir(&cache).into_iter().flatten().flatten() {
        if let Ok(id) = dir.file_name().to_string_lossy().parse::<u32>() {
            owned.insert(id);
        }
    }
    let galaxy_owned: HashMap<u32, &super::galaxy::Entry> = galaxy
        .map(|g| g.owned.iter().filter_map(|(k, e)| k.strip_prefix("steam_")?.parse().ok().map(|id| (id, e))).collect())
        .unwrap_or_default();
    owned.extend(galaxy_owned.keys());

    for id in owned {
        if games.contains_key(&id) {
            continue;
        }
        let info = apps.get(&id);
        let from_galaxy = galaxy_owned.get(&id);
        let name = info.map(|a| a.name.as_str()).filter(|n| !n.is_empty()).or(from_galaxy.map(|e| e.title.as_str()));
        let Some(name) = name else { continue };
        // Demos count once installed, but a removed demo isn't something the user owns.
        let confirmed = matches!(info.map(|a| a.kind.as_str()), Some("game" | "beta"));
        // Unknown to appinfo: Galaxy must at least have seen it as a game with genres.
        if !(confirmed || from_galaxy.is_some_and(|e| !e.genres.is_empty() && info.is_none())) || !is_game(info, name) {
            continue;
        }
        if info.is_some_and(|a| !a.oslist.is_empty() && !a.oslist.contains("windows")) {
            continue;
        }
        let mut game = entry(id, name);
        fill_info(&mut game, info);
        set_art(&mut game, &cache, id);
        games.insert(id, game);
    }

    for (id, record) in &played {
        if let Some(game) = games.get_mut(id) {
            game.last_played = record.last.or(game.last_played);
            game.playtime = Some(record.minutes);
        }
    }
    games.into_values().collect()
}

/// A program the user added to Steam as a non-Steam game.
pub struct Shortcut {
    pub title: String,
    pub exe: PathBuf,
    pub args: String,
}

pub fn shortcuts() -> Vec<Shortcut> {
    let Some(root) = root() else { return Vec::new() };
    let mut out = Vec::new();
    for user in fs::read_dir(root.join("userdata")).into_iter().flatten().flatten() {
        let Ok(data) = fs::read(user.path().join("config/shortcuts.vdf")) else { continue };
        let Some(parsed) = vdf::parse_binary(&data) else { continue };
        for (_, entry) in parsed.get("shortcuts").map(Value::items).unwrap_or_default() {
            let (Some(title), Some(exe)) = (entry.str("AppName"), entry.str("Exe")) else { continue };
            out.push(Shortcut {
                title: title.to_string(),
                exe: PathBuf::from(exe.trim().trim_matches('"')),
                args: entry.str("LaunchOptions").unwrap_or_default().to_string(),
            });
        }
    }
    out
}

/// Folders that change when Steam installs or removes something.
pub fn watch_paths() -> Vec<PathBuf> {
    root().map(|r| libraries(&r).into_iter().map(|l| l.join("steamapps")).collect()).unwrap_or_default()
}
