//! Starting games and following them until they close.
//!
//! Stores start games indirectly, so there's no process handle to wait on. The
//! one reliable signal is any process running from the game's own folder, which
//! works the same for every store and costs one process-list read per poll.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::model::{Game, PlayRecord};
use crate::store::{lock, now, State};
use crate::{win, window};

/// How long a store may take to bring a game up (Steam may have to start first).
const START_TIMEOUT: Duration = Duration::from_secs(180);
/// Games often restart themselves through a launcher; a gap this short isn't an exit.
const EXIT_GRACE: Duration = Duration::from_secs(4);

#[derive(Clone, Serialize)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub detected: bool,
    #[serde(skip)]
    token: u64,
    #[serde(skip)]
    cancelled: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
pub struct Finished {
    pub id: String,
    pub title: String,
    pub seconds: u64,
    pub detected: bool,
}

/// What one look at the running processes means.
#[derive(Debug, PartialEq)]
enum Step {
    Waiting,
    Started,
    Playing,
    Ended { seconds: u64 },
    NeverStarted,
}

/// Follows a game from launch to exit. Time is passed in, so every path through
/// it can be checked without waiting for it.
struct Tracker {
    launched: Instant,
    began: Option<Instant>,
    last_seen: Instant,
}

impl Tracker {
    fn new(now: Instant) -> Self {
        Tracker { launched: now, began: None, last_seen: now }
    }

    fn observe(&mut self, now: Instant, running: bool) -> Step {
        if running {
            self.last_seen = now;
        }
        match self.began {
            None if running => {
                self.began = Some(now);
                Step::Started
            }
            None if now - self.launched >= START_TIMEOUT => Step::NeverStarted,
            None => Step::Waiting,
            Some(began) if !running && now - self.last_seen > EXIT_GRACE => Step::Ended { seconds: (self.last_seen - began).as_secs() },
            Some(_) => Step::Playing,
        }
    }
}

/// Finds the game's processes. While a known one lives, that's all it has to
/// check, which is far cheaper than reading the whole process list.
struct Finder {
    dirs: Vec<String>,
    known: Option<u32>,
}

impl Finder {
    fn new(game: &Game) -> Self {
        let dirs = game.run_dirs().iter().map(|d| format!("{}\\", d.replace('/', "\\").trim_end_matches('\\').to_lowercase())).collect();
        Finder { dirs, known: None }
    }

    fn owns(&self, path: &str) -> bool {
        self.dirs.iter().any(|d| path.starts_with(d.as_str()))
    }

    fn running(&mut self) -> bool {
        // A pid can be reused, so the path has to match as well.
        if self.known.is_some_and(|pid| win::process_path(pid).is_some_and(|path| self.owns(&path))) {
            return true;
        }
        self.known = win::process_paths().iter().find(|(_, path)| self.owns(path)).map(|(pid, _)| *pid);
        self.known.is_some()
    }
}

pub fn launch(app: &AppHandle, id: &str) -> Result<(), String> {
    let state = app.state::<State>();
    let game = state.game(id).ok_or("That game is no longer in your library.")?;
    let launch = game.launch.clone().ok_or("This game has no way to start yet.")?;
    win::shell_open(&launch)?;

    static NEXT: AtomicU64 = AtomicU64::new(1);
    let token = NEXT.fetch_add(1, Ordering::Relaxed);
    let cancelled = Arc::new(AtomicBool::new(false));
    let title = state.shown_title(&game);
    if let Some(old) = lock(&state.session).replace(Session {
        id: game.id.clone(),
        title,
        detected: false,
        token,
        cancelled: cancelled.clone(),
    }) {
        old.cancelled.store(true, Ordering::SeqCst);
    }

    let app = app.clone();
    std::thread::spawn(move || follow(app, game, token, cancelled));
    Ok(())
}

/// Sends the launcher back without stopping the game.
pub fn cancel(app: &AppHandle) {
    if let Some(session) = lock(&app.state::<State>().session).take() {
        session.cancelled.store(true, Ordering::SeqCst);
    }
}

fn follow(app: AppHandle, game: Arc<Game>, token: u64, cancelled: Arc<AtomicBool>) {
    let state = app.state::<State>();
    let settings = lock(&state.settings).clone();
    let behavior = settings.launch_behavior.as_str();

    // Let the launch animation play, then get out of the way.
    std::thread::sleep(Duration::from_millis(1400));
    if cancelled.load(Ordering::SeqCst) {
        return;
    }
    match behavior {
        "keep" => {}
        "minimize" => window::minimize(&app),
        _ => window::hide(&app),
    }

    let mut finder = Finder::new(&game);
    let mut tracker = Tracker::new(Instant::now());
    let mut guide = None;
    let mut detected = false;
    let mut played = 0;
    let mut next_check = Instant::now();
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return;
        }
        let now = Instant::now();
        if now >= next_check {
            next_check = now + if detected { Duration::from_secs(2) } else { Duration::from_secs(1) };
            match tracker.observe(now, finder.running()) {
                Step::Started => {
                    detected = true;
                    if let Some(s) = lock(&state.session).as_mut() {
                        s.detected = true;
                    }
                    let _ = app.emit("session-started", game.id.clone());
                    // Only now is it safe to drop the interface: the game really is running.
                    if behavior == "close" {
                        window::destroy(&app);
                        win::trim_memory();
                    }
                    guide = settings.guide_button.then(win::GuideButton::new);
                }
                Step::Ended { seconds } => {
                    played = seconds;
                    break;
                }
                Step::NeverStarted => break,
                Step::Waiting | Step::Playing => {}
            }
        }
        if guide.as_ref().is_some_and(win::GuideButton::pressed) {
            window::open(&app);
            std::thread::sleep(Duration::from_secs(1));
        }
        std::thread::sleep(Duration::from_millis(250));
    }

    {
        let mut user = lock(&state.user);
        *user.played.entry(game.id.clone()).or_default() += played;
        user.last_played.insert(game.id.clone(), now());
        if played > 0 {
            let title = user.looks.get(&crate::scan::title_key(&game.title)).and_then(|l| l.title.clone()).unwrap_or_else(|| game.title.clone());
            user.history.push(PlayRecord { id: game.id.clone(), title, start: now() - played as i64, seconds: played });
        }
    }
    state.save_user();
    {
        let mut session = lock(&state.session);
        if session.as_ref().is_some_and(|s| s.token == token) {
            *session = None;
        }
    }
    let finished = Finished { id: game.id.clone(), title: state.shown_title(&game), seconds: played, detected };
    *lock(&state.last_session) = Some(finished.clone());
    if settings.restore_on_exit || !detected {
        window::open(&app);
    }
    let _ = app.emit("session-ended", finished);
    let _ = app.emit("library-updated", ());
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEC: Duration = Duration::from_secs(1);

    #[test]
    fn a_game_that_never_appears_times_out() {
        let start = Instant::now();
        let mut tracker = Tracker::new(start);
        assert_eq!(tracker.observe(start + START_TIMEOUT - SEC, false), Step::Waiting);
        assert_eq!(tracker.observe(start + START_TIMEOUT, false), Step::NeverStarted);
    }

    #[test]
    fn a_game_appearing_at_the_last_moment_still_counts() {
        let start = Instant::now();
        let mut tracker = Tracker::new(start);
        assert_eq!(tracker.observe(start + START_TIMEOUT - SEC, true), Step::Started);
        assert_eq!(tracker.observe(start + START_TIMEOUT + SEC, true), Step::Playing, "the start timeout is over once it runs");
    }

    #[test]
    fn a_restart_through_a_launcher_is_not_an_exit() {
        let start = Instant::now();
        let mut tracker = Tracker::new(start);
        tracker.observe(start, true);
        assert_eq!(tracker.observe(start + EXIT_GRACE, false), Step::Playing);
        assert_eq!(tracker.observe(start + EXIT_GRACE + SEC, true), Step::Playing);
        assert_eq!(tracker.observe(start + EXIT_GRACE * 2, false), Step::Playing, "the grace period restarts");
    }

    #[test]
    fn exit_counts_time_played_without_the_grace_period() {
        let start = Instant::now();
        let mut tracker = Tracker::new(start);
        tracker.observe(start + SEC * 5, true);
        tracker.observe(start + SEC * 65, true);
        assert_eq!(tracker.observe(start + SEC * 65 + EXIT_GRACE, false), Step::Playing);
        assert_eq!(tracker.observe(start + SEC * 66 + EXIT_GRACE, false), Step::Ended { seconds: 60 });
    }

    #[test]
    fn finder_matches_whole_folders_only() {
        let mut game = Game::new("g", "Game", "local");
        game.install_dir = Some("D:/Games/Portal/".into());
        let finder = Finder::new(&game);
        assert!(finder.owns("d:\\games\\portal\\portal.exe"));
        assert!(!finder.owns("d:\\games\\portal 2\\portal2.exe"));
    }
}
