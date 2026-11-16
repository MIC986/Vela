pub mod epic;
pub mod galaxy;
pub mod local;
pub mod steam;
pub mod stores;
pub mod xbox;

use std::collections::HashSet;
use std::panic::{catch_unwind, AssertUnwindSafe};

use crate::model::{Game, Settings};
use crate::titles::normalize;
use galaxy::{Entry, Galaxy};

/// Runs one store's scanner so that a failure costs that store, not the scan.
fn guarded(name: &str, scanner: impl FnOnce() -> Vec<Game>) -> Vec<Game> {
    catch_unwind(AssertUnwindSafe(scanner)).unwrap_or_else(|_| {
        eprintln!("scanner failed: {name}");
        Vec::new()
    })
}

fn apply_galaxy(game: &mut Game, entry: &Entry) {
    game.art.cover.extend(entry.cover.clone());
    game.art.hero.extend(entry.hero.clone());
    game.art.logo.extend(entry.logo.clone());
    let m = &mut game.meta;
    m.description = m.description.take().or_else(|| entry.summary.clone());
    m.developer = m.developer.take().or_else(|| entry.developer.clone());
    m.publisher = m.publisher.take().or_else(|| entry.publisher.clone());
    m.year = m.year.or(entry.year);
    m.score = m.score.or(entry.score);
    if m.genres.is_empty() {
        m.genres = entry.genres.clone();
    }
    game.steam_appid = game.steam_appid.or_else(|| entry.steam_appid());
    if entry.minutes > game.playtime.unwrap_or(0) {
        game.playtime = Some(entry.minutes);
    }
    game.last_played = game.last_played.max(entry.last_played);
}

fn enrich(games: &mut [Game], g: &Galaxy) {
    for game in games {
        let exact = match game.source.as_str() {
            "steam" => game.steam_appid.and_then(|id| g.owned.get(&format!("steam_{id}"))),
            "epic" => g.owned.get(&format!("epic_{}", game.id.trim_start_matches("epic:"))),
            _ => None,
        };
        if let Some(entry) = exact.or_else(|| g.by_title(&game.title)) {
            apply_galaxy(game, entry);
        }
    }
}

/// Stores only: quick, and needs no network. Fills the screen on first launch.
pub fn scan_stores(lookups: &mut xbox::Lookups, online: bool) -> Vec<Game> {
    let galaxy = Galaxy::load();
    let g = galaxy.as_ref();
    let mut games = Vec::new();
    std::thread::scope(|s| {
        let steam = s.spawn(|| guarded("steam", || steam::scan(g)));
        let epic = s.spawn(|| guarded("epic", || epic::scan(g)));
        let small = s.spawn(|| {
            let mut v = guarded("gog", stores::gog);
            v.extend(guarded("ea", stores::ea));
            v.extend(guarded("ubisoft", stores::ubisoft));
            v.extend(guarded("rockstar", stores::rockstar));
            v.extend(guarded("riot", stores::riot));
            v.extend(guarded("battlenet", stores::battlenet));
            v.extend(guarded("amazon", stores::amazon));
            v.extend(guarded("itch", stores::itch));
            v
        });
        let xbox = guarded("xbox", || xbox::scan(g, lookups, online));
        for handle in [steam, epic, small] {
            games.extend(handle.join().unwrap_or_default());
        }
        games.extend(xbox);
    });
    dedupe(&mut games);
    if let Some(g) = g {
        enrich(&mut games, g);
    }
    games
}

/// A full pass: stores, then whatever the folder scan finds beyond them.
pub fn scan_all(settings: &Settings, lookups: &mut xbox::Lookups, online: bool) -> Vec<Game> {
    let mut games = scan_stores(lookups, online);
    let claimed: Vec<String> = games.iter().filter(|g| g.installed).flat_map(Game::run_dirs).collect();
    let shortcuts = guarded_shortcuts();
    let mut found = guarded("local", || local::scan(&claimed, &settings.scan_folders, shortcuts));
    if let Some(g) = Galaxy::load() {
        enrich(&mut found, &g);
    }
    games.extend(found);
    games
}

fn guarded_shortcuts() -> Vec<steam::Shortcut> {
    catch_unwind(steam::shortcuts).unwrap_or_default()
}

fn dedupe(games: &mut Vec<Game>) {
    let mut seen = HashSet::new();
    // Installed copies win over a same-id catalog entry.
    games.sort_by_key(|g| !g.installed);
    games.retain(|g| seen.insert(g.id.clone()));
}

/// True when two entries are one game's copies on different stores.
pub fn title_key(title: &str) -> String {
    normalize(title)
}
