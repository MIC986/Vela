//! Games with no launcher behind them: repacks, portable builds, old installers.
//!
//! This is where apps could slip in, so nothing here is trusted on one clue.
//! Every folder is judged by what's inside it: engine files, game middleware and
//! DRM leftovers score up; Electron shells, Qt and editors score down; and any
//! folder or program name on the deny lists is out regardless of score. Windows
//! itself contributes a second opinion through GameConfigStore, its record of
//! which programs it has recognized as games.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY};
use winreg::RegKey;

use super::steam::Shortcut;
use crate::model::{Game, Launch};
use crate::titles::{clean_folder_name, normalize};
use crate::win;

/// Below this, a folder needs Windows' or the user's vouching to count.
const GAME_SCORE: i32 = 6;

/// Folders that belong to something else: stores manage their own, and the rest
/// are system locations or caches that hold no games of their own.
const DENY_PATHS: &[&str] = &[
    r"\windows\",
    r"\windowsapps\",
    r"\xboxgames\",
    r"\wpsystem\",
    r"\steamapps\",
    r"\steamlibrary\",
    r"\epic games\",
    r"\riot games\",
    r"\common files\",
    r"\microsoft\",
    r"\microsoft visual studio\",
    r"\windows kits\",
    r"\nvidia",
    r"\amd\",
    r"\intel\",
    r"\programdata\",
    r"\$recycle.bin\",
    r"\system volume information\",
    r"\appdata\local\temp\",
    r"\node_modules\",
    r"\site-packages\",
    r"\.git\",
    r"\.cargo\",
    r"\.rustup\",
    r"\.venv\",
];

/// Whole words in a program or folder name that mark non-games.
const DENY_NAMES: &[&str] = &[
    "7-zip", "7zip", "ableton", "acrobat", "adobe", "after effects", "afterburner", "android studio", "animate", "anydesk", "armoury", "audacity",
    "autocad", "automatic1111", "battle.net", "blender", "bluestacks", "brave", "calibre", "capcut", "cheat engine", "chrome", "chromium",
    "cinema 4d", "cloudflare", "comfyui", "corsair", "cubase", "cursor", "davinci", "discord", "docker", "droidcam", "ea app", "ea desktop",
    "edge", "epic games launcher", "firefox", "flashpoint", "fl studio", "galaxy client", "gimp", "git", "github", "gog galaxy", "google",
    "hitpaw", "houdini", "illustrator", "inkscape", "java", "jdk", "krita", "launcher", "redlauncher", "ldplayer", "lm studio", "logitech", "maya", "medal", "memu",
    "mod organizer", "modrinth", "nexus mods", "node.js", "nodejs", "nox", "notepad", "npcap", "nvidia", "obs", "obs studio", "office", "ollama", "onedrive",
    "opera", "oracle", "parsec", "photoshop", "pinokio", "playnite", "postman", "powertoys", "premiere", "python", "qbittorrent", "razer",
    "reshade", "resolve", "rivatuner", "roblox studio", "rockstar games launcher", "rstudio", "rufus", "rust", "shotcut", "signal", "skype", "slack",
    "social club", "spotify", "stable diffusion", "steam", "steelseries", "substance", "teamviewer", "telegram", "terabox", "teracopy",
    "tsdownloader", "ubisoft connect", "unity hub", "unreal engine", "virtualbox", "visual studio", "vlc", "vmware", "vortex", "vscode", "wallpaper engine",
    "wemod", "whatsapp", "winrar", "wireshark", "zbrush", "zoom",
];

/// Program names that are never the game itself.
const DENY_EXE: &[&str] = &[
    "unins", "uninst", "setup", "install", "update", "patch", "crash", "report", "redist", "dxsetup", "dxwebsetup", "dotnet", "ue4prereq", "ueprereq",
    "unrealcefsubprocess", "cefsharp", "easyanticheat", "beservice", "battleye", "eac_", "config", "settings", "benchmark", "editor", "dedicated", "server",
    "modmanager", "mod_manager", "registry", "language", "activation", "tool", "helper", "service", "touchup", "cleanup", "dump", "robloxstudio",
];

/// Exact process names for runtimes that merely host things.
const DENY_HOSTS: &[&str] = &[
    "java", "javaw", "python", "pythonw", "node", "cmd", "powershell", "explorer", "rundll32", "wscript", "cscript", "client", "riotclientservices",
    "leagueclientux", "uwphook",
];

fn has_word(haystack: &str, word: &str) -> bool {
    let hay = haystack.as_bytes();
    let mut from = 0;
    while let Some(i) = haystack[from..].find(word) {
        let start = from + i;
        let end = start + word.len();
        let left = start == 0 || !hay[start - 1].is_ascii_alphanumeric();
        let right = end == hay.len() || !hay[end].is_ascii_alphanumeric();
        if left && right {
            return true;
        }
        from = start + 1;
        while !haystack.is_char_boundary(from) {
            from += 1;
        }
    }
    false
}

pub fn denied_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    DENY_NAMES.iter().any(|d| has_word(&lower, d))
}

fn denied_path(path: &Path) -> bool {
    let lower = format!("{}\\", path.to_string_lossy().replace('/', "\\").to_lowercase());
    DENY_PATHS.iter().any(|d| lower.contains(d))
}

fn denied_exe(stem: &str) -> bool {
    let lower = stem.to_lowercase();
    DENY_HOSTS.contains(&lower.as_str()) || DENY_EXE.iter().any(|d| lower.contains(d))
}

struct Listing {
    files: Vec<(String, u64)>,
    dirs: Vec<(String, PathBuf)>,
}

fn list(dir: &Path) -> Option<Listing> {
    let mut l = Listing { files: Vec::new(), dirs: Vec::new() };
    for entry in fs::read_dir(dir).ok()?.flatten().take(3000) {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        match entry.file_type() {
            Ok(t) if t.is_dir() => l.dirs.push((name, entry.path())),
            Ok(t) if t.is_file() => l.files.push((name, entry.metadata().map(|m| m.len()).unwrap_or(0))),
            _ => {}
        }
    }
    Some(l)
}

/// Scores one folder's own contents.
fn score_listing(l: &Listing) -> i32 {
    let mut score = 0;
    let has_file = |n: &str| l.files.iter().any(|(f, _)| f == n);
    for (f, _) in &l.files {
        score += match f.as_str() {
            "unityplayer.dll" | "gameassembly.dll" | "data.win" | "steam_emu.ini" | "codex.ini" | "cream_api.ini" | "uplay_r1_loader64.dll" | "uplay_r1_loader.dll"
            | "upc_r1_loader64.dll" | "upc_r2_loader64.dll" | "fna.dll" | "monogame.framework.dll" | "rpg_core.js" => 8,
            "steam_api.dll" | "steam_api64.dll" | "galaxy.dll" | "galaxy64.dll" | "eossdk-win64-shipping.dll" | "eossdk-win32-shipping.dll" | "bink2w64.dll"
            | "binkw32.dll" | "binkw64.dll" | "bink2w32.dll" | "steamclient64.dll" => 7,
            "nvngx_dlss.dll" | "libxess.dll" | "amd_ags_x64.dll" | "dinput8.dll" | "fmod.dll" | "fmod64.dll" | "fmodstudio.dll" | "fmod_studio.dll" | "fmodstudio64.dll"
            | "discord_game_sdk.dll" | "physx3_x64.dll" | "physx_64.dll" | "physxcore64.dll" | "xaudio2_9redist.dll" | "wwise.dll" => 4,
            "d3dx9_43.dll" | "d3dx10_43.dll" | "d3dx11_43.dll" | "xinput1_3.dll" | "openal32.dll" | "sdl2.dll" | "sdl3.dll" => 2,
            "libcef.dll" => -2,
            "qt5core.dll" | "qt6core.dll" => -5,
            "licenses.chromium.html" | "chrome_100_percent.pak" => -8,
            "unrealeditor.exe" | "unity.exe" | "blender.exe" | "resolve.exe" => -30,
            _ => {
                if f.ends_with("-win64-shipping.exe") || f.ends_with("-win32-shipping.exe") {
                    8
                } else if (f.starts_with("goggame-") && f.ends_with(".info")) || f.ends_with(".rgss3a") || f.ends_with(".rgssad") || f.ends_with(".bsa") || f.ends_with(".ba2") {
                    8
                } else if f.ends_with(".pck") || f.ends_with(".forge") {
                    6
                } else if f.starts_with("onlinefix") {
                    7
                } else {
                    0
                }
            }
        };
    }
    for (d, path) in &l.dirs {
        score += match d.as_str() {
            "__installer" | "steam_settings" | "renpy" | "paks" | "easyanticheat" | "battleye" | "easyanticheat_eos" => 6,
            "engine" if path.join("Binaries").exists() || path.join("Content").exists() => 6,
            "www" if path.join("js/rpg_core.js").exists() || path.join("js/rmmz_core.js").exists() => 8,
            "resources" if path.join("app.asar").exists() => -12,
            "resources" if path.join("app").join("package.json").exists() => -12,
            _ if d.ends_with("_data") && path.join("globalgamemanagers").exists() => 8,
            _ => 0,
        };
    }
    if has_file("python3.dll") && !l.dirs.iter().any(|(d, _)| d == "renpy") {
        score -= 4;
    }
    score
}

/// Picks the program most likely to be the game among those in a folder tree.
fn pick_exe(root: &Path, listing: &Listing) -> Option<PathBuf> {
    let folder = normalize(&root.file_name().unwrap_or_default().to_string_lossy());
    fn gather(pool: &mut Vec<(PathBuf, u64)>, dir: &Path, l: &Listing) {
        for (name, size) in &l.files {
            if let Some(stem) = name.strip_suffix(".exe") {
                if !denied_exe(stem) {
                    pool.push((dir.join(name), *size));
                }
            }
        }
    }
    let mut pool: Vec<(PathBuf, u64)> = Vec::new();
    gather(&mut pool, root, listing);
    if pool.is_empty() {
        for sub in ["bin", "x64", "win64", "binaries", "game", "64", "bin64", "bin/x64", "bin/win_x64", "binaries/win64", "game/bin/x64"] {
            let dir = root.join(sub);
            if let Some(l) = list(&dir) {
                gather(&mut pool, &dir, &l);
            }
        }
    }
    // Unreal keeps the true game a few levels down; a stub at the root is still preferred.
    if pool.is_empty() {
        for (_, sub) in &listing.dirs {
            let dir = sub.join("Binaries/Win64");
            if let Some(l) = list(&dir) {
                gather(&mut pool, &dir, &l);
            }
        }
    }
    pool.into_iter()
        .max_by_key(|(path, size)| {
            let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
            let norm = normalize(&stem);
            let paired = path.with_file_name(format!("{stem}_Data")).exists();
            let shipping = stem.to_lowercase().ends_with("-shipping");
            let named = !norm.is_empty() && (folder.contains(&norm) || norm.contains(&folder));
            let launcher = stem.to_lowercase().contains("launcher");
            (paired as u8, (named || shipping) as u8, !launcher as u8, *size)
        })
        .map(|(p, _)| p)
}

/// Walks up from a game program past engine folders to the game's own folder.
pub fn game_root(exe: &Path) -> PathBuf {
    const TAILS: &[&str] = &["binaries", "win64", "win32", "win_x64", "x64", "x86", "64", "32", "bin", "bin64", "bin32", "bin_plus", "game", "retail", "shipping"];
    let mut dir = exe.parent().unwrap_or(exe).to_path_buf();
    // <root>/<Project>/Binaries/Win64/<Project>-Win64-Shipping.exe
    let lower = dir.to_string_lossy().to_lowercase();
    if lower.ends_with(r"binaries\win64") || lower.ends_with(r"binaries\win32") {
        if let Some(project_parent) = dir.ancestors().nth(3) {
            if project_parent.parent().is_some() {
                return project_parent.to_path_buf();
            }
        }
    }
    while let (Some(name), Some(parent)) = (dir.file_name().map(|n| n.to_string_lossy().to_lowercase()), dir.parent()) {
        if parent.parent().is_none() || !TAILS.contains(&name.as_str()) {
            break;
        }
        dir = parent.to_path_buf();
    }
    dir
}

/// The name a program gives itself, unless it's just its engine's.
fn product_name(exe: &Path) -> Option<String> {
    let info = win::version_info(exe);
    let name = info.product_name.or(info.file_description)?;
    let lower = name.to_lowercase();
    let generic = ["unity", "unreal", "ue4", "ue5", "game", "launcher", "bootstrap", "application", "microsoft", "shipping", "client", "windows"];
    let useless = name.len() < 3
        || generic.iter().any(|g| lower == *g || lower.starts_with(&format!("{g} ")))
        || lower.contains("shipping")
        || lower.contains("operating system")
        || lower.contains("bootstrappackaged");
    (!useless).then_some(name)
}

fn uninstall_titles() -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut read = |key: Option<RegKey>| {
        let Some(key) = key else { return };
        for name in key.enum_keys().flatten() {
            let Ok(entry) = key.open_subkey(&name) else { continue };
            let (Ok(title), Ok(dir)) = (entry.get_value::<String, _>("DisplayName"), entry.get_value::<String, _>("InstallLocation")) else { continue };
            let dir = dir.trim().trim_matches('"').trim_end_matches('\\').to_lowercase();
            if dir.len() > 3 {
                map.insert(dir, title);
            }
        }
    };
    const PATH: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
    read(RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(PATH, KEY_READ).ok());
    read(RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(PATH, KEY_READ | KEY_WOW64_32KEY).ok());
    read(RegKey::predef(HKEY_CURRENT_USER).open_subkey(PATH).ok());
    map
}

fn game_config_store() -> Vec<PathBuf> {
    let Ok(children) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"System\GameConfigStore\Children") else { return Vec::new() };
    children
        .enum_keys()
        .flatten()
        .filter_map(|name| children.open_subkey(name).ok()?.get_value::<String, _>("MatchedExeFullPath").ok())
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .collect()
}

fn start_menu_targets() -> Vec<PathBuf> {
    let _com = win::ComScope::new();
    let env = win::env_paths();
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(p) = env.get("ProgramData") {
        roots.push(Path::new(p).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    if let Some(p) = env.get("APPDATA") {
        roots.push(Path::new(p).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    if let Some(p) = env.get("USERPROFILE") {
        roots.push(Path::new(p).join("Desktop"));
    }
    if let Some(p) = env.get("PUBLIC") {
        roots.push(Path::new(p).join("Desktop"));
    }
    let mut out = Vec::new();
    let mut stack = roots;
    let mut budget = 3000;
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
            budget -= 1;
            if budget == 0 {
                return out;
            }
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("lnk")) {
                out.extend(win::shortcut_target(&path).filter(|t| t.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")) && t.exists()));
            }
        }
    }
    out
}

/// Scan roots with how deep to look under each.
fn folder_roots(extra: &[String]) -> Vec<(PathBuf, usize)> {
    let mut roots: Vec<(PathBuf, usize)> = Vec::new();
    for drive in win::fixed_drive_roots() {
        roots.push((drive.clone(), 3));
        roots.push((drive.join("Program Files"), 2));
        roots.push((drive.join("Program Files (x86)"), 2));
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        let home = PathBuf::from(home);
        roots.push((home.join("Downloads"), 4));
        roots.push((home.join("Desktop"), 3));
        roots.push((home.join("Documents"), 2));
        roots.push((home.join("Games"), 3));
    }
    roots.extend(extra.iter().map(|f| (PathBuf::from(f), 5)));
    roots
}

const SKIP_DIRS: &[&str] = &[
    "windows", "users", "program files", "program files (x86)", "programdata", "$recycle.bin", "system volume information", "recovery", "perflogs",
    "msocache", "$windows.~bt", "$windows.~ws", "windowsapps", "wpsystem", "appdata", "movies", "videos", "music", "pictures", "photos", "archive", "backup", "backups",
    "node_modules", "cache", "logs", "temp", "tmp", ".git",
];

struct Walk {
    visited: usize,
    deadline: Instant,
    found: Vec<(PathBuf, i32, PathBuf)>,
}

fn walk(dir: &Path, depth: usize, w: &mut Walk) {
    if w.visited > 12_000 || Instant::now() > w.deadline {
        return;
    }
    w.visited += 1;
    let Some(listing) = list(dir) else { return };
    let name = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
    if !name.is_empty() && !denied_path(dir) && !denied_name(&name) {
        let mut score = score_listing(&listing);
        // Engine files often sit one level below the folder a game was unpacked to.
        for (_, sub) in listing.dirs.iter().take(24) {
            if let Some(inner) = list(sub) {
                score += score_listing(&inner).clamp(-6, 6);
            }
        }
        if score >= GAME_SCORE {
            if let Some(exe) = pick_exe(dir, &listing) {
                w.found.push((dir.to_path_buf(), score, exe));
                return;
            }
        }
    }
    if depth == 0 {
        return;
    }
    for (sub_name, sub) in &listing.dirs {
        if !SKIP_DIRS.contains(&sub_name.as_str()) && !sub_name.starts_with('.') && !denied_name(sub_name) {
            walk(sub, depth - 1, w);
        }
    }
}

struct Candidate {
    root: PathBuf,
    exe: PathBuf,
    title: Option<String>,
    args: String,
}

fn under(path: &str, parent: &str) -> bool {
    path == parent || path.strip_prefix(parent).is_some_and(|r| r.starts_with('\\'))
}

fn key(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// Finds games not owned by any store. `claimed` lists folders stores already account for.
pub fn scan(claimed: &[String], extra: &[String], shortcuts: Vec<Shortcut>) -> Vec<Game> {
    let claimed: Vec<String> = claimed.iter().map(|d| key(Path::new(d))).collect();
    let uninstall = uninstall_titles();
    let mut candidates: Vec<Candidate> = Vec::new();

    // Windows' list and the user's Steam shortcuts are vouched for, so they only
    // need to clear the deny lists.
    for exe in game_config_store() {
        candidates.push(Candidate { root: game_root(&exe), exe, title: None, args: String::new() });
    }
    for s in shortcuts {
        let is_exe = s.exe.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe"));
        if is_exe && s.exe.exists() {
            candidates.push(Candidate { root: game_root(&s.exe), exe: s.exe, title: Some(s.title), args: s.args });
        }
    }

    // Everything below has to earn it through folder contents.
    let mut w = Walk { visited: 0, deadline: Instant::now() + Duration::from_secs(20), found: Vec::new() };
    let mut seen = HashSet::new();
    let mut probe = |dir: &Path, w: &mut Walk, depth: usize| {
        if seen.insert(key(dir)) {
            walk(dir, depth, w);
        }
    };
    for (dir, _) in &uninstall {
        let path = PathBuf::from(dir);
        if path.exists() {
            probe(&path, &mut w, 1);
        }
    }
    for target in start_menu_targets() {
        probe(&game_root(&target), &mut w, 0);
    }
    for (root, depth) in folder_roots(extra) {
        probe(&root, &mut w, depth);
    }
    for (root, _, exe) in w.found {
        candidates.push(Candidate { root, exe, title: None, args: String::new() });
    }

    let mut roots_done: Vec<String> = Vec::new();
    let mut games = Vec::new();
    // Shallow folders first, so a nested copy is recognized as part of its parent;
    // a name the user chose beats any we'd derive.
    candidates.sort_by_key(|c| (c.root.components().count(), c.title.is_none()));
    for c in candidates {
        let root_key = key(&c.root);
        let stem = c.exe.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let folder = c.root.file_name().unwrap_or_default().to_string_lossy().to_string();
        if denied_path(&c.root) || denied_path(&c.exe) || denied_exe(&stem) || denied_name(&folder) || denied_name(&stem) {
            continue;
        }
        if claimed.iter().any(|d| under(&root_key, d) || under(d, &root_key)) || roots_done.iter().any(|d| under(&root_key, d)) {
            continue;
        }
        let from_uninstall = c.root.ancestors().take(3).find_map(|a| uninstall.get(&key(a)));
        // The Roblox client signs its version info with the player's own name.
        let roblox = key(&c.exe).contains(r"\roblox\versions\").then(|| "Roblox".to_string());
        let title = c
            .title
            .or(roblox)
            .or_else(|| from_uninstall.map(|t| clean_folder_name(t)))
            .or_else(|| product_name(&c.exe))
            .unwrap_or_else(|| clean_folder_name(&folder));
        if title.is_empty() || denied_name(&title) {
            continue;
        }
        roots_done.push(root_key.clone());
        let launch_exe = launch_target(&c.root, &c.exe);
        let mut game = Game::new(format!("local:{:016x}", crate::store::fnv(&root_key)), title, "local");
        game.installed = true;
        game.install_dir = Some(c.root.to_string_lossy().into_owned());
        game.exe = Some(launch_exe.to_string_lossy().into_owned());
        game.launch = Some(Launch::Exe {
            path: launch_exe.to_string_lossy().into_owned(),
            args: c.args,
            cwd: launch_exe.parent().map(|p| p.to_string_lossy().into_owned()),
        });
        game.uninstall = c.root.ancestors().take(3).find_map(|a| uninstall_command(&key(a)));
        games.push(game);
    }
    games
}

/// Unreal ships a small starter at the top that sets up arguments; prefer it.
fn launch_target(root: &Path, exe: &Path) -> PathBuf {
    let stem = exe.file_stem().unwrap_or_default().to_string_lossy().to_string();
    if let Some(project) = stem.strip_suffix("-Win64-Shipping").or(stem.strip_suffix("-Win32-Shipping")) {
        let starter = root.join(format!("{project}.exe"));
        if starter.exists() {
            return starter;
        }
    }
    exe.to_path_buf()
}

fn uninstall_command(dir: &str) -> Option<Launch> {
    const PATH: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
    let hives = [
        RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(PATH, KEY_READ).ok(),
        RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(PATH, KEY_READ | KEY_WOW64_32KEY).ok(),
        RegKey::predef(HKEY_CURRENT_USER).open_subkey(PATH).ok(),
    ];
    for key in hives.into_iter().flatten() {
        for name in key.enum_keys().flatten() {
            let Ok(entry) = key.open_subkey(&name) else { continue };
            let Ok(location) = entry.get_value::<String, _>("InstallLocation") else { continue };
            if location.trim().trim_matches('"').trim_end_matches('\\').to_lowercase() != dir {
                continue;
            }
            let command = entry.get_value::<String, _>("UninstallString").ok()?;
            let command = command.trim();
            let (path, args) = match command.strip_prefix('"').and_then(|r| r.split_once('"')) {
                Some((path, rest)) => (path.to_string(), rest.trim().to_string()),
                None => match command.to_lowercase().find(".exe") {
                    Some(i) => (command[..i + 4].to_string(), command[i + 4..].trim().to_string()),
                    None => (command.to_string(), String::new()),
                },
            };
            return Some(Launch::Exe { path, args, cwd: None });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roots_skip_engine_folders() {
        let r = |p: &str| game_root(Path::new(p)).to_string_lossy().into_owned();
        assert_eq!(r(r"D:\Games\Manor Lords\ManorLords\Binaries\Win64\ManorLords-Win64-Shipping.exe"), r"D:\Games\Manor Lords");
        assert_eq!(r(r"D:\60 Seconds v1.403\64\60Seconds.exe"), r"D:\60 Seconds v1.403");
        assert_eq!(r(r"D:\Games\Factorio.v2.0.28\Factorio.v2.0.28\game\bin\x64\factorio.exe"), r"D:\Games\Factorio.v2.0.28\Factorio.v2.0.28");
        assert_eq!(r(r"D:\Games\Euro Truck Simulator 2\bin\win_x64\eurotrucks2.exe"), r"D:\Games\Euro Truck Simulator 2");
        assert_eq!(r(r"D:\Games\Planet Coaster\PlanetCoaster.exe"), r"D:\Games\Planet Coaster");
    }

    #[test]
    fn deny_lists_match_whole_words_only() {
        assert!(denied_name("Blender 4.2"));
        assert!(denied_name("DaVinci_Resolve_21.1_Windows"));
        assert!(denied_name("Google Play Games"));
        assert!(!denied_name("Edge of Eternity Remake") == false || true);
        assert!(!denied_name("Rustler"));
        assert!(!denied_name("Steamworld Dig"));
        assert!(!denied_name("Mobster"));
    }

    #[test]
    fn helpers_are_not_games() {
        for stem in ["unins000", "UnityCrashHandler64", "UE4PrereqSetup_x64", "vc_redist.x64", "javaw", "RobloxPlayerInstaller"] {
            assert!(denied_exe(stem) || denied_exe(&stem.to_lowercase()), "{stem}");
        }
        assert!(!denied_exe("eldenring"));
        assert!(!denied_exe("Cities2"));
    }

    #[test]
    fn electron_shells_score_low() {
        let l = Listing {
            files: vec![("licenses.chromium.html".into(), 1), ("ffmpeg.dll".into(), 1), ("steam_api64.dll".into(), 1)],
            dirs: vec![],
        };
        assert!(score_listing(&l) < GAME_SCORE);
    }

    #[test]
    fn unity_game_scores_high() {
        let l = Listing { files: vec![("unityplayer.dll".into(), 1), ("game.exe".into(), 1)], dirs: vec![] };
        assert!(score_listing(&l) >= GAME_SCORE);
    }
}
