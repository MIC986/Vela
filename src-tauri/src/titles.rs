//! Title cleanup and comparison. Folder names of unpacked games carry version
//! numbers, release-group tags and dots; store titles carry edition suffixes.
//! All of them need to meet in the same comparable form.

use regex::Regex;
use std::sync::OnceLock;

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static regex"))
}

/// Comparable form: lowercase letters and digits, no editions or platform notes.
pub fn normalize(title: &str) -> String {
    static PAREN: OnceLock<Regex> = OnceLock::new();
    static SUFFIX: OnceLock<Regex> = OnceLock::new();
    let t = title.replace(['™', '®', '©', '’'], "");
    let t = t.to_lowercase();
    let t = re(&PAREN, r"\([^)]*\)|\[[^\]]*\]").replace_all(&t, " ");
    let t = re(
        &SUFFIX,
        r"(?x)
        \s*[-:–]?\s*
        (
          (standard|deluxe|ultimate|gold|premium|complete|definitive|goty|game\ of\ the\ year|enhanced\ edition\ remastered)\s+edition
          | windows(\s+10)?(\s+edition)?
          | pc\s+edition | for\s+windows(\s+10)?(\s*\+\s*launcher)? | for\s+pc | \bpc\b | game\s+preview
        )\s*$",
    )
    .replace(&t, "");
    t.chars().filter(|c| c.is_alphanumeric()).collect()
}

/// Turns a folder name like `Universe.Sandbox.2.Update.20.0.5` into a display title.
pub fn clean_folder_name(name: &str) -> String {
    static BRACKETS: OnceLock<Regex> = OnceLock::new();
    static AFTER_VERSION: OnceLock<Regex> = OnceLock::new();
    static TAGS: OnceLock<Regex> = OnceLock::new();
    static SPACES: OnceLock<Regex> = OnceLock::new();

    let mut s = name.to_string();
    s = re(&BRACKETS, r"\[[^\]]*\]|\([^)]*\)|\{[^}]*\}").replace_all(&s, " ").into_owned();
    // A dotted scene name has dots instead of spaces.
    if !s.contains(' ') {
        s = s.replace(['.', '_'], " ");
    }
    // A group suffix such as `inZOI-InsaneRamZes`.
    if let Some((head, tail)) = s.rsplit_once('-') {
        if !head.trim().is_empty() && !tail.contains(' ') && !tail.trim().is_empty() && !tail.chars().all(|c| c.is_ascii_digit()) {
            let tail_lower = tail.trim().to_ascii_lowercase();
            let looks_like_tag = tail.chars().any(|c| c.is_uppercase()) && tail.len() >= 3 && !head.contains(' ') || is_group(&tail_lower);
            if looks_like_tag {
                s = head.to_string();
            }
        }
    }
    s = re(
        &AFTER_VERSION,
        r"(?i)\b(v(er(sion)?)?\s?\d+([ .]\d+)*[a-z]?|(update|build|patch|hotfix|rev|גרסה|גירסה)\s*v?\d+([ .]\d+)*)\b.*$",
    )
    .replace(&s, "")
    .into_owned();
    s = re(
        &TAGS,
        r"(?i)\b(steamgg(\.net)?|codex|plaza|fitgirl|dodi|repack|repacks?|rune|empress|tenoke|skidrow|flt|razor1911|gog|p2p|steamrip|elamigos|all\s+dlcs?|incl(uding)?\s+.*|multi\s?\d+|early\s+access|portable|crack(ed)?|pc|x64|x86)\b",
    )
    .replace_all(&s, " ")
    .into_owned();
    s = re(&SPACES, r"\s+").replace_all(s.trim(), " ").into_owned();
    s.trim_matches(|c: char| c == '-' || c == '_' || c == '.' || c.is_whitespace()).to_string()
}

fn is_group(tag: &str) -> bool {
    ["codex", "plaza", "fitgirl", "dodi", "rune", "empress", "tenoke", "skidrow", "flt", "razor1911", "insaneramzes", "gog", "repack"].contains(&tag)
}

/// Whether two titles name the same game. Strict on purpose: a wrong match puts
/// another game's artwork on a tile, which is worse than a plain tile.
pub fn same_game(a: &str, b: &str) -> bool {
    let (na, nb) = (normalize(a), normalize(b));
    if na.is_empty() || nb.is_empty() {
        return false;
    }
    if na == nb {
        return true;
    }
    // Sequels differ by a digit or two, so similarity alone can't decide.
    let digits = |s: &str| s.chars().filter(|c| c.is_ascii_digit()).collect::<String>();
    if digits(&na) != digits(&nb) {
        return false;
    }
    na.len().min(nb.len()) >= 6 && strsim::jaro_winkler(&na, &nb) >= 0.96
}

/// A looser reading for loose folders, whose names often add what stores leave
/// out: `Beat Saber VR`, `Universe Sandbox 2`. Only used when nothing matched exactly.
pub fn same_base_game(store_title: &str, folder_title: &str) -> bool {
    static TRAILER: OnceLock<Regex> = OnceLock::new();
    let trimmed = re(&TRAILER, r"(?i)\s+(vr|\d+)\s*$").replace(folder_title, "");
    trimmed != folder_title && normalize(store_title) == normalize(&trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loose_titles_drop_only_a_trailing_marker() {
        assert!(same_base_game("Beat Saber", "Beat Saber VR"));
        assert!(same_base_game("Universe Sandbox", "Universe Sandbox 2"));
        assert!(!same_base_game("Beat Saber", "Beat Saber"));
        assert!(!same_base_game("Portal", "Half-Life 2"));
    }

    #[test]
    fn folder_names_become_titles() {
        assert_eq!(clean_folder_name("60 Seconds v1.403"), "60 Seconds");
        assert_eq!(clean_folder_name("Universe.Sandbox.2.Update.20.0.5"), "Universe Sandbox 2");
        assert_eq!(clean_folder_name("Town.To.City"), "Town To City");
        assert_eq!(clean_folder_name("ELDEN.RING.v1.16.1.ALL.DLC"), "ELDEN RING");
        assert_eq!(clean_folder_name("inZOI-InsaneRamZes"), "inZOI");
        assert_eq!(clean_folder_name("Factorio.v2.0.28"), "Factorio");
        assert_eq!(clean_folder_name("Taxi Life - A City Driving Simulator"), "Taxi Life - A City Driving Simulator");
        assert_eq!(clean_folder_name("C&C Generals [R.G. Mechanics]"), "C&C Generals");
        assert_eq!(clean_folder_name("WorldBox - God Simulator - SteamGG.NET"), "WorldBox - God Simulator");
        assert_eq!(clean_folder_name("Ages.of.Conflict.World.War.Simulator.Build.16113888.SteamGG.Net"), "Ages of Conflict World War Simulator");
        assert_eq!(clean_folder_name("מיקמק 2 גירסה 1.2"), "מיקמק 2");
    }

    #[test]
    fn normalization_ignores_editions_and_marks() {
        assert_eq!(normalize("Battlefield™ 6"), normalize("Battlefield 6"));
        assert_eq!(normalize("DayZ (Game Preview)"), normalize("DayZ"));
        assert_eq!(normalize("Cities: Skylines II - PC Edition"), normalize("Cities Skylines II"));
        assert_eq!(normalize("Minecraft Legends - Windows"), normalize("Minecraft Legends"));
        assert_eq!(normalize("Minecraft Dungeons for Windows + Launcher"), normalize("Minecraft Dungeons"));
        assert_ne!(normalize("Grand Theft Auto V Enhanced"), normalize("Grand Theft Auto V"));
    }

    #[test]
    fn sequels_never_match() {
        assert!(!same_game("Subnautica", "Subnautica 2"));
        assert!(!same_game("Forza Horizon 5", "Forza Horizon 6"));
        assert!(same_game("Town To City", "Town to City"));
    }
}
