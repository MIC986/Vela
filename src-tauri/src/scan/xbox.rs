//! Packaged games: Xbox app / Game Pass installs and Store games.
//!
//! Any game built on Microsoft's GDK ships a MicrosoftGame.config, which makes
//! those certain. Everything else from the Store is settled by asking the Store
//! catalog what kind of product the package is, with the answer cached forever.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use windows::core::HSTRING;
use windows::ApplicationModel::{Package, PackageSignatureKind};
use windows::Management::Deployment::PackageManager;

use super::galaxy::Galaxy;
use crate::model::{Game, Launch};
use crate::win;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Lookup {
    pub is_game: bool,
    pub product_id: Option<String>,
}

/// Package family name to what the Store said about it.
pub type Lookups = HashMap<String, Lookup>;

/// Package name prefixes that are never games, skipped before any network call.
const SYSTEM: &[&str] = &[
    "Microsoft.Windows",
    "MicrosoftWindows.",
    "windows.",
    "Windows.",
    "Microsoft.VCLibs",
    "Microsoft.NET",
    "Microsoft.UI.",
    "Microsoft.Xbox",
    "Microsoft.GamingApp",
    "Microsoft.GamingServices",
    "Microsoft.DigitalOwnership",
    "Microsoft.Winget",
    "Microsoft.Language",
    "Microsoft.Ink",
    "Microsoft.Bing",
    "Microsoft.Zune",
    "Microsoft.Office",
    "Microsoft.MicrosoftOffice",
    "Microsoft.StorePurchaseApp",
    "Microsoft.WebMedia",
    "MicrosoftCorporationII.",
];

const EXTENSION_SUFFIXES: &[&str] = &["VideoExtension", "ImageExtension", "AudioExtension", "VideoExtensions"];

struct Installed {
    name: String,
    family: String,
    display: String,
    path: Option<PathBuf>,
    aumid: Option<String>,
}

fn packages() -> Vec<Installed> {
    let _com = win::ComScope::new();
    let Ok(manager) = PackageManager::new() else { return Vec::new() };
    let Ok(found) = manager.FindPackagesByUserSecurityId(&HSTRING::new()) else { return Vec::new() };
    found.into_iter().filter_map(|p| read_package(&p).ok().flatten()).collect()
}

fn read_package(p: &Package) -> windows::core::Result<Option<Installed>> {
    if p.IsFramework()? || p.IsResourcePackage()? || p.IsBundle()? || p.SignatureKind()? != PackageSignatureKind::Store {
        return Ok(None);
    }
    let id = p.Id()?;
    let aumid = p.GetAppListEntries().ok().and_then(|list| {
        list.into_iter().find_map(|entry| entry.AppUserModelId().ok().map(|a| a.to_string()).filter(|a| !a.is_empty()))
    });
    Ok(Some(Installed {
        name: id.Name()?.to_string(),
        family: id.FamilyName()?.to_string(),
        display: p.DisplayName().map(|d| d.to_string()).unwrap_or_default(),
        path: p.InstalledPath().ok().map(|s| PathBuf::from(s.to_string())).filter(|s| !s.as_os_str().is_empty()),
        aumid,
    }))
}

/// Identity name and display title from a MicrosoftGame.config.
fn read_config(path: &Path) -> Option<(String, Option<String>)> {
    let text = fs::read_to_string(path).ok()?;
    let doc = roxmltree::Document::parse(text.trim_start_matches('\u{feff}')).ok()?;
    let identity = doc.descendants().find(|n| n.has_tag_name("Identity"))?.attribute("Name")?.to_string();
    let title = doc
        .descendants()
        .find(|n| n.has_tag_name("ShellVisuals"))
        .and_then(|n| n.attribute("DefaultDisplayName"))
        .filter(|t| !t.starts_with("ms-resource:"))
        .map(String::from);
    Some((identity, title))
}

/// Games the Xbox app installed to a `XboxGames` folder, by package identity.
fn mutable_installs() -> HashMap<String, (PathBuf, Option<String>)> {
    let mut out = HashMap::new();
    for root in win::fixed_drive_roots() {
        for folder in fs::read_dir(root.join("XboxGames")).into_iter().flatten().flatten() {
            let content = folder.path().join("Content");
            if let Some((identity, title)) = read_config(&content.join("MicrosoftGame.config")) {
                out.insert(identity, (content, title));
            }
        }
    }
    out
}

fn is_system(name: &str) -> bool {
    SYSTEM.iter().any(|p| name.starts_with(p)) || EXTENSION_SUFFIXES.iter().any(|s| name.ends_with(s))
}

/// Asks the Store what each unknown package is. Failures stay unknown and are retried next scan.
fn resolve_unknown(families: Vec<String>, lookups: &mut Lookups) {
    let queue = std::sync::Mutex::new(families);
    let done = std::sync::Mutex::new(Vec::new());
    std::thread::scope(|s| {
        for _ in 0..6 {
            s.spawn(|| loop {
                let Some(family) = queue.lock().unwrap().pop() else { return };
                if let Some(result) = crate::meta::lookup_package(&family) {
                    done.lock().unwrap().push((family, result));
                }
            });
        }
    });
    lookups.extend(done.into_inner().unwrap());
}

pub fn scan(galaxy: Option<&Galaxy>, lookups: &mut Lookups, online: bool) -> Vec<Game> {
    let packages = packages();
    let mutable = mutable_installs();
    let has_config = |p: &Installed| {
        mutable.contains_key(&p.name) || p.path.as_ref().is_some_and(|d| d.join("MicrosoftGame.config").exists())
    };

    if online {
        let unknown: Vec<String> = packages
            .iter()
            .filter(|p| !lookups.contains_key(&p.family) && (has_config(p) || !is_system(&p.name)))
            .map(|p| p.family.clone())
            .collect();
        if !unknown.is_empty() {
            resolve_unknown(unknown, lookups);
        }
    }

    let mut games = Vec::new();
    for p in &packages {
        let lookup = lookups.get(&p.family);
        let config = has_config(p);
        // A config marks a game unless the Store positively says otherwise; add-on
        // packs carry configs too, and have no entry to start.
        let qualifies = (config && lookup.is_none_or(|l| l.is_game)) || (!config && !is_system(&p.name) && lookup.is_some_and(|l| l.is_game));
        let Some(aumid) = p.aumid.as_ref().filter(|_| qualifies) else { continue };
        let mutable_entry = mutable.get(&p.name);
        let title = mutable_entry
            .and_then(|(_, t)| t.clone())
            .or_else(|| p.path.as_ref().and_then(|d| read_config(&d.join("MicrosoftGame.config"))).and_then(|(_, t)| t))
            .unwrap_or_else(|| p.display.clone());
        if title.trim().is_empty() {
            continue;
        }
        let mut game = Game::new(format!("xbox:{}", p.family), title.trim(), "xbox");
        game.installed = true;
        game.pfn = Some(p.family.clone());
        game.store_id = lookup.and_then(|l| l.product_id.clone());
        let dirs: Vec<String> =
            mutable_entry.map(|(d, _)| d.clone()).into_iter().chain(p.path.clone()).map(|d| d.to_string_lossy().into_owned()).collect();
        game.install_dir = dirs.first().cloned();
        game.extra_dirs = dirs.into_iter().skip(1).collect();
        game.launch = Some(Launch::Aumid { aumid: aumid.clone() });
        game.uninstall = Some(Launch::Url { url: "ms-settings:appsfeatures".into() });
        games.push(game);
    }

    // Owned on the Xbox account but not on this PC, as recorded by Galaxy.
    if let Some(g) = galaxy {
        for (key, entry) in &g.owned {
            if !key.starts_with("xboxone_") {
                continue;
            }
            let Some(product) = entry.release_on("winstore").map(str::to_uppercase) else { continue };
            let mut game = Game::new(format!("xbox:{product}"), &entry.title, "xbox");
            game.store_id = Some(product.clone());
            game.install = Some(store_page(&product));
            games.push(game);
        }
    }
    games
}

/// Opens a product in the Xbox app, where the Install button is.
pub fn store_page(product: &str) -> Launch {
    Launch::Url { url: format!("msxbox://game/?productId={product}") }
}

pub fn watch_paths() -> Vec<PathBuf> {
    win::fixed_drive_roots().into_iter().map(|r| r.join("XboxGames")).filter(|p| p.exists()).collect()
}

/// Removes an installed game the way Settings does. Blocks until Windows has finished.
pub fn remove_package(family: &str) -> Result<(), String> {
    let _com = win::ComScope::new();
    let manager = PackageManager::new().map_err(|e| e.to_string())?;
    let found = manager.FindPackagesByUserSecurityIdPackageFamilyName(&HSTRING::new(), &HSTRING::from(family)).map_err(|e| e.to_string())?;
    let mut removed = false;
    for package in found {
        let name = package.Id().and_then(|id| id.FullName()).map_err(|e| e.to_string())?;
        manager.RemovePackageAsync(&name).and_then(|op| op.get()).map_err(|e| format!("Windows couldn't remove it: {}", e.message()))?;
        removed = true;
    }
    if removed { Ok(()) } else { Err("Windows no longer lists this game as installed.".into()) }
}
