use serde::{Deserialize, Serialize};

/// How a game (or its installer page) is started.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Launch {
    /// A protocol link such as `steam://rungameid/730`.
    Url { url: String },
    /// A program on disk.
    Exe {
        path: String,
        #[serde(default)]
        args: String,
        #[serde(default)]
        cwd: Option<String>,
    },
    /// A packaged app, started through its AppUserModelID.
    Aumid { aumid: String },
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Meta {
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub developer: Option<String>,
    #[serde(default)]
    pub publisher: Option<String>,
    #[serde(default)]
    pub year: Option<i32>,
    #[serde(default)]
    pub genres: Vec<String>,
    /// 0-100.
    #[serde(default)]
    pub score: Option<u8>,
    #[serde(default)]
    pub screenshots: Vec<String>,
}

/// Ordered candidates for each artwork slot: remote URLs or local file paths.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct ArtSources {
    #[serde(default)]
    pub cover: Vec<String>,
    #[serde(default)]
    pub hero: Vec<String>,
    #[serde(default)]
    pub logo: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Game {
    pub id: String,
    pub title: String,
    pub source: String,
    pub installed: bool,
    #[serde(default)]
    pub install_dir: Option<String>,
    /// More folders the game may run from. Xbox games live in two places at once.
    #[serde(default)]
    pub extra_dirs: Vec<String>,
    #[serde(default)]
    pub exe: Option<String>,
    #[serde(default)]
    pub launch: Option<Launch>,
    /// Where to send the user to install this game.
    #[serde(default)]
    pub install: Option<Launch>,
    #[serde(default)]
    pub uninstall: Option<Launch>,
    #[serde(default)]
    pub size: Option<u64>,
    /// Unix seconds, as reported by the store.
    #[serde(default)]
    pub last_played: Option<i64>,
    /// Minutes, as reported by the store.
    #[serde(default)]
    pub playtime: Option<u64>,
    #[serde(default)]
    pub added: Option<i64>,
    #[serde(default)]
    pub gamepass: bool,
    #[serde(default)]
    pub steam_appid: Option<u32>,
    /// Microsoft Store product id.
    #[serde(default)]
    pub store_id: Option<String>,
    /// Package family name for packaged games.
    #[serde(default)]
    pub pfn: Option<String>,
    /// 0..1 while the store is downloading the game.
    #[serde(default)]
    pub progress: Option<f32>,
    #[serde(default)]
    pub meta: Meta,
    #[serde(default)]
    pub art: ArtSources,
    /// Changes whenever this game's artwork does, so the interface reloads it.
    #[serde(skip)]
    pub art_rev: u32,
}

impl Game {
    pub fn new(id: impl Into<String>, title: impl Into<String>, source: &str) -> Self {
        Game { id: id.into(), title: title.into(), source: source.to_string(), ..Default::default() }
    }

    /// Every folder this game's processes can run from.
    pub fn run_dirs(&self) -> Vec<String> {
        let mut dirs: Vec<String> = self.install_dir.iter().cloned().collect();
        dirs.extend(self.extra_dirs.iter().cloned());
        dirs
    }
}

/// A store's copy of a game that shares its title with the tile the user sees.
#[derive(Clone, Debug, Serialize)]
pub struct Variant {
    pub id: String,
    pub source: String,
    pub installed: bool,
}

/// The light form of a game sent to the interface.
#[derive(Clone, Debug, Serialize)]
pub struct GameView {
    pub id: String,
    pub title: String,
    pub source: String,
    pub installed: bool,
    pub gamepass: bool,
    pub favorite: bool,
    pub size: Option<u64>,
    pub last_played: Option<i64>,
    pub playtime: u64,
    pub added: Option<i64>,
    pub year: Option<i32>,
    pub developer: Option<String>,
    pub publisher: Option<String>,
    pub genres: Vec<String>,
    pub score: Option<u8>,
    pub progress: Option<f32>,
    pub has_install: bool,
    pub variants: Vec<Variant>,
    /// Bumped when artwork sources change so the interface refreshes images.
    pub art_rev: u32,
    /// Whether the user has renamed this game or given it their own art.
    pub customized: bool,
    /// Whether Vela can start removing an installed copy.
    pub can_uninstall: bool,
    /// The user's collections this game is in.
    pub collections: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct GameDetail {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub screenshots: Vec<String>,
    pub install_dir: Option<String>,
    pub can_uninstall: bool,
    pub hidden: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub start_fullscreen: bool,
    pub start_with_windows: bool,
    pub start_minimized: bool,
    /// "close" drops the interface entirely, "minimize" keeps it in the taskbar, "keep" leaves it open.
    pub launch_behavior: String,
    pub restore_on_exit: bool,
    pub guide_button: bool,
    pub show_uninstalled: bool,
    pub gamepass_on: bool,
    /// "ultimate", "pc", "premium" or "essential".
    pub gamepass_plan: String,
    /// Whether the question about Game Pass has been answered.
    pub gamepass_asked: bool,
    pub online_art: bool,
    /// Whether the first-run question about online artwork has been answered.
    pub online_art_asked: bool,
    pub sound: bool,
    pub volume: f32,
    pub reduced_motion: bool,
    pub ambient_motion: bool,
    pub accent: String,
    pub clock_24h: bool,
    pub show_seconds: bool,
    pub ui_scale: f32,
    pub glyphs: String,
    pub scan_folders: Vec<String>,
    /// "home" or "library".
    pub start_tab: String,
    pub show_clock: bool,
    pub show_date: bool,
    /// "art" shows artwork sharp, "soft" blurs it, "color" keeps only its color.
    pub background: String,
    /// How strongly the background shows, 0..1.
    pub background_level: f32,
    /// "sharp", "soft" or "round".
    pub corners: String,
    pub focus_glow: bool,
    /// "recent", "favorites", "played", "added" or "az".
    pub home_order: String,
    pub home_count: u32,
    pub home_installed_only: bool,
    /// "small", "medium" or "large", here and in `library_tile_size`.
    pub home_tile_size: String,
    pub home_details: bool,
    pub home_logos: bool,
    pub library_tile_size: String,
    pub library_titles: bool,
    /// "deep", "normal" or "bright".
    pub sound_tone: String,
    pub swap_ab: bool,
    /// "slow", "normal" or "fast".
    pub repeat_speed: String,
    /// The screen Vela opens and goes full screen on, by Windows' name for it. Empty for the main one.
    pub display: String,
}

impl Settings {
    /// Nothing leaves this PC until the user has seen what would be sent.
    pub fn online(&self) -> bool {
        self.online_art && self.online_art_asked
    }
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            start_fullscreen: false,
            start_with_windows: false,
            start_minimized: false,
            launch_behavior: "close".into(),
            restore_on_exit: true,
            guide_button: true,
            show_uninstalled: true,
            gamepass_on: false,
            gamepass_plan: "ultimate".into(),
            gamepass_asked: false,
            online_art: true,
            online_art_asked: false,
            sound: true,
            volume: 0.5,
            reduced_motion: false,
            ambient_motion: true,
            accent: "auto".into(),
            clock_24h: true,
            show_seconds: false,
            ui_scale: 1.0,
            glyphs: "auto".into(),
            scan_folders: Vec::new(),
            start_tab: "home".into(),
            show_clock: true,
            show_date: true,
            background: "art".into(),
            background_level: 1.0,
            corners: "soft".into(),
            focus_glow: true,
            home_order: "recent".into(),
            home_count: 32,
            home_installed_only: true,
            home_tile_size: "medium".into(),
            home_details: true,
            home_logos: true,
            library_tile_size: "medium".into(),
            library_titles: false,
            sound_tone: "normal".into(),
            swap_ab: false,
            repeat_speed: "normal".into(),
            display: String::new(),
        }
    }
}

/// The user's own name and images for a game. Image fields hold local file paths.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Look {
    pub title: Option<String>,
    pub cover: Option<String>,
    pub hero: Option<String>,
    pub logo: Option<String>,
}

impl Look {
    pub fn is_empty(&self) -> bool {
        *self == Look::default()
    }

    /// The user's images replace the store's outright: a choice, not a suggestion.
    pub fn apply_art(&self, art: &mut ArtSources) {
        for (chosen, slot) in [(&self.cover, &mut art.cover), (&self.hero, &mut art.hero), (&self.logo, &mut art.logo)] {
            if let Some(path) = chosen {
                *slot = vec![path.clone()];
            }
        }
    }
}

/// Everything the user decided or played, kept apart from what scans find.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UserData {
    pub favorites: Vec<String>,
    pub hidden: Vec<String>,
    pub custom: Vec<Game>,
    /// Seconds played while Vela watched, by id.
    pub played: std::collections::HashMap<String, u64>,
    pub last_played: std::collections::HashMap<String, i64>,
    /// First time each id was seen, for "recently added".
    pub first_seen: std::collections::HashMap<String, i64>,
    /// How many times the user has asked for fresh artwork, by id.
    pub art_bust: std::collections::HashMap<String, u32>,
    /// Customized games, by title key, so a game's copies on every store match.
    pub looks: std::collections::HashMap<String, Look>,
    /// Every play session Vela watched, oldest first.
    pub history: Vec<PlayRecord>,
    pub collections: Vec<Collection>,
}

/// One play session.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PlayRecord {
    pub id: String,
    pub title: String,
    /// Unix seconds.
    pub start: i64,
    pub seconds: u64,
}

/// A group of games the user made. Games are kept by title key, like looks.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Collection {
    pub name: String,
    pub games: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_look_replaces_only_the_art_it_sets() {
        let mut art = ArtSources { cover: vec!["store-cover".into(), "other".into()], hero: vec!["store-hero".into()], logo: vec![] };
        let look = Look { cover: Some("mine".into()), ..Default::default() };
        look.apply_art(&mut art);
        assert_eq!(art.cover, ["mine"]);
        assert_eq!(art.hero, ["store-hero"]);
        assert!(art.logo.is_empty());
    }

    #[test]
    fn settings_from_an_older_version_keep_their_values_and_gain_defaults() {
        let old: Settings = serde_json::from_str(r#"{"ui_scale":1.2,"accent":"120, 230, 170"}"#).unwrap();
        assert_eq!(old.ui_scale, 1.2);
        assert_eq!(old.accent, "120, 230, 170");
        assert_eq!(old.home_count, 32);
        assert_eq!(old.background, "art");
        assert!(old.show_clock);
    }

    #[test]
    fn game_pass_starts_off_and_older_settings_files_still_load() {
        let old: Settings = serde_json::from_str(r#"{"ui_scale":1.2,"show_gamepass":true,"gamepass":"auto"}"#).unwrap();
        assert_eq!(old.ui_scale, 1.2);
        assert!(!old.gamepass_on);
        assert!(!old.gamepass_asked);
        assert_eq!(old.gamepass_plan, "ultimate");
    }
}
