//! GOG Galaxy's local database. Galaxy aggregates the libraries of connected
//! platforms, so besides GOG itself it is the best local record of what a user
//! owns on Steam, Epic and Xbox, including metadata and playtime.

use std::collections::HashMap;

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::titles::normalize;

#[derive(Clone, Debug, Default)]
pub struct Entry {
    pub key: String,
    pub title: String,
    pub cover: Option<String>,
    pub hero: Option<String>,
    pub logo: Option<String>,
    pub summary: Option<String>,
    pub developer: Option<String>,
    pub publisher: Option<String>,
    pub genres: Vec<String>,
    pub score: Option<u8>,
    pub year: Option<i32>,
    pub releases: Vec<String>,
    pub minutes: u64,
    pub last_played: Option<i64>,
}

impl Entry {
    /// Finds this game's id on another platform, such as "steam" or "winstore".
    pub fn release_on(&self, platform: &str) -> Option<&str> {
        let prefix = format!("{platform}_");
        self.releases.iter().find_map(|r| r.strip_prefix(&prefix))
    }

    pub fn steam_appid(&self) -> Option<u32> {
        self.release_on("steam").and_then(|id| id.parse().ok())
    }
}

#[derive(Default)]
pub struct Galaxy {
    pub owned: HashMap<String, Entry>,
    by_title: HashMap<String, String>,
}

impl Galaxy {
    pub fn load() -> Option<Galaxy> {
        let program_data = std::env::var("ProgramData").ok()?;
        let path = format!("{program_data}/GOG.com/Galaxy/storage/galaxy-2.0.db").replace('\\', "/");
        if !std::path::Path::new(&path).exists() {
            return None;
        }
        // immutable: Galaxy may hold the file open, and Vela only ever reads it.
        let uri = format!("file:{path}?mode=ro&immutable=1");
        let db = Connection::open_with_flags(uri, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI).ok()?;
        read(&db).ok()
    }

    pub fn by_title(&self, title: &str) -> Option<&Entry> {
        self.by_title.get(&normalize(title)).and_then(|k| self.owned.get(k))
    }
}

fn read(db: &Connection) -> rusqlite::Result<Galaxy> {
    let mut owned: HashMap<String, Entry> = HashMap::new();
    let mut stmt = db.prepare("SELECT DISTINCT releaseKey FROM LibraryReleases")?;
    for key in stmt.query_map([], |r| r.get::<_, String>(0))? {
        let key = key?;
        owned.insert(key.clone(), Entry { key, ..Default::default() });
    }

    let mut stmt = db.prepare(
        "SELECT gp.releaseKey, t.type, gp.value FROM GamePieces gp
         JOIN GamePieceTypes t ON t.id = gp.gamePieceTypeId
         WHERE t.type IN ('title','originalTitle','originalImages','summary','meta','allGameReleases')",
    )?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let key: String = row.get(0)?;
        let Some(entry) = owned.get_mut(&key) else { continue };
        let kind: String = row.get(1)?;
        let Ok(raw) = row.get::<_, String>(2) else { continue };
        let Ok(value) = serde_json::from_str::<Value>(&raw) else { continue };
        apply(entry, &kind, &value);
    }

    // Times are per user; the highest figure belongs to the account in use.
    if let Ok(mut stmt) = db.prepare("SELECT releaseKey, MAX(minutesInGame) FROM GameTimes GROUP BY releaseKey") {
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let key: String = row.get(0)?;
            if let (Some(entry), Ok(minutes)) = (owned.get_mut(&key), row.get::<_, i64>(1)) {
                entry.minutes = minutes.max(0) as u64;
            }
        }
    }
    if let Ok(mut stmt) = db.prepare("SELECT gameReleaseKey, MAX(lastPlayedDate) FROM LastPlayedDates GROUP BY gameReleaseKey") {
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let key: String = row.get(0)?;
            if let (Some(entry), Ok(Some(date))) = (owned.get_mut(&key), row.get::<_, Option<String>>(1)) {
                entry.last_played = parse_date(&date);
            }
        }
    }

    owned.retain(|_, e| !e.title.is_empty());
    let by_title = owned.values().map(|e| (normalize(&e.title), e.key.clone())).collect();
    Ok(Galaxy { owned, by_title })
}

fn apply(entry: &mut Entry, kind: &str, value: &Value) {
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(String::from);
    let list = |key: &str| -> Vec<String> {
        value.get(key).and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default()
    };
    match kind {
        "title" => {
            if let Some(t) = text("title") {
                entry.title = t;
            }
        }
        "originalTitle" if entry.title.is_empty() => {
            if let Some(t) = text("title") {
                entry.title = t;
            }
        }
        "originalImages" => {
            let image = |key: &str| text(key).filter(|u| !u.is_empty()).map(|u| u.replace("{formatter}", "").replace("{ext}", "webp"));
            entry.cover = image("verticalCover");
            entry.hero = image("background");
            entry.logo = image("logo");
        }
        "summary" => entry.summary = text("summary"),
        "allGameReleases" => entry.releases = list("releases"),
        "meta" => {
            entry.developer = list("developers").into_iter().next();
            entry.publisher = list("publishers").into_iter().next();
            entry.genres = list("genres");
            entry.score = value.get("criticsScore").and_then(Value::as_f64).filter(|s| *s > 0.0).map(|s| s.round() as u8);
            entry.year = value.get("releaseDate").and_then(Value::as_i64).map(unix_year);
        }
        _ => {}
    }
}

pub fn unix_year(secs: i64) -> i32 {
    // Average-length years are exact enough for a four-digit label.
    1970 + ((secs as f64) / 31_556_952.0).floor() as i32
}

/// Parses `YYYY-MM-DD HH:MM:SS` as UTC.
fn parse_date(s: &str) -> Option<i64> {
    let nums: Vec<i64> = s.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty()).filter_map(|p| p.parse().ok()).collect();
    let [y, m, d, hh, mm, ss, ..] = nums[..] else { return None };
    let (y2, m2) = if m <= 2 { (y - 1, m + 12) } else { (y, m) };
    let days = 365 * y2 + y2 / 4 - y2 / 100 + y2 / 400 + (153 * (m2 - 3) + 2) / 5 + d - 1 - 719_468;
    Some(days * 86_400 + hh * 3_600 + mm * 60 + ss)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_parse_as_utc() {
        assert_eq!(parse_date("2021-02-04 16:07:54"), Some(1_612_454_874));
        assert_eq!(parse_date("nonsense"), None);
    }

    #[test]
    fn years_are_right_at_boundaries_of_interest() {
        assert_eq!(unix_year(1_727_827_200), 2024);
        assert_eq!(unix_year(1_051_574_400), 2003);
    }

    #[test]
    fn release_lookup_uses_full_platform_prefix() {
        let e = Entry { releases: vec!["steam_steam_368360".into(), "steam_368360".into()], ..Default::default() };
        assert_eq!(e.release_on("steam"), Some("steam_368360"));
        assert_eq!(e.steam_appid(), None);
        let e = Entry { releases: vec!["steam_368360".into()], ..Default::default() };
        assert_eq!(e.steam_appid(), Some(368360));
    }
}
