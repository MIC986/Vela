//! The smaller launchers: GOG, EA, Ubisoft, Rockstar, Riot, Battle.net, Amazon and itch.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY};
use winreg::RegKey;

use crate::model::{Game, Launch};
use crate::win;

fn hklm32(path: &str) -> Option<RegKey> {
    RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(path, KEY_READ | KEY_WOW64_32KEY).ok()
}

fn dir_string(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_string()
}

pub fn gog() -> Vec<Game> {
    let mut games = Vec::new();
    let Some(root) = hklm32(r"SOFTWARE\GOG.com\Games") else { return games };
    for name in root.enum_keys().flatten() {
        let Ok(key) = root.open_subkey(&name) else { continue };
        let get = |k: &str| key.get_value::<String, _>(k).ok().filter(|v| !v.is_empty());
        let (Some(title), Some(path), Some(id)) = (get("gameName").or(get("GAMENAME")), get("path").or(get("PATH")), get("gameID").or(Some(name.clone()))) else {
            continue;
        };
        let Some(exe) = get("exe").or(get("EXE")).filter(|e| Path::new(e).exists()) else { continue };
        let mut game = Game::new(format!("gog:{id}"), title, "gog");
        game.installed = true;
        game.install_dir = Some(dir_string(Path::new(&path)));
        game.launch = Some(Launch::Exe { path: exe.clone(), args: get("launchParam").unwrap_or_default(), cwd: Some(path) });
        game.exe = Some(exe);
        games.push(game);
    }
    games
}

/// Reads an EA game's manifest; returns title, content id and launch target.
fn ea_manifest(dir: &Path) -> Option<(String, String, Option<PathBuf>)> {
    let text = fs::read_to_string(dir.join("__Installer/installerdata.xml")).ok()?;
    let doc = roxmltree::Document::parse(text.trim_start_matches('\u{feff}')).ok()?;
    let content = doc.descendants().find(|n| n.has_tag_name("contentID"))?.text()?.trim().to_string();
    let title = doc
        .descendants()
        .filter(|n| n.has_tag_name("gameTitle"))
        .find(|n| n.attribute("locale") == Some("en_US"))
        .or_else(|| doc.descendants().find(|n| n.has_tag_name("gameTitle")))?
        .text()?
        .trim()
        .to_string();
    // Launch paths read `[registry key]Game.exe`; only the file part matters here.
    let exe = doc
        .descendants()
        .filter(|n| n.has_tag_name("filePath"))
        .filter_map(|n| n.text())
        .map(|t| t.rsplit(']').next().unwrap_or(t).trim().trim_start_matches(['\\', '/']).to_string())
        .map(|t| dir.join(t))
        .find(|p| p.exists());
    Some((title, content, exe))
}

pub fn ea() -> Vec<Game> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for root in win::fixed_drive_roots() {
        for base in [root.clone(), root.join("EA Games"), root.join("Program Files/EA Games"), root.join("Games")] {
            for dir in fs::read_dir(&base).into_iter().flatten().flatten() {
                candidates.push(dir.path());
            }
        }
    }
    let mut seen = HashSet::new();
    let mut games = Vec::new();
    for dir in candidates {
        if !dir.join("__Installer/installerdata.xml").exists() {
            continue;
        }
        let Some((title, content, exe)) = ea_manifest(&dir) else { continue };
        if !seen.insert(content.clone()) {
            continue;
        }
        let mut game = Game::new(format!("ea:{content}"), title, "ea");
        game.installed = true;
        game.install_dir = Some(dir_string(&dir));
        game.exe = exe.as_ref().map(|e| e.to_string_lossy().into_owned());
        // Games behind EA's anti-cheat stub only start properly through EA's own link.
        let stub = exe.as_ref().is_none_or(|e| e.to_string_lossy().to_lowercase().contains("anticheat"));
        game.launch = Some(match exe.filter(|_| !stub) {
            Some(path) => Launch::Exe { path: path.to_string_lossy().into_owned(), args: String::new(), cwd: Some(dir_string(&dir)) },
            None => Launch::Url { url: format!("link2ea://launchgame/{content}?platform=pc") },
        });
        games.push(game);
    }
    games
}

pub fn ubisoft() -> Vec<Game> {
    let mut games = Vec::new();
    let Some(root) = hklm32(r"SOFTWARE\Ubisoft\Launcher\Installs") else { return games };
    for id in root.enum_keys().flatten() {
        let Ok(key) = root.open_subkey(&id) else { continue };
        let Ok(dir) = key.get_value::<String, _>("InstallDir") else { continue };
        let dir = PathBuf::from(dir);
        if !dir.exists() {
            continue;
        }
        let title = hklm32(&format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Uplay Install {id}"))
            .and_then(|k| k.get_value::<String, _>("DisplayName").ok())
            .unwrap_or_else(|| dir.file_name().unwrap_or_default().to_string_lossy().into_owned());
        let mut game = Game::new(format!("ubisoft:{id}"), title, "ubisoft");
        game.installed = true;
        game.install_dir = Some(dir_string(&dir));
        game.launch = Some(Launch::Url { url: format!("uplay://launch/{id}/0") });
        game.uninstall = Some(Launch::Url { url: format!("uplay://uninstall/{id}") });
        games.push(game);
    }
    games
}

pub fn rockstar() -> Vec<Game> {
    // Copies owned through Steam or Xbox have their own values and are found there.
    let mut games = Vec::new();
    let Some(root) = hklm32(r"SOFTWARE\Rockstar Games") else { return games };
    for name in root.enum_keys().flatten() {
        if matches!(name.as_str(), "Launcher" | "Rockstar Games Social Club" | "Rockstar Games Launcher" | "Steam") {
            continue;
        }
        let Some(dir) = root.open_subkey(&name).ok().and_then(|k| k.get_value::<String, _>("InstallFolder").ok()).filter(|d| !d.is_empty()) else {
            continue;
        };
        let dir = PathBuf::from(dir);
        let exe = ["PlayGTAV.exe", "GTA5_Enhanced.exe", "GTA5.exe", "RDR2.exe", "LANoire.exe", "MaxPayne3.exe", "Bully.exe"]
            .iter()
            .map(|e| dir.join(e))
            .find(|p| p.exists());
        let Some(exe) = exe else { continue };
        let mut game = Game::new(format!("rockstar:{name}"), name, "rockstar");
        game.installed = true;
        game.install_dir = Some(dir_string(&dir));
        game.exe = Some(exe.to_string_lossy().into_owned());
        game.launch = Some(Launch::Exe { path: exe.to_string_lossy().into_owned(), args: String::new(), cwd: Some(dir_string(&dir)) });
        games.push(game);
    }
    games
}

pub fn riot() -> Vec<Game> {
    const PRODUCTS: &[(&str, &str, &str)] = &[
        ("League of Legends", "league_of_legends", "League of Legends"),
        ("VALORANT/live", "valorant", "VALORANT"),
        ("Teamfight Tactics/live", "teamfighttactics", "Teamfight Tactics"),
        ("LoR/live", "bacon", "Legends of Runeterra"),
        ("2XKO/live", "lion", "2XKO"),
    ];
    let mut games = Vec::new();
    let Ok(program_data) = std::env::var("ProgramData") else { return games };
    let Ok(text) = fs::read_to_string(format!("{program_data}/Riot Games/RiotClientInstalls.json")) else { return games };
    let Ok(json) = serde_json::from_str::<Value>(&text) else { return games };
    let Some(client) = json.get("rc_default").and_then(Value::as_str).filter(|c| Path::new(c).exists()) else { return games };
    // Client: <base>/Riot Client/RiotClientServices.exe; games sit beside it.
    let Some(base) = Path::new(client).ancestors().nth(2) else { return games };
    for (folder, product, title) in PRODUCTS {
        let path = base.join(folder);
        if !path.is_dir() {
            continue;
        }
        let mut game = Game::new(format!("riot:{product}"), *title, "riot");
        game.installed = true;
        game.install_dir = Some(dir_string(&path));
        game.launch = Some(Launch::Exe {
            path: client.replace('/', "\\"),
            args: format!("--launch-product={product} --launch-patchline=live"),
            cwd: None,
        });
        games.push(game);
    }
    games
}

pub fn battlenet() -> Vec<Game> {
    const PRODUCTS: &[(&str, &str)] = &[
        ("World of Warcraft", "WoW"),
        ("Overwatch", "Pro"),
        ("Hearthstone", "WTCG"),
        ("Diablo IV", "Fen"),
        ("Diablo III", "D3"),
        ("Diablo II Resurrected", "OSI"),
        ("StarCraft II", "S2"),
        ("StarCraft", "S1"),
        ("Heroes of the Storm", "Hero"),
        ("Call of Duty", "ODIN"),
        ("Warcraft III", "W3"),
    ];
    let mut games = Vec::new();
    let Some(root) = hklm32(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall") else { return games };
    let launcher = hklm32(r"SOFTWARE\Blizzard Entertainment\Battle.net\Capabilities")
        .and_then(|k| k.get_value::<String, _>("ApplicationIcon").ok())
        .map(|p| p.trim_matches('"').split(',').next().unwrap_or_default().to_string());
    for name in root.enum_keys().flatten() {
        let Ok(key) = root.open_subkey(&name) else { continue };
        let Ok(command) = key.get_value::<String, _>("UninstallString") else { continue };
        if !command.contains("Battle.net") || !command.contains("--uid=") {
            continue;
        }
        let Ok(title) = key.get_value::<String, _>("DisplayName") else { continue };
        let Ok(dir) = key.get_value::<String, _>("InstallLocation") else { continue };
        let Some((_, code)) = PRODUCTS.iter().find(|(t, _)| title.starts_with(t)) else { continue };
        if !Path::new(&dir).exists() {
            continue;
        }
        let mut game = Game::new(format!("battlenet:{code}"), title, "battlenet");
        game.installed = true;
        game.install_dir = Some(dir_string(Path::new(&dir)));
        game.launch = Some(match &launcher {
            Some(exe) => Launch::Exe { path: exe.clone(), args: format!("--exec=\"launch {code}\""), cwd: None },
            None => Launch::Url { url: format!("battlenet://{code}") },
        });
        games.push(game);
    }
    games
}

pub fn amazon() -> Vec<Game> {
    let mut games = Vec::new();
    let Ok(local) = std::env::var("LOCALAPPDATA") else { return games };
    let path = format!("{local}/Amazon Games/Data/Games/Sql/GameInstallInfo.sqlite");
    if !Path::new(&path).exists() {
        return games;
    }
    let Ok(db) = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY) else { return games };
    let Ok(mut stmt) = db.prepare("SELECT Id, ProductTitle, InstallDirectory FROM DbSet WHERE Installed = 1") else { return games };
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)));
    for (id, title, dir) in rows.into_iter().flatten().flatten() {
        if !Path::new(&dir).exists() {
            continue;
        }
        let mut game = Game::new(format!("amazon:{id}"), title, "amazon");
        game.installed = true;
        game.install_dir = Some(dir_string(Path::new(&dir)));
        game.launch = Some(Launch::Url { url: format!("amazon-games://play/{id}") });
        games.push(game);
    }
    games
}

pub fn itch() -> Vec<Game> {
    let mut games = Vec::new();
    let Ok(appdata) = std::env::var("APPDATA") else { return games };
    let path = format!("{appdata}/itch/db/butler.db");
    if !Path::new(&path).exists() {
        return games;
    }
    let uri = format!("file:{}?mode=ro&immutable=1", path.replace('\\', "/"));
    let Ok(db) = Connection::open_with_flags(uri, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI) else { return games };
    let query = "SELECT c.id, g.title, g.cover_url, l.path, c.install_folder_name, g.classification
                 FROM caves c JOIN games g ON g.id = c.game_id JOIN install_locations l ON l.id = c.install_location_id";
    let Ok(mut stmt) = db.prepare(query) else { return games };
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, Option<String>>(5)?,
        ))
    });
    for (cave, title, cover, base, folder, class) in rows.into_iter().flatten().flatten() {
        if class.as_deref().is_some_and(|c| c != "game") {
            continue;
        }
        let dir = Path::new(&base).join(folder);
        if !dir.exists() {
            continue;
        }
        let mut game = Game::new(format!("itch:{cave}"), title, "itch");
        game.installed = true;
        game.install_dir = Some(dir_string(&dir));
        game.launch = Some(Launch::Url { url: format!("itch://caves/{cave}/launch") });
        game.art.cover.extend(cover);
        games.push(game);
    }
    games
}
