//! Serves artwork to the interface over the `art://` scheme.
//!
//! Each image is resolved once from its ordered sources, stored in the cache
//! folder, and served from disk from then on. A game with no artwork anywhere
//! answers 404 and the interface draws a poster instead.
//!
//! Covers always come out 2:3. Tiles ask for a thumbnail at their exact screen
//! size, resampled here with a far better filter than the browser's, which keeps
//! them sharp at any window size and small in memory.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use image::codecs::jpeg::JpegEncoder;
use image::imageops::{self, FilterType};
use image::{DynamicImage, ImageReader, RgbImage};
use tauri::http::{header, Response, StatusCode};
use tauri::{AppHandle, Manager};

use crate::model::Game;
use crate::store::{fnv, lock, State};
use crate::win;

/// Largest single image accepted from the network.
const MAX_BYTES: u64 = 16 * 1024 * 1024;
/// How long to remember that an image doesn't exist.
const MISS_TTL: Duration = Duration::from_secs(600);
/// Thumbnails snap to this step, so resizing a window can't fill the disk.
const THUMB_STEP: u32 = 40;
const THUMB_MAX_AGE: Duration = Duration::from_secs(30 * 86_400);
/// A composed cover, for art that isn't already 2:3.
const COVER_SIZE: (u32, u32) = (800, 1200);
/// Art this close to 2:3 is shown whole; anything further would lose its edges.
const RATIO_TOLERANCE: f32 = 0.03;

struct Gate {
    limit: usize,
    used: Mutex<usize>,
    freed: Condvar,
}

impl Gate {
    const fn new(limit: usize) -> Self {
        Gate { limit, used: Mutex::new(0), freed: Condvar::new() }
    }

    fn with<T>(&self, f: impl FnOnce() -> T) -> T {
        struct Slot<'a>(&'a Gate);
        impl Drop for Slot<'_> {
            fn drop(&mut self) {
                *lock(&self.0.used) -= 1;
                self.0.freed.notify_one();
            }
        }
        {
            let mut used = lock(&self.used);
            while *used >= self.limit {
                used = self.freed.wait(used).unwrap_or_else(|e| e.into_inner());
            }
            *used += 1;
        }
        let _slot = Slot(self);
        f()
    }
}

/// A grid can ask for hundreds of images at once.
static DOWNLOADS: Gate = Gate::new(8);
static RESIZES: Gate = Gate::new(3);

fn misses() -> &'static Mutex<HashMap<String, Instant>> {
    static MISSES: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    MISSES.get_or_init(Default::default)
}

fn missed_recently(key: &str) -> bool {
    lock(misses()).get(key).is_some_and(|t| t.elapsed() < MISS_TTL)
}

fn mime_of(bytes: &[u8]) -> &'static str {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [0xFF, 0xD8, ..] => "image/jpeg",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        [b'G', b'I', b'F', ..] => "image/gif",
        _ => "application/octet-stream",
    }
}

fn sized_url(url: &str, kind: &str) -> String {
    // Microsoft's image host resizes on request; originals run to 4K and beyond.
    if url.contains("store-images.s-microsoft.com") && !url.contains('?') {
        let width = if kind == "cover" { 800 } else { 3840 };
        format!("{url}?w={width}&q=88")
    } else {
        url.to_string()
    }
}

fn download(url: &str) -> Option<Vec<u8>> {
    let response = crate::meta::agent().get(url).call().ok()?;
    let mut bytes = Vec::new();
    response.into_reader().take(MAX_BYTES).read_to_end(&mut bytes).ok()?;
    (mime_of(&bytes).starts_with("image/")).then_some(bytes)
}

fn fetch(state: &State, source: &str, kind: &str) -> Option<Vec<u8>> {
    if source.starts_with("http") {
        if !lock(&state.settings).online() {
            return None;
        }
        DOWNLOADS.with(|| download(&sized_url(source, kind)))
    } else {
        fs::read(source).ok().filter(|b| mime_of(b).starts_with("image/"))
    }
}

fn cache_path(state: &State, id: &str, kind: &str, sources: &[String]) -> PathBuf {
    // Keyed on the sources, so better art found later replaces what's cached.
    // Heroes carry a tag: they were once fetched too small for wide screens.
    let tag = if kind == "hero" { "hero-3840" } else { kind };
    let key = format!("{id}|{tag}|{}", sources.join("|"));
    state.dir.join("art").join(format!("{:016x}", fnv(&key)))
}

fn icon_path(state: &State, exe: &str) -> PathBuf {
    state.dir.join("art").join(format!("{:016x}.icon", fnv(exe)))
}

fn dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    ImageReader::new(Cursor::new(bytes)).with_guessed_format().ok()?.into_dimensions().ok()
}

fn is_tall(bytes: &[u8]) -> bool {
    dimensions(bytes).is_some_and(|(w, h)| (w as f32 / h as f32 - 2.0 / 3.0).abs() <= RATIO_TOLERANCE)
}

fn encode_jpeg(image: &RgbImage, quality: u8) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, quality).encode_image(image).ok()?;
    Some(out)
}

/// Fits art of any shape onto a 2:3 card, whole, over a blurred copy of itself.
fn compose_cover(bytes: &[u8]) -> Option<Vec<u8>> {
    let art = image::load_from_memory(bytes).ok()?.to_rgb8();
    let (width, height) = COVER_SIZE;
    let (art_w, art_h) = art.dimensions();
    let scale = (width as f32 / art_w as f32).min(height as f32 / art_h as f32);
    let (fit_w, fit_h) = (((art_w as f32 * scale) as u32).max(1), ((art_h as f32 * scale) as u32).max(1));
    let fitted = imageops::resize(&art, fit_w, fit_h, FilterType::Lanczos3);

    // Blurring a tiny copy looks the same as blurring a full one, for a fraction of the work.
    let tiny = DynamicImage::ImageRgb8(art).resize_to_fill(width / 10, height / 10, FilterType::Triangle).to_rgb8();
    let mut card = imageops::resize(&imageops::blur(&tiny, 5.0), width, height, FilterType::Triangle);
    for pixel in card.pixels_mut() {
        pixel.0 = pixel.0.map(|v| (v as f32 * 0.6) as u8);
    }
    imageops::replace(&mut card, &fitted, ((width - fit_w) / 2) as i64, ((height - fit_h) / 2) as i64);
    encode_jpeg(&card, 90)
}

fn resolve_cover(state: &State, game: &Game) -> Option<Vec<u8>> {
    let path = cache_path(state, &game.id, "cover", &game.art.cover);
    let cached = fs::read(&path).ok();
    if let Some(bytes) = cached.as_ref().filter(|b| is_tall(b)) {
        return Some(bytes.clone());
    }
    let miss_key = path.display().to_string();
    if cached.is_none() && missed_recently(&miss_key) {
        return None;
    }
    // The first true cover wins; failing that, the best art there is gets composed.
    // A game with no cover at all can still borrow its wide art.
    let mut fallback = cached;
    for source in game.art.cover.iter().take(4).chain(game.art.hero.iter().take(1)) {
        let Some(bytes) = fetch(state, source, "cover") else { continue };
        if is_tall(&bytes) {
            let _ = fs::write(&path, &bytes);
            return Some(bytes);
        }
        fallback.get_or_insert(bytes);
    }
    let Some(raw) = fallback else {
        lock(misses()).insert(miss_key, Instant::now());
        return None;
    };
    let composed = RESIZES.with(|| compose_cover(&raw)).unwrap_or(raw);
    let _ = fs::write(&path, &composed);
    Some(composed)
}

/// `width` is in device pixels; the result is never upscaled.
fn resolve_thumb(state: &State, game: &Game, width: u32) -> Option<Vec<u8>> {
    let cover = resolve_cover(state, game)?;
    let width = width.clamp(THUMB_STEP, COVER_SIZE.0).div_ceil(THUMB_STEP) * THUMB_STEP;
    let (natural_w, natural_h) = dimensions(&cover)?;
    if natural_w <= width {
        return Some(cover);
    }
    let path = cache_path(state, &game.id, "cover", &game.art.cover).with_extension(format!("t{width}"));
    if let Ok(bytes) = fs::read(&path) {
        return Some(bytes);
    }
    let height = (width as f32 * natural_h as f32 / natural_w as f32).round() as u32;
    let bytes = RESIZES.with(|| {
        let full = image::load_from_memory(&cover).ok()?.to_rgb8();
        encode_jpeg(&imageops::resize(&full, width, height, FilterType::Lanczos3), 93)
    })?;
    let _ = fs::write(&path, &bytes);
    Some(bytes)
}

fn resolve_plain(state: &State, game: &Game, kind: &str, sources: &[String]) -> Option<Vec<u8>> {
    let path = cache_path(state, &game.id, kind, sources);
    if let Ok(bytes) = fs::read(&path) {
        return Some(bytes);
    }
    let miss_key = path.display().to_string();
    if missed_recently(&miss_key) {
        return None;
    }
    let found = sources.iter().find_map(|s| fetch(state, s, kind));
    match &found {
        Some(bytes) => {
            let _ = fs::write(&path, bytes);
        }
        None => {
            lock(misses()).insert(miss_key, Instant::now());
        }
    }
    found
}

fn resolve(state: &State, kind: &str, id: &str, width: Option<u32>) -> Option<Vec<u8>> {
    let game = state.game(id)?;
    match kind {
        "cover" => match width {
            Some(width) => resolve_thumb(state, &game, width),
            None => resolve_cover(state, &game),
        },
        "hero" => resolve_plain(state, &game, kind, &game.art.hero),
        "logo" => resolve_plain(state, &game, kind, &game.art.logo),
        "icon" => icon(state, game.exe.as_deref()),
        _ => None,
    }
}

fn icon(state: &State, exe: Option<&str>) -> Option<Vec<u8>> {
    let exe = exe.filter(|e| Path::new(e).exists())?;
    let path = icon_path(state, exe);
    if let Ok(bytes) = fs::read(&path) {
        return Some(bytes);
    }
    let _com = win::ComScope::new();
    let bytes = shrink_blurry_icon(win::exe_icon_png(Path::new(exe), 256)?);
    let _ = fs::write(&path, &bytes);
    Some(bytes)
}

/// Windows stretches small icons to the size asked for. Those are smooth all the
/// way through, and look far better shown small and sharp.
fn shrink_blurry_icon(png: Vec<u8>) -> Vec<u8> {
    const SMALL: u32 = 64;
    let Ok(image) = image::load_from_memory(&png) else { return png };
    let rgba = image.to_rgba8();
    let (w, h) = rgba.dimensions();
    let small = imageops::resize(&rgba, SMALL, SMALL, FilterType::Triangle);
    let back = imageops::resize(&small, w, h, FilterType::Triangle);
    let difference: u64 = rgba.as_raw().iter().zip(back.as_raw()).map(|(a, b)| a.abs_diff(*b) as u64).sum();
    if difference / rgba.as_raw().len().max(1) as u64 >= 3 {
        return png;
    }
    let mut out = Cursor::new(Vec::new());
    match DynamicImage::ImageRgba8(small).write_to(&mut out, image::ImageFormat::Png) {
        Ok(()) => out.into_inner(),
        Err(_) => png,
    }
}

/// Handles `art://<kind>/<id>?w=<device pixels>` requests from the interface.
pub fn respond(app: &AppHandle, uri_path: &str, query: Option<&str>) -> Response<Vec<u8>> {
    let state = app.state::<State>();
    let mut parts = uri_path.trim_start_matches('/').splitn(2, '/');
    let kind = parts.next().unwrap_or_default();
    let id = parts.next().map(percent_decode).unwrap_or_default();
    let width = query.and_then(|q| q.split('&').find_map(|p| p.strip_prefix("w="))).and_then(|w| w.parse().ok());
    let found = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| resolve(&state, kind, &id, width))).ok().flatten();
    let builder = Response::builder().header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    match found {
        Some(bytes) => builder
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime_of(&bytes))
            .header(header::CACHE_CONTROL, "public, max-age=604800")
            .body(bytes),
        None => builder.status(StatusCode::NOT_FOUND).body(Vec::new()),
    }
    .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(b) = hex {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The file stems this game's art lives under, thumbnails included.
fn stems(state: &State, game: &Game) -> Vec<String> {
    let art = &game.art;
    let mut paths: Vec<PathBuf> =
        [("cover", &art.cover), ("hero", &art.hero), ("logo", &art.logo)].into_iter().map(|(kind, sources)| cache_path(state, &game.id, kind, sources)).collect();
    paths.extend(game.exe.as_deref().map(|exe| icon_path(state, exe)));
    paths.iter().filter_map(|p| p.file_stem()).map(|s| s.to_string_lossy().into_owned()).collect()
}

fn stem_of(name: &str) -> &str {
    name.split('.').next().unwrap_or(name)
}

/// Lets images that couldn't be found be tried again straight away.
pub fn forget_misses() {
    lock(misses()).clear();
}

/// Drops one game's images, so they're fetched fresh on next use.
pub fn forget(state: &State, game: &Game) {
    let stems: HashSet<String> = stems(state, game).into_iter().collect();
    for entry in fs::read_dir(state.dir.join("art")).into_iter().flatten().flatten() {
        if stems.contains(stem_of(&entry.file_name().to_string_lossy())) {
            let _ = fs::remove_file(entry.path());
        }
    }
    forget_misses();
}

/// Whether a cached file has outlived the games and sizes that use it.
fn is_stale(name: &str, age: Duration, keep: &HashSet<String>) -> bool {
    let thumbnail = name.rsplit_once('.').is_some_and(|(_, ext)| ext.starts_with('t') && ext[1..].parse::<u32>().is_ok());
    !keep.contains(stem_of(name)) || (thumbnail && age > THUMB_MAX_AGE)
}

/// Clears out art replaced by better art, or left by games no longer in the library.
pub fn prune(state: &State) {
    let games = lock(&state.games).clone();
    if games.is_empty() {
        return;
    }
    let keep: HashSet<String> = games.iter().flat_map(|g| stems(state, g)).collect();
    for entry in fs::read_dir(state.dir.join("art")).into_iter().flatten().flatten() {
        let modified = entry.metadata().and_then(|m| m.modified()).unwrap_or_else(|_| SystemTime::now());
        let age = modified.elapsed().unwrap_or_default();
        if is_stale(&entry.file_name().to_string_lossy(), age, &keep) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Fetches art ahead of time, so tiles are ready before they're ever on screen.
/// Stops at once if a game starts: the machine belongs to the game then.
pub fn prefetch(app: &AppHandle) {
    let state = app.state::<State>();
    let games = lock(&state.games).clone();
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..4 {
            scope.spawn(|| {
                while let Some(game) = games.get(next.fetch_add(1, Ordering::Relaxed)) {
                    if lock(&state.session).is_some() {
                        return;
                    }
                    resolve_cover(&state, game);
                    if game.installed {
                        resolve_plain(&state, game, "hero", &game.art.hero);
                        resolve_plain(&state, game, "logo", &game.art.logo);
                    }
                }
            });
        }
    });
}

/// Copies an image the user chose into Vela's own folder, returning the copy's path.
pub fn keep_custom(state: &State, source: &Path, id: &str, kind: &str) -> Result<String, String> {
    let bytes = fs::read(source).map_err(|e| e.to_string())?;
    if !mime_of(&bytes).starts_with("image/") {
        return Err("That file isn't an image.".into());
    }
    let dir = state.dir.join("custom");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // A new name every time: the art cache is keyed on this path.
    let stamp = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_nanos();
    let path = dir.join(format!("{:016x}", fnv(&format!("{id}|{kind}|{stamp}"))));
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

pub fn drop_custom(path: Option<String>) {
    if let Some(path) = path {
        let _ = fs::remove_file(path);
    }
}

/// Empties the image cache; images come back on demand.
pub fn clear_cache(state: &State) -> u64 {
    let dir = state.dir.join("art");
    let mut freed = 0;
    for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
        freed += entry.metadata().map(|m| m.len()).unwrap_or(0);
        let _ = fs::remove_file(entry.path());
    }
    forget_misses();
    freed
}

pub fn cache_size(state: &State) -> u64 {
    fs::read_dir(state.dir.join("art")).into_iter().flatten().flatten().map(|e| e.metadata().map(|m| m.len()).unwrap_or(0)).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    fn jpeg(width: u32, height: u32) -> Vec<u8> {
        encode_jpeg(&RgbImage::from_fn(width, height, |x, _| Rgb([(x % 256) as u8, 90, 200])), 90).unwrap()
    }

    #[test]
    fn percent_decoding_handles_ids_and_bad_input() {
        assert_eq!(percent_decode("steam%3A730"), "steam:730");
        assert_eq!(percent_decode("a%2"), "a%2");
        assert_eq!(percent_decode("a%zz"), "a%zz");
        assert_eq!(percent_decode("%41"), "A");
    }

    #[test]
    fn mime_detection() {
        assert_eq!(mime_of(&[0xFF, 0xD8, 0xFF]), "image/jpeg");
        assert_eq!(mime_of(b"<html>"), "application/octet-stream");
    }

    #[test]
    fn microsoft_images_get_sized() {
        assert_eq!(sized_url("https://store-images.s-microsoft.com/image/a", "cover"), "https://store-images.s-microsoft.com/image/a?w=800&q=88");
        assert_eq!(sized_url("https://store-images.s-microsoft.com/image/a", "hero"), "https://store-images.s-microsoft.com/image/a?w=3840&q=88");
        assert_eq!(sized_url("https://cdn/a.jpg", "cover"), "https://cdn/a.jpg");
    }

    #[test]
    fn only_near_two_by_three_counts_as_a_cover() {
        assert!(is_tall(&jpeg(600, 900)));
        assert!(!is_tall(&jpeg(1200, 1600)), "3:4 would lose its sides");
        assert!(!is_tall(&jpeg(800, 800)));
    }

    #[test]
    fn composing_turns_any_shape_into_a_cover() {
        for (w, h) in [(1200, 1600), (600, 600), (1920, 620), (100, 900)] {
            let composed = compose_cover(&jpeg(w, h)).unwrap();
            assert_eq!(dimensions(&composed), Some(COVER_SIZE), "{w}x{h}");
        }
    }

    #[test]
    fn staleness_keeps_what_is_used() {
        let keep: HashSet<String> = ["aaaa".to_string()].into();
        let (fresh, old) = (Duration::from_secs(60), THUMB_MAX_AGE * 2);
        assert!(!is_stale("aaaa", old, &keep));
        assert!(!is_stale("aaaa.icon", old, &keep));
        assert!(!is_stale("aaaa.t280", fresh, &keep));
        assert!(is_stale("aaaa.t280", old, &keep), "an old thumbnail size goes");
        assert!(is_stale("bbbb", fresh, &keep), "art no game uses goes");
        assert!(is_stale("bbbb.t280", fresh, &keep));
    }

    #[test]
    fn stretched_icons_shrink_and_detailed_ones_stay() {
        let png = |image: image::RgbaImage| {
            let mut out = Cursor::new(Vec::new());
            image.write_to(&mut out, image::ImageFormat::Png).unwrap();
            out.into_inner()
        };
        let smooth = png(image::RgbaImage::from_fn(256, 256, |x, y| image::Rgba([(x / 2) as u8, (y / 2) as u8, 80, 255])));
        let detailed = png(image::RgbaImage::from_fn(256, 256, |x, y| image::Rgba([((x ^ y) % 2 * 255) as u8, 0, 0, 255])));
        assert_eq!(dimensions(&shrink_blurry_icon(smooth)), Some((64, 64)));
        assert_eq!(dimensions(&shrink_blurry_icon(detailed)), Some((256, 256)));
    }

    #[test]
    fn a_gate_never_lets_more_through_than_its_limit() {
        static GATE: Gate = Gate::new(2);
        let peak = Mutex::new((0usize, 0usize));
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    GATE.with(|| {
                        {
                            let mut p = lock(&peak);
                            p.0 += 1;
                            p.1 = p.1.max(p.0);
                        }
                        std::thread::sleep(Duration::from_millis(5));
                        lock(&peak).0 -= 1;
                    });
                });
            }
        });
        assert!(lock(&peak).1 <= 2);
    }
}
