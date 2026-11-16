//! Shared state and everything Vela keeps on disk under %LOCALAPPDATA%\com.vela.launcher.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::model::{ArtSources, Game, GameDetail, GameView, Meta, Settings, UserData, Variant};
use crate::scan::title_key;
use crate::scan::xbox::Lookups;

pub fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf29ce484222325, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3))
}

pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Details fetched from a store catalog.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CatalogItem {
    pub title: Option<String>,
    pub meta: Meta,
    pub art: ArtSources,
    pub fetched: i64,
}

/// Raised when catalog entries need fetching again, as when their fields change meaning.
const CACHE_VERSION: u32 = 2;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Cache {
    pub version: u32,
    /// Normalized title to Steam app id; None records a search that found nothing.
    pub search: HashMap<String, (Option<u32>, i64)>,
    pub steam: HashMap<u32, CatalogItem>,
    pub microsoft: HashMap<String, CatalogItem>,
    pub lookups: Lookups,
    pub tags: HashMap<u32, String>,
    pub gamepass: Vec<Game>,
    /// Plan name to the product ids it includes on PC.
    pub plans: HashMap<String, HashSet<String>>,
    pub gamepass_fetched: i64,
}

/// The ids of some Game Pass titles, for telling whether a game is one of them.
struct PassList<'a> {
    products: HashSet<&'a str>,
    families: HashSet<&'a str>,
}

impl<'a> PassList<'a> {
    fn new(games: &[&'a Game]) -> PassList<'a> {
        PassList {
            products: games.iter().filter_map(|g| g.store_id.as_deref()).collect(),
            families: games.iter().filter_map(|g| g.pfn.as_deref()).collect(),
        }
    }

    fn has(&self, game: &Game) -> bool {
        game.store_id.as_deref().is_some_and(|p| self.products.contains(p)) || game.pfn.as_deref().is_some_and(|p| self.families.contains(p))
    }
}

/// The catalog games the user's plan includes; none while Game Pass is off.
fn plan_games<'a>(cache: &'a Cache, settings: &Settings) -> Vec<&'a Game> {
    let Some(plan) = cache.plans.get(&settings.gamepass_plan).filter(|_| settings.gamepass_on) else { return Vec::new() };
    cache.gamepass.iter().filter(|g| g.store_id.as_ref().is_some_and(|id| plan.contains(id))).collect()
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Change {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

pub enum ScanRequest {
    Quick,
    Full,
}

pub struct State {
    pub dir: PathBuf,
    pub settings: Mutex<Settings>,
    pub user: Mutex<UserData>,
    pub cache: Mutex<Cache>,
    /// What the last scan found, before catalog data is laid over it.
    pub scanned: Mutex<Vec<Game>>,
    pub games: Mutex<Vec<Arc<Game>>>,
    /// Whether an Xbox game on this PC is on any Game Pass plan.
    pass_installed: AtomicBool,
    /// The same games by id; artwork looks one up for every image it serves.
    index: Mutex<HashMap<String, Arc<Game>>>,
    pub scanning: Mutex<bool>,
    pub scans: Mutex<Option<Sender<ScanRequest>>>,
    pub session: Mutex<Option<crate::launch::Session>>,
    pub last_session: Mutex<Option<crate::launch::Finished>>,
}

/// Locks a mutex, carrying on if a panicking thread left it poisoned: all state
/// here is plain data that stays valid between writes.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn load<T: DeserializeOwned + Default>(path: &Path) -> T {
    fs::read(path).ok().and_then(|d| serde_json::from_slice(&d).ok()).unwrap_or_default()
}

/// Writes through a temporary file so a crash can't leave half a file behind.
fn save<T: Serialize>(path: &Path, value: &T) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let Ok(bytes) = serde_json::to_vec(value) else { return };
    let tmp = path.with_extension(format!("{}.tmp", NEXT.fetch_add(1, Ordering::Relaxed)));
    if fs::write(&tmp, bytes).is_ok() {
        let _ = fs::rename(&tmp, path);
    }
}

/// Named after the app's identifier, apart from where the installer puts the program,
/// so the uninstaller's "delete app data" choice finds it.
const DATA_FOLDER: &str = "com.vela.launcher";

/// Brings data over from the folder older versions used, once.
fn move_data(old: &Path, new: &Path) {
    if new.join("settings.json").exists() || !old.join("settings.json").exists() {
        return;
    }
    let _ = fs::create_dir_all(new);
    for name in ["settings.json", "user.json", "library.json", "cache.json", "art", "custom"] {
        let _ = fs::rename(old.join(name), new.join(name));
    }
    // Pictures the user chose are kept by full path, which just changed.
    let path = new.join("user.json");
    let mut user: UserData = load(&path);
    let (from, to) = (old.to_string_lossy().into_owned(), new.to_string_lossy().into_owned());
    for look in user.looks.values_mut() {
        for slot in [&mut look.cover, &mut look.hero, &mut look.logo] {
            if let Some(file) = slot.as_mut().filter(|f| f.starts_with(&from)) {
                *file = file.replacen(&from, &to, 1);
            }
        }
    }
    save(&path, &user);
}

impl State {
    pub fn load() -> State {
        let base = std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
        // VELA_DATA_DIR keeps automated test runs away from the real library data.
        let dir = std::env::var("VELA_DATA_DIR").map(PathBuf::from).unwrap_or_else(|_| {
            let dir = base.join(DATA_FOLDER);
            move_data(&base.join("Vela"), &dir);
            dir
        });
        let _ = fs::create_dir_all(dir.join("art"));
        let scanned: Vec<Game> = load(&dir.join("library.json"));
        let mut cache: Cache = load(&dir.join("cache.json"));
        if cache.version < CACHE_VERSION {
            cache.version = CACHE_VERSION;
            cache.steam.values_mut().for_each(|item| item.fetched = 0);
        }
        let state = State {
            settings: Mutex::new(load(&dir.join("settings.json"))),
            user: Mutex::new(load(&dir.join("user.json"))),
            cache: Mutex::new(cache),
            scanned: Mutex::new(scanned),
            games: Mutex::new(Vec::new()),
            pass_installed: AtomicBool::new(false),
            index: Mutex::new(HashMap::new()),
            scanning: Mutex::new(false),
            scans: Mutex::new(None),
            session: Mutex::new(None),
            last_session: Mutex::new(None),
            dir,
        };
        state.rebuild();
        state
    }

    pub fn save_settings(&self) {
        save(&self.dir.join("settings.json"), &*lock(&self.settings));
    }

    pub fn save_user(&self) {
        save(&self.dir.join("user.json"), &*lock(&self.user));
    }

    pub fn save_cache(&self) {
        save(&self.dir.join("cache.json"), &*lock(&self.cache));
    }

    pub fn save_library(&self) {
        save(&self.dir.join("library.json"), &*lock(&self.scanned));
    }

    pub fn request_scan(&self, request: ScanRequest) {
        if let Some(tx) = lock(&self.scans).as_ref() {
            let _ = tx.send(request);
        }
    }

    pub fn game(&self, id: &str) -> Option<Arc<Game>> {
        lock(&self.index).get(id).cloned()
    }

    /// Lays catalogs, Game Pass and the user's own additions over the scan results.
    pub fn rebuild(&self) -> Change {
        let scanned = lock(&self.scanned).clone();
        let (custom, busts, looks) = {
            let user = lock(&self.user);
            (user.custom.clone(), user.art_bust.clone(), user.looks.clone())
        };
        let settings = lock(&self.settings).clone();

        let mut out: Vec<Game> = Vec::with_capacity(scanned.len());
        {
            // Held for the whole merge, and released before `games` is touched:
            // catalog refreshes take those two locks the other way around.
            let cache = lock(&self.cache);
            let listed = PassList::new(&cache.gamepass.iter().collect::<Vec<_>>());
            let included = plan_games(&cache, &settings);
            let mine = PassList::new(&included);

            let mut ids = HashSet::new();
            for game in scanned.into_iter().chain(custom) {
                if ids.insert(game.id.clone()) {
                    out.push(game);
                }
            }
            for game in out.iter_mut().filter(|g| g.source == "xbox") {
                game.store_id = game.store_id.take().or_else(|| game.pfn.as_ref().and_then(|p| cache.lookups.get(p)).and_then(|l| l.product_id.clone()));
            }
            self.pass_installed.store(out.iter().any(|g| g.installed && g.source == "xbox" && listed.has(g)), Ordering::Relaxed);
            let installed_families: HashSet<String> = out.iter().filter(|g| g.installed).filter_map(|g| g.pfn.clone()).collect();
            for game in included {
                let on_disk = game.pfn.as_ref().is_some_and(|p| installed_families.contains(p));
                if !on_disk && ids.insert(game.id.clone()) {
                    out.push(game.clone());
                }
            }
            for game in &mut out {
                if game.source == "xbox" {
                    game.gamepass = mine.has(game);
                }
                overlay(game, &cache);
            }
        }
        share_between_copies(&mut out);
        for game in &mut out {
            if let Some(look) = looks.get(&title_key(&game.title)) {
                look.apply_art(&mut game.art);
            }
            let bust = busts.get(&game.id).copied().unwrap_or(0);
            game.art_rev = (fnv(&format!("{:?}{bust}", game.art)) & 0xffff_ffff) as u32;
        }

        let list: Vec<Arc<Game>> = out.into_iter().map(Arc::new).collect();
        let index = list.iter().map(|g| (g.id.clone(), g.clone())).collect();
        let mut games = lock(&self.games);
        let before: HashSet<&str> = games.iter().filter(|g| g.installed).map(|g| g.title.as_str()).collect();
        let after: HashSet<&str> = list.iter().filter(|g| g.installed).map(|g| g.title.as_str()).collect();
        let change = if before.is_empty() {
            Change::default()
        } else {
            let names = |a: &HashSet<&str>, b: &HashSet<&str>| a.difference(b).map(|t| t.to_string()).collect();
            Change { added: names(&after, &before), removed: names(&before, &after) }
        };
        *games = list;
        *lock(&self.index) = index;
        change
    }

    /// Only someone with a Game Pass game on this PC is asked whether they subscribe.
    pub fn asks_about_pass(&self) -> bool {
        !lock(&self.settings).gamepass_asked && self.pass_installed.load(Ordering::Relaxed)
    }

    pub fn views(&self) -> Vec<GameView> {
        let games = lock(&self.games);
        let settings = lock(&self.settings).clone();
        let user = lock(&self.user);
        let favorites: HashSet<&String> = user.favorites.iter().collect();
        let hidden: HashSet<&String> = user.hidden.iter().collect();

        // Copies of one game on several stores share a tile.
        let mut groups: HashMap<String, Vec<&Game>> = HashMap::new();
        for game in games.iter() {
            groups.entry(title_key(&game.title)).or_default().push(game.as_ref());
        }
        let mut views = Vec::with_capacity(groups.len());
        for (key, copies) in groups.iter_mut() {
            copies.sort_by_cached_key(|g| {
                let last = effective_last_played(g, &user);
                (!g.installed, std::cmp::Reverse(last), source_rank(&g.source))
            });
            let primary = copies[0];
            if copies.iter().any(|g| hidden.contains(&g.id)) {
                continue;
            }
            let installed = copies.iter().any(|g| g.installed);
            let store_owned = copies.iter().any(|g| !(g.gamepass && !g.installed));
            if !installed && (!settings.show_uninstalled || (!settings.gamepass_on && !store_owned)) {
                continue;
            }
            let played_secs: u64 = copies.iter().filter_map(|g| user.played.get(&g.id)).sum();
            let store_minutes: u64 = copies.iter().filter_map(|g| g.playtime).sum();
            let look = user.looks.get(key);
            let collections = user.collections.iter().filter(|c| c.games.contains(key)).map(|c| c.name.clone()).collect();
            views.push(GameView {
                id: primary.id.clone(),
                title: look.and_then(|l| l.title.clone()).unwrap_or_else(|| primary.title.clone()),
                source: primary.source.clone(),
                installed,
                gamepass: copies.iter().any(|g| g.gamepass),
                favorite: copies.iter().any(|g| favorites.contains(&g.id)),
                size: primary.size,
                last_played: copies.iter().filter_map(|g| effective_last_played(g, &user)).max(),
                playtime: store_minutes + played_secs / 60,
                added: copies.iter().filter_map(|g| user.first_seen.get(&g.id).copied()).min(),
                year: primary.meta.year,
                developer: primary.meta.developer.clone(),
                publisher: primary.meta.publisher.clone(),
                genres: primary.meta.genres.clone(),
                score: primary.meta.score,
                progress: copies.iter().find_map(|g| g.progress),
                has_install: copies.iter().any(|g| g.install.is_some()),
                variants: copies.iter().map(|g| Variant { id: g.id.clone(), source: g.source.clone(), installed: g.installed }).collect(),
                art_rev: primary.art_rev,
                customized: look.is_some(),
                can_uninstall: copies.iter().any(|g| g.installed && (g.uninstall.is_some() || (g.source == "xbox" && g.pfn.is_some()))),
                collections,
            });
        }
        views
    }

    pub fn detail(&self, id: &str) -> Option<GameDetail> {
        let game = self.game(id)?;
        let user = lock(&self.user);
        Some(GameDetail {
            id: game.id.clone(),
            title: game.title.clone(),
            description: game.meta.description.clone(),
            screenshots: game.meta.screenshots.clone(),
            install_dir: game.install_dir.clone(),
            can_uninstall: game.uninstall.is_some() || (game.source == "xbox" && game.pfn.is_some()),
            hidden: user.hidden.contains(&game.id),
        })
    }

    /// The name to show for a game: the user's, if they gave it one.
    pub fn shown_title(&self, game: &Game) -> String {
        lock(&self.user).looks.get(&title_key(&game.title)).and_then(|l| l.title.clone()).unwrap_or_else(|| game.title.clone())
    }

    /// All ids sharing a tile with `id`.
    pub fn copies_of(&self, id: &str) -> Vec<String> {
        let games = lock(&self.games);
        let Some(key) = games.iter().find(|g| g.id == id).map(|g| title_key(&g.title)) else { return vec![id.to_string()] };
        games.iter().filter(|g| title_key(&g.title) == key).map(|g| g.id.clone()).collect()
    }
}

fn effective_last_played(game: &Game, user: &UserData) -> Option<i64> {
    game.last_played.max(user.last_played.get(&game.id).copied())
}

fn source_rank(source: &str) -> u8 {
    match source {
        "steam" => 0,
        "epic" => 1,
        "gog" => 2,
        "xbox" => 3,
        "ea" | "ubisoft" | "rockstar" | "battlenet" | "riot" => 4,
        "amazon" | "itch" => 5,
        _ => 6,
    }
}

/// Catalog art goes first for what it does best: a store's own art for its own
/// games, Steam's library art for everything it can identify.
fn overlay(game: &mut Game, cache: &Cache) {
    if game.steam_appid.is_none() && game.source != "steam" {
        game.steam_appid = cache.search.get(&title_key(&game.title)).and_then(|(id, _)| *id);
    }
    let microsoft = game.store_id.as_ref().and_then(|p| cache.microsoft.get(p));
    let steam = game.steam_appid.and_then(|id| cache.steam.get(&id));
    let (first, second) = if game.source == "xbox" { (microsoft, steam) } else { (steam, microsoft) };

    for item in [second, first].into_iter().flatten() {
        prepend(&mut game.art.cover, &item.art.cover);
        prepend(&mut game.art.hero, &item.art.hero);
        prepend(&mut game.art.logo, &item.art.logo);
    }
    for item in [first, second].into_iter().flatten() {
        let (m, c) = (&mut game.meta, &item.meta);
        // Catalog text beats Galaxy's and the scanners' rough fields.
        m.description = c.description.clone().or(m.description.take());
        m.developer = c.developer.clone().or(m.developer.take());
        m.publisher = c.publisher.clone().or(m.publisher.take());
        m.year = c.year.or(m.year);
        m.score = c.score.or(m.score);
        if !c.genres.is_empty() {
            m.genres = c.genres.clone();
        }
        if m.screenshots.is_empty() {
            m.screenshots = c.screenshots.clone();
        }
    }
    // Loose folders rarely carry the exact name; the catalog's is the real one.
    if game.source == "local" {
        if let Some(title) = steam.and_then(|s| s.title.clone()) {
            game.title = title;
        }
    }
}

/// Copies of one game fill each other's gaps: Riot has no artwork of its own, but
/// the same title on Xbox does.
fn share_between_copies(games: &mut [Game]) {
    let mut pooled: HashMap<String, (ArtSources, Meta)> = HashMap::new();
    for game in games.iter() {
        let (art, meta) = pooled.entry(title_key(&game.title)).or_default();
        if art.cover.is_empty() {
            art.cover = game.art.cover.clone();
        }
        if art.hero.is_empty() {
            art.hero = game.art.hero.clone();
        }
        if art.logo.is_empty() {
            art.logo = game.art.logo.clone();
        }
        meta.description = meta.description.take().or_else(|| game.meta.description.clone());
        meta.developer = meta.developer.take().or_else(|| game.meta.developer.clone());
        meta.publisher = meta.publisher.take().or_else(|| game.meta.publisher.clone());
        meta.year = meta.year.or(game.meta.year);
        meta.score = meta.score.or(game.meta.score);
        if meta.genres.is_empty() {
            meta.genres = game.meta.genres.clone();
        }
        if meta.screenshots.is_empty() {
            meta.screenshots = game.meta.screenshots.clone();
        }
    }
    for game in games.iter_mut() {
        let Some((art, meta)) = pooled.get(&title_key(&game.title)) else { continue };
        if game.art.cover.is_empty() {
            game.art.cover = art.cover.clone();
        }
        if game.art.hero.is_empty() {
            game.art.hero = art.hero.clone();
        }
        if game.art.logo.is_empty() {
            game.art.logo = art.logo.clone();
        }
        let m = &mut game.meta;
        m.description = m.description.take().or_else(|| meta.description.clone());
        m.developer = m.developer.take().or_else(|| meta.developer.clone());
        m.publisher = m.publisher.take().or_else(|| meta.publisher.clone());
        m.year = m.year.or(meta.year);
        m.score = m.score.or(meta.score);
        if m.genres.is_empty() {
            m.genres = meta.genres.clone();
        }
        if m.screenshots.is_empty() {
            m.screenshots = meta.screenshots.clone();
        }
    }
}

fn prepend(list: &mut Vec<String>, items: &[String]) {
    let rest = std::mem::take(list);
    let mut merged: Vec<String> = items.to_vec();
    merged.extend(rest.into_iter().filter(|s| !items.contains(s)));
    *list = merged;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> Cache {
        let mut cache = Cache::default();
        for id in ["A", "B"] {
            let mut game = Game::new(format!("xbox:{id}"), id, "xbox");
            game.store_id = Some(id.into());
            cache.gamepass.push(game);
        }
        cache.plans.insert("ultimate".into(), HashSet::from(["A".to_string(), "B".to_string()]));
        cache.plans.insert("essential".into(), HashSet::from(["A".to_string()]));
        cache
    }

    #[test]
    fn data_moves_over_once_and_chosen_pictures_follow() {
        let root = std::env::temp_dir().join(format!("vela-move-{}", std::process::id()));
        let (old, new) = (root.join("Vela"), root.join(DATA_FOLDER));
        fs::create_dir_all(old.join("custom")).unwrap();
        fs::write(old.join("settings.json"), "{}").unwrap();
        fs::write(old.join("custom").join("cover"), "x").unwrap();
        let mut user = UserData::default();
        let cover = old.join("custom").join("cover").to_string_lossy().into_owned();
        user.looks.insert("game".into(), crate::model::Look { cover: Some(cover), ..Default::default() });
        save(&old.join("user.json"), &user);
        fs::write(old.join("Vela.exe"), "program").unwrap();

        move_data(&old, &new);
        let moved: UserData = load(&new.join("user.json"));
        let cover = moved.looks["game"].cover.clone().unwrap();
        assert!(new.join("settings.json").exists() && !old.join("settings.json").exists());
        assert!(cover.starts_with(&*new.to_string_lossy()) && Path::new(&cover).exists());
        assert!(old.join("Vela.exe").exists(), "the program itself stays put");

        // A second start finds the new folder and leaves everything alone.
        fs::write(old.join("settings.json"), "{\"stale\":true}").unwrap();
        move_data(&old, &new);
        assert_eq!(fs::read_to_string(new.join("settings.json")).unwrap(), "{}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_plan_brings_only_its_own_games() {
        let cache = catalog();
        let settings = Settings { gamepass_on: true, gamepass_plan: "essential".into(), ..Settings::default() };
        let included = plan_games(&cache, &settings);
        assert_eq!(included.iter().map(|g| g.title.as_str()).collect::<Vec<_>>(), ["A"]);
        let settings = Settings { gamepass_on: true, ..Settings::default() };
        assert_eq!(plan_games(&cache, &settings).len(), 2);
    }

    #[test]
    fn game_pass_off_brings_nothing_in() {
        let cache = catalog();
        assert!(plan_games(&cache, &Settings::default()).is_empty());
    }

    #[test]
    fn a_game_on_a_list_is_found_by_either_id() {
        let cache = catalog();
        let games: Vec<&Game> = cache.gamepass.iter().collect();
        let mut listed = games[0].clone();
        listed.pfn = Some("family".into());
        let list = PassList::new(&[&listed]);
        let mut by_family = Game::new("xbox:family", "A", "xbox");
        by_family.pfn = Some("family".into());
        assert!(list.has(&by_family));
        assert!(!list.has(games[1]));
    }
}
