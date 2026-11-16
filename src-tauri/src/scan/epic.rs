use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

use base64::Engine;
use serde_json::Value;

use super::galaxy::Galaxy;
use crate::model::{Game, Launch};

fn data_dir() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var("ProgramData").ok()?).join("Epic/EpicGamesLauncher/Data"))
}

fn links(game: &mut Game, namespace: &str, catalog: &str, app: &str) {
    let id = format!("{namespace}%3A{catalog}%3A{app}");
    game.launch = Some(Launch::Url { url: format!("com.epicgames.launcher://apps/{id}?action=launch&silent=true") });
    game.install = Some(Launch::Url { url: format!("com.epicgames.launcher://apps/{id}?action=install") });
    game.uninstall = Some(Launch::Url { url: "com.epicgames.launcher://store/library".into() });
}

struct Catalog {
    title: String,
    namespace: String,
    id: String,
    app: String,
    tall: Option<String>,
    wide: Option<String>,
    logo: Option<String>,
    description: Option<String>,
    developer: Option<String>,
    is_game: bool,
    is_base: bool,
}

/// Epic's cached catalog: every item this account's launcher knows about.
fn catalog() -> Vec<Catalog> {
    let Some(path) = data_dir().map(|d| d.join("Catalog/catcache.bin")) else { return Vec::new() };
    let Ok(text) = fs::read_to_string(path) else { return Vec::new() };
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(text.trim()) else { return Vec::new() };
    let Ok(Value::Array(items)) = serde_json::from_slice::<Value>(&bytes) else { return Vec::new() };
    items.iter().filter_map(read_item).collect()
}

fn read_item(item: &Value) -> Option<Catalog> {
    let text = |k: &str| item.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from);
    let categories: Vec<&str> = item.get("categories")?.as_array()?.iter().filter_map(|c| c.get("path")?.as_str()).collect();
    let image = |kind: &str| -> Option<String> {
        item.get("keyImages")?.as_array()?.iter().find(|i| i.get("type").and_then(Value::as_str) == Some(kind))?.get("url")?.as_str().map(String::from)
    };
    let app = item.get("releaseInfo")?.as_array()?.first()?.get("appId")?.as_str()?.to_string();
    let is_base = item.get("mainGameItem").and_then(|m| m.get("id")).and_then(Value::as_str).is_none_or(str::is_empty)
        && !categories.iter().any(|c| *c == "addons" || c.starts_with("addons/"));
    let is_game = categories.contains(&"games") && !categories.iter().any(|c| matches!(*c, "software" | "engines" | "plugins" | "hidden" | "digitalextras"));
    Some(Catalog {
        title: text("title")?,
        namespace: text("namespace")?,
        id: text("id")?,
        app,
        tall: image("DieselGameBoxTall").or_else(|| image("OfferImageTall")),
        wide: image("DieselGameBox").or_else(|| image("OfferImageWide")),
        logo: image("DieselGameBoxLogo"),
        description: text("description"),
        developer: text("developer"),
        is_game,
        is_base,
    })
}

fn apply_catalog(game: &mut Game, c: &Catalog) {
    game.art.cover.extend(c.tall.clone());
    game.art.hero.extend(c.wide.clone());
    game.art.logo.extend(c.logo.clone());
    game.meta.description = game.meta.description.take().or_else(|| c.description.clone());
    game.meta.developer = game.meta.developer.take().or_else(|| c.developer.clone());
}

pub fn scan(galaxy: Option<&Galaxy>) -> Vec<Game> {
    let Some(data) = data_dir() else { return Vec::new() };
    let catalog = catalog();
    let by_app: HashMap<&str, &Catalog> = catalog.iter().map(|c| (c.app.as_str(), c)).collect();
    let mut seen = HashSet::new();
    let mut games = Vec::new();

    for file in fs::read_dir(data.join("Manifests")).into_iter().flatten().flatten() {
        if file.path().extension().is_none_or(|e| !e.eq_ignore_ascii_case("item")) {
            continue;
        }
        let Some(item) = fs::read(file.path()).ok().and_then(|d| serde_json::from_slice::<Value>(&d).ok()) else { continue };
        let text = |k: &str| item.get(k).and_then(Value::as_str).unwrap_or_default();
        let categories: Vec<&str> =
            item.get("AppCategories").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        let app = text("AppName");
        // Manifests also cover engines, plugins, DLC chunks and desktop software.
        if !categories.contains(&"games") || categories.contains(&"software") || item.get("bIsApplication").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        if app.is_empty() || text("LaunchExecutable").is_empty() || !seen.insert(app.to_string()) {
            continue;
        }
        let dir = text("InstallLocation").replace('/', "\\");
        let complete = item.get("bIsIncompleteInstall").and_then(Value::as_bool) != Some(true);
        let exe = PathBuf::from(&dir).join(text("LaunchExecutable"));
        let mut game = Game::new(format!("epic:{app}"), text("DisplayName"), "epic");
        game.installed = complete && exe.exists();
        game.exe = Some(exe.to_string_lossy().into_owned());
        game.install_dir = Some(dir);
        game.size = item.get("InstallSize").and_then(Value::as_u64);
        links(&mut game, text("CatalogNamespace"), text("CatalogItemId"), app);
        if let Some(c) = by_app.get(app) {
            apply_catalog(&mut game, c);
        }
        games.push(game);
    }

    // The launcher's catalog covers the rest of the account's games.
    for c in catalog.iter().filter(|c| c.is_game && c.is_base) {
        if seen.insert(c.app.clone()) {
            let mut game = Game::new(format!("epic:{}", c.app), &c.title, "epic");
            links(&mut game, &c.namespace, &c.id, &c.app);
            apply_catalog(&mut game, c);
            games.push(game);
        }
    }

    // Galaxy remembers games the launcher hasn't cached, but has no catalog ids
    // for them, so these open the store's library page instead.
    if let Some(g) = galaxy {
        for (key, entry) in &g.owned {
            let Some(app) = key.strip_prefix("epic_") else { continue };
            let known_non_game = by_app.get(app).is_some_and(|c| !c.is_game);
            if known_non_game || entry.genres.is_empty() || !seen.insert(app.to_string()) {
                continue;
            }
            let mut game = Game::new(format!("epic:{app}"), &entry.title, "epic");
            game.install = Some(Launch::Url { url: "com.epicgames.launcher://store/library".into() });
            games.push(game);
        }
    }
    games
}

pub fn watch_paths() -> Vec<PathBuf> {
    data_dir().map(|d| vec![d.join("Manifests")]).unwrap_or_default()
}
