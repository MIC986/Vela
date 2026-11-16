//! Online catalogs. None of these need an account or key: Steam's store API
//! identifies games and supplies art for anything sold there, and Microsoft's
//! display catalog does the same for Xbox titles and the Game Pass list.
//! Everything is cached, so each game costs its lookups only once.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::model::{ArtSources, Game, Meta};
use crate::scan::title_key;
use crate::scan::xbox::{self, Lookup};
use crate::store::{lock, now, CatalogItem, State};
use crate::titles::{same_base_game, same_game};
use crate::win;

const STEAM_ASSETS: &str = "https://shared.fastly.steamstatic.com/store_item_assets/";
const CATALOG: &str = "https://displaycatalog.mp.microsoft.com/v7.0/products";
/// Microsoft's published lists of PC titles: plan, list id and subscription product.
const GAMEPASS_PLANS: [(&str, &str, &str); 4] = [
    ("ultimate", "97c6c862-d28a-4907-a3d5-c401f2296a53", "cfq7ttc0khs0"),
    ("pc", "609d944c-d395-4c0a-9ea4-e9f39b52c1ad", "cfq7ttc0kgq8"),
    ("premium", "09a72c0d-c466-426a-9580-b78955d8173a", "cfq7ttc0p85b"),
    ("essential", "34031711-5a70-4196-bab7-45757dc2294e", "cfq7ttc0k5dj"),
];

const DAY: i64 = 86_400;

/// Tags that read as a genre. Steam's list also has moods, themes and features.
const GENRES: &[&str] = &[
    "Action", "Adventure", "RPG", "JRPG", "Action RPG", "Strategy", "Simulation", "Indie", "Casual", "Racing", "Sports", "Puzzle", "Shooter", "FPS",
    "Third-Person Shooter", "Survival", "Survival Horror", "Horror", "Platformer", "Fighting", "Open World", "Sandbox", "Roguelike", "Roguelite", "Metroidvania",
    "MMORPG", "MOBA", "Battle Royale", "City Builder", "Management", "Visual Novel", "Card Game", "Rhythm", "Stealth", "Tower Defense", "Turn-Based Strategy",
    "Grand Strategy", "Real Time Strategy", "RTS", "Soulslike", "Hack and Slash", "Party Game", "Farming Sim", "Colony Sim", "Automobile Sim", "Base Building",
    "Crafting", "Exploration", "Point & Click", "Bullet Hell", "Tactical", "Multiplayer", "Co-op",
];

pub fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(8)).timeout(Duration::from_secs(20)).user_agent("Vela/1.0").build()
}

fn get_json(agent: &ureq::Agent, url: &str) -> Option<Value> {
    agent.get(url).call().ok()?.into_json().ok()
}

fn get_json_retry(agent: &ureq::Agent, url: &str) -> Option<Value> {
    get_json(agent, url).or_else(|| {
        std::thread::sleep(Duration::from_secs(2));
        get_json(agent, url)
    })
}

/// Identifies an installed Store package. None means the question couldn't be answered.
pub fn lookup_package(family: &str) -> Option<Lookup> {
    let found = lookup_in(family, &win::region())?;
    if found.product_id.is_none() && win::region() != "US" {
        return lookup_in(family, "US");
    }
    Some(found)
}

fn lookup_in(family: &str, market: &str) -> Option<Lookup> {
    let url = format!("{CATALOG}/lookup?alternateId=PackageFamilyName&Value={family}&market={market}&languages=en-US");
    let response = agent().get(&url).call();
    let body: Value = match response {
        Ok(r) => r.into_json().ok()?,
        // The catalog doesn't know sideloaded or retired packages; that's an answer.
        Err(ureq::Error::Status(404, _)) => return Some(Lookup::default()),
        Err(_) => return None,
    };
    let products = body.get("Products")?.as_array()?;
    let Some(product) = products.first() else { return Some(Lookup::default()) };
    Some(Lookup {
        is_game: product.get("ProductKind").and_then(Value::as_str) == Some("Game"),
        product_id: product.get("ProductId").and_then(Value::as_str).map(String::from),
    })
}

fn search_steam(agent: &ureq::Agent, title: &str, loose: bool) -> Option<Option<u32>> {
    let term: String = title.chars().map(|c| if c.is_alphanumeric() { c } else { ' ' }).collect();
    let url = format!("https://store.steampowered.com/api/storesearch/?term={}&cc={}&l=en", encode(term.trim()), win::region().to_ascii_lowercase());
    read_search(&get_json(agent, &url)?, title, loose)
}

/// None means the search itself failed; Some(None) means it found nothing.
fn read_search(body: &Value, title: &str, loose: bool) -> Option<Option<u32>> {
    let items = body.get("items")?.as_array()?;
    let named = |test: &dyn Fn(&str) -> bool| {
        items.iter().find(|item| item.get("type").and_then(Value::as_str) == Some("app") && item.get("name").and_then(Value::as_str).is_some_and(test))
    };
    let found = named(&|n| same_game(n, title)).or_else(|| if loose { named(&|n| same_base_game(n, title)) } else { None });
    Some(found.and_then(|i| i.get("id")?.as_u64()).and_then(|id| u32::try_from(id).ok()))
}

fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn steam_tags(agent: &ureq::Agent) -> Option<HashMap<u32, String>> {
    let body = get_json(agent, "https://api.steampowered.com/IStoreService/GetTagList/v1/?language=english")?;
    let tags = body.get("response")?.get("tags")?.as_array()?;
    Some(tags.iter().filter_map(|t| Some((t.get("tagid")?.as_u64()? as u32, t.get("name")?.as_str()?.to_string()))).collect())
}

fn fetch_steam(agent: &ureq::Agent, ids: &[u32], tags: &HashMap<u32, String>) -> Option<Vec<(u32, CatalogItem)>> {
    let request = json!({
        "ids": ids.iter().map(|id| json!({"appid": id})).collect::<Vec<_>>(),
        "context": {"language": "english", "country_code": "US"},
        "data_request": {
            "include_assets": true, "include_basic_info": true, "include_release": true,
            "include_tag_count": 12, "include_reviews": true, "include_screenshots": true
        }
    });
    let url = format!("https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json={}", encode(&request.to_string()));
    let body = get_json_retry(agent, &url)?;
    let items = body.get("response")?.get("store_items")?.as_array()?;
    Some(items.iter().filter_map(|i| read_steam_item(i, tags)).collect())
}

fn read_steam_item(item: &Value, tags: &HashMap<u32, String>) -> Option<(u32, CatalogItem)> {
    let id = item.get("appid")?.as_u64()? as u32;
    let names = |key: &str| -> Option<String> { item.get("basic_info")?.get(key)?.as_array()?.first()?.get("name")?.as_str().map(String::from) };
    let assets = item.get("assets");
    let format = assets.and_then(|a| a.get("asset_url_format")).and_then(Value::as_str).unwrap_or_default();
    let asset = |keys: &[&str]| -> Vec<String> {
        keys.iter()
            .filter_map(|k| assets?.get(*k)?.as_str())
            .map(|file| format!("{STEAM_ASSETS}{}", format.replace("${FILENAME}", file)))
            .collect()
    };
    let genres: Vec<String> = item
        .get("tagids")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(|t| tags.get(&(t.as_u64()? as u32))).filter(|t| GENRES.contains(&t.as_str())).take(4).cloned().collect())
        .unwrap_or_default();
    let shots = item.get("screenshots").map(|s| {
        ["all_ages_screenshots", "mature_content_screenshots"]
            .iter()
            .flat_map(|k| s.get(*k).and_then(Value::as_array).cloned().unwrap_or_default())
            .filter_map(|e| e.get("filename")?.as_str().map(|f| format!("{STEAM_ASSETS}{f}")))
            .take(12)
            .collect::<Vec<_>>()
    });
    let meta = Meta {
        description: item.get("basic_info").and_then(|b| b.get("short_description")).and_then(Value::as_str).map(String::from),
        developer: names("developers"),
        publisher: names("publishers"),
        year: item.get("release").and_then(|r| r.get("steam_release_date")).and_then(Value::as_i64).filter(|t| *t > 0).map(crate::scan::galaxy::unix_year),
        genres,
        score: item.get("reviews").and_then(|r| r.get("summary_filtered")).and_then(|s| s.get("percent_positive")).and_then(Value::as_u64).map(|p| p as u8),
        screenshots: shots.unwrap_or_default(),
    };
    let art = ArtSources {
        cover: asset(&["library_capsule_2x", "library_capsule"]),
        hero: asset(&["library_hero_2x", "library_hero", "page_background", "header_2x", "header"]),
        logo: asset(&["library_logo_2x", "library_logo"]),
    };
    Some((id, CatalogItem { title: item.get("name").and_then(Value::as_str).map(String::from), meta, art, fetched: now() }))
}

type MsProduct = (String, CatalogItem, Option<String>, bool);

/// Asks in this PC's country first. A product sold only elsewhere is looked up in the US.
fn fetch_microsoft(agent: &ureq::Agent, ids: &[String]) -> Option<Vec<MsProduct>> {
    let market = win::region();
    let mut found = fetch_microsoft_in(agent, ids, &market)?;
    if market != "US" {
        let missing: Vec<String> = ids.iter().filter(|id| !found.iter().any(|f| f.0.eq_ignore_ascii_case(id))).cloned().collect();
        if !missing.is_empty() {
            found.extend(fetch_microsoft_in(agent, &missing, "US").unwrap_or_default());
        }
    }
    Some(found)
}

fn fetch_microsoft_in(agent: &ureq::Agent, ids: &[String], market: &str) -> Option<Vec<MsProduct>> {
    let url = format!("{CATALOG}?bigIds={}&market={market}&languages=en-US&MS-CV=DGU1mcuYo0WMMp+F.1", ids.join(","));
    let body = get_json_retry(agent, &url)?;
    let products = body.get("Products")?.as_array()?;
    Some(products.iter().filter_map(read_ms_product).collect())
}

fn read_ms_product(product: &Value) -> Option<MsProduct> {
    let id = product.get("ProductId")?.as_str()?.to_string();
    let local = product.get("LocalizedProperties")?.as_array()?.first()?;
    let text = |k: &str| local.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let images: Vec<(&str, String)> = local
        .get("Images")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|i| Some((i.get("ImagePurpose")?.as_str()?, format!("https:{}", i.get("Uri")?.as_str()?))))
                .collect()
        })
        .unwrap_or_default();
    let pick = |purposes: &[&str]| -> Vec<String> {
        purposes.iter().flat_map(|p| images.iter().filter(move |(k, _)| k == p).map(|(_, u)| u.clone())).collect()
    };
    let properties = product.get("Properties");
    let release = product
        .get("MarketProperties")
        .and_then(Value::as_array)
        .and_then(|m| m.first())
        .and_then(|m| m.get("OriginalReleaseDate"))
        .and_then(Value::as_str)
        .and_then(|d| d.get(..4))
        .and_then(|y| y.parse::<i32>().ok())
        .filter(|y| *y > 1970 && *y < 2100);
    let genres: Vec<String> = properties
        .and_then(|p| p.get("Categories"))
        .and_then(Value::as_array)
        .map(|c| c.iter().filter_map(Value::as_str).map(String::from).collect())
        .filter(|c: &Vec<String>| !c.is_empty())
        .or_else(|| properties.and_then(|p| p.get("Category")).and_then(Value::as_str).map(|c| vec![c.to_string()]))
        .unwrap_or_default();
    let meta = Meta {
        description: text("ShortDescription").or_else(|| text("ProductDescription")),
        developer: text("DeveloperName"),
        publisher: text("PublisherName"),
        year: release,
        genres: genres.into_iter().take(4).collect(),
        score: None,
        screenshots: pick(&["Screenshot"]).into_iter().take(12).map(|u| format!("{u}?w=1600&q=85")).collect(),
    };
    let art = ArtSources {
        cover: pick(&["Poster", "BoxArt", "BrandedKeyArt"]),
        hero: pick(&["SuperHeroArt", "TitledHeroArt", "ImageGallery"]),
        logo: Vec::new(),
    };
    let family = properties.and_then(|p| p.get("PackageFamilyName")).and_then(Value::as_str).map(String::from);
    let is_game = product.get("ProductKind").and_then(Value::as_str) == Some("Game");
    let title = text("ProductTitle");
    Some((id, CatalogItem { title, meta, art, fetched: now() }, family, is_game))
}

/// Each plan's PC list in one country, or None if any of them can't be had there.
fn fetch_plans(agent: &ureq::Agent, market: &str) -> Option<HashMap<String, HashSet<String>>> {
    let mut plans = HashMap::new();
    for (plan, list, subscription) in GAMEPASS_PLANS {
        let url = format!("https://catalog.gamepass.com/sigls/v3?id={list}&language=en-us&market={market}&platformContext=pc&subscriptionContext={subscription}");
        let list = get_json(agent, &url)?.as_array()?.clone();
        let included: HashSet<String> = list.iter().filter_map(|e| e.get("id")?.as_str().map(String::from)).collect();
        if included.is_empty() {
            return None;
        }
        plans.insert(plan.to_string(), included);
    }
    Some(plans)
}

/// Refreshes the Game Pass lists once a day. One that fails keeps yesterday's lists.
fn refresh_gamepass(agent: &ureq::Agent, state: &State) -> bool {
    {
        let cache = lock(&state.cache);
        if now() - cache.gamepass_fetched < DAY && !cache.plans.is_empty() {
            return false;
        }
    }
    let market = win::region();
    let Some(plans) = fetch_plans(agent, &market).or_else(|| if market == "US" { None } else { fetch_plans(agent, "US") }) else { return false };
    let ids: Vec<String> = plans.values().flatten().cloned().collect::<HashSet<_>>().into_iter().collect();
    let mut games = Vec::with_capacity(ids.len());
    let mut items = Vec::new();
    for chunk in ids.chunks(20) {
        for (id, item, family, is_game) in fetch_microsoft(agent, chunk).unwrap_or_default() {
            let Some(title) = item.title.clone().filter(|_| is_game) else { continue };
            let mut game = Game::new(format!("xbox:{id}"), title, "xbox");
            game.gamepass = true;
            game.store_id = Some(id.clone());
            game.pfn = family;
            game.install = Some(xbox::store_page(&id));
            games.push(game);
            items.push((id, item));
        }
    }
    if games.is_empty() {
        return false;
    }
    let mut cache = lock(&state.cache);
    cache.gamepass = games;
    cache.plans = plans;
    cache.gamepass_fetched = now();
    cache.microsoft.extend(items);
    true
}

fn publish(app: &AppHandle, state: &State) {
    state.rebuild();
    state.save_cache();
    let _ = app.emit("library-updated", ());
}

/// One pass over everything still missing catalog data.
pub fn refresh(app: &AppHandle) {
    let state = app.state::<State>();
    let settings = lock(&state.settings).clone();
    if !settings.online() {
        return;
    }
    let agent = agent();

    if refresh_gamepass(&agent, &state) {
        publish(app, &state);
    }

    if lock(&state.cache).tags.is_empty() {
        if let Some(tags) = steam_tags(&agent) {
            lock(&state.cache).tags = tags;
        }
    }

    // Identify games from other stores and loose folders by title.
    let pending: Vec<(String, bool)> = {
        let games = lock(&state.games);
        let cache = lock(&state.cache);
        let mut seen = HashSet::new();
        games
            .iter()
            .filter(|g| g.source != "steam" && g.steam_appid.is_none() && !(g.gamepass && !g.installed))
            .filter(|g| match cache.search.get(&title_key(&g.title)) {
                Some((None, at)) => now() - at > 14 * DAY,
                Some((Some(_), _)) => false,
                None => true,
            })
            .filter(|g| seen.insert(title_key(&g.title)))
            .map(|g| (g.title.clone(), g.source == "local"))
            .collect()
    };
    for (i, (title, loose)) in pending.iter().enumerate() {
        if let Some(found) = search_steam(&agent, title, *loose) {
            lock(&state.cache).search.insert(title_key(title), (found, now()));
        }
        // Steam's store search is rate limited to a couple of hundred calls per few minutes.
        std::thread::sleep(Duration::from_millis(350));
        if (i + 1) % 25 == 0 {
            publish(app, &state);
        }
    }
    if !pending.is_empty() {
        publish(app, &state);
    }

    // Fetch Steam entries in batches.
    let steam_ids: Vec<u32> = {
        let games = lock(&state.games);
        let cache = lock(&state.cache);
        let mut ids: Vec<u32> = games
            .iter()
            .filter_map(|g| g.steam_appid)
            .filter(|id| cache.steam.get(id).is_none_or(|i| now() - i.fetched > 30 * DAY))
            .collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    };
    let tags = lock(&state.cache).tags.clone();
    for chunk in steam_ids.chunks(30) {
        if let Some(items) = fetch_steam(&agent, chunk, &tags) {
            lock(&state.cache).steam.extend(items);
            publish(app, &state);
        }
    }

    // And Microsoft's.
    let ms_ids: Vec<String> = {
        let games = lock(&state.games);
        let cache = lock(&state.cache);
        let mut ids: Vec<String> = games
            .iter()
            .filter_map(|g| g.store_id.clone())
            .filter(|id| cache.microsoft.get(id).is_none_or(|i| now() - i.fetched > 30 * DAY))
            .collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    };
    for chunk in ms_ids.chunks(20) {
        if let Some(items) = fetch_microsoft(&agent, chunk) {
            lock(&state.cache).microsoft.extend(items.into_iter().map(|(id, item, _, _)| (id, item)));
            publish(app, &state);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steam_item_reads_hashed_assets_and_filters_tags() {
        let tags: HashMap<u32, String> = [(19, "Action".to_string()), (4115, "Cyberpunk".to_string())].into();
        let item = json!({
            "appid": 10, "name": "Game",
            "assets": {"asset_url_format": "steam/apps/10/${FILENAME}?t=1", "library_capsule_2x": "h/c.jpg", "library_hero": "h/hero.jpg"},
            "tagids": [4115, 19],
            "reviews": {"summary_filtered": {"percent_positive": 87}},
            "basic_info": {"developers": [{"name": "Dev"}]}
        });
        let (id, parsed) = read_steam_item(&item, &tags).unwrap();
        assert_eq!(id, 10);
        assert_eq!(parsed.art.cover, vec![format!("{STEAM_ASSETS}steam/apps/10/h/c.jpg?t=1")]);
        assert_eq!(parsed.meta.genres, vec!["Action".to_string()]);
        assert_eq!(parsed.meta.score, Some(87));
        assert_eq!(parsed.meta.developer.as_deref(), Some("Dev"));
    }

    #[test]
    fn microsoft_product_maps_images_by_purpose() {
        let product = json!({
            "ProductId": "9ABC", "ProductKind": "Game",
            "LocalizedProperties": [{"ProductTitle": "T", "PublisherName": " P ", "Images": [
                {"ImagePurpose": "Screenshot", "Uri": "//x/s"},
                {"ImagePurpose": "Poster", "Uri": "//x/p"},
                {"ImagePurpose": "SuperHeroArt", "Uri": "//x/h"}
            ]}],
            "Properties": {"PackageFamilyName": "fam", "Category": "Action"},
            "MarketProperties": [{"OriginalReleaseDate": "2024-05-01T00:00:00Z"}]
        });
        let (id, item, family, is_game) = read_ms_product(&product).unwrap();
        assert!(is_game);
        assert_eq!((id.as_str(), family.as_deref()), ("9ABC", Some("fam")));
        assert_eq!(item.art.cover, vec!["https://x/p"]);
        assert_eq!(item.art.hero, vec!["https://x/h"]);
        assert_eq!(item.meta.year, Some(2024));
        assert_eq!(item.meta.publisher.as_deref(), Some("P"));
    }

    #[test]
    fn a_failed_search_is_not_an_empty_one() {
        let found = json!({"items": [{"type": "app", "name": "Portal 2", "id": 620}]});
        assert_eq!(read_search(&found, "Portal 2", false), Some(Some(620)));
        assert_eq!(read_search(&json!({"items": []}), "Portal 2", false), Some(None), "nothing there is an answer");
        assert_eq!(read_search(&json!({"error": "busy"}), "Portal 2", false), None, "no answer must not be remembered as a miss");
    }

    #[test]
    fn encode_escapes_json() {
        assert_eq!(encode("a b\"{"), "a%20b%22%7B");
    }
}
