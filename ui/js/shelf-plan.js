// Decides which shelves the Library's browse view shows, and in what order.
// Pure data in, data out, so it can be checked away from the interface.

const DAY = 86400;
const MAX_ITEMS = 24;

/** Words that end a series name rather than belong to it. */
const TAIL = new Set([
  'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'remastered', 'remake', 'edition', 'definitive', 'deluxe', 'goty', 'hd', 'enhanced',
  'complete', 'ultimate', 'anniversary', 'collection', 'windows', 'pc', 'for', 'the', 'of', 'and', 'a', 'an', 'demo', 'beta', 'launcher', 'online',
]);

/** Single words too common to name a series by themselves. */
const VAGUE = new Set([
  'the', 'super', 'total', 'world', 'dark', 'dead', 'final', 'grand', 'little', 'real', 'red', 'new', 'age', 'war', 'star', 'game', 'games',
  'simulator', 'call', 'mega', 'tiny', 'my', 'project', 'sid', 'tom', 'sniper', 'battle', 'space', 'city', 'car', 'farm', 'road', 'house', 'one',
  'microsoft', 'among', 'escape', 'cities', 'planet', 'death', 'night', 'last', 'first', 'free', 'just', 'pc', 'steam', 'xbox', 'epic', 'heroes',
  'legends', 'legend', 'king', 'kings', 'lord', 'lords', 'hello', 'house', 'blood', 'shadow', 'dragon', 'zombie', 'zombies',
]);

const words = (title) => title.toLowerCase().replace(/[™®©]/g, '').split(/[^\p{L}\p{N}']+/u).filter(Boolean);
/** The first `k` words of a title as written, with whatever stands between them. */
function opening(title, k) {
  const clean = title.replace(/[™®©]/g, '');
  const found = [...clean.matchAll(/[\p{L}\p{N}']+/gu)];
  const last = found[Math.min(k, found.length) - 1];
  return last ? clean.slice(0, last.index + last[0].length) : clean;
}

const hours = (game) => game.playtime / 60;

/** How much a set of games matters to this player right now. */
function engagement(games, now) {
  let total = 0;
  for (const game of games) {
    total += Math.log1p(hours(game)) * 1.6;
    const age = game.last_played ? (now - game.last_played) / DAY : Infinity;
    if (age < 7) total += 7;
    else if (age < 30) total += 3.5;
    else if (age < 180) total += 1;
    if (game.favorite) total += 2;
  }
  return total / Math.sqrt(Math.max(games.length, 1));
}

const byEngagement = (now) => (a, b) => engagement([b], now) - engagement([a], now) || a.title.localeCompare(b.title);

/**
 * Groups games that share the start of their names: "Forza Horizon 5" and "Forza
 * Motorsport" are both Forza. The longest shared start that still has three games wins.
 */
export function findSeries(games) {
  const counts = new Map();
  const starts = new Map();
  for (const game of games) {
    const w = words(game.title);
    const seen = new Set();
    for (let k = 1; k <= Math.min(3, w.length); k++) {
      const prefix = w.slice(0, k);
      if (TAIL.has(prefix[k - 1])) break;
      if (k === 1 && (VAGUE.has(prefix[0]) || prefix[0].length < 4 || /^\d+$/.test(prefix[0]))) continue;
      const key = prefix.join(' ');
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!starts.has(key)) starts.set(key, opening(game.title, k));
    }
  }
  const groups = new Map();
  for (const game of games) {
    const w = words(game.title);
    let best = null;
    for (let k = Math.min(3, w.length); k >= 1; k--) {
      const key = w.slice(0, k).join(' ');
      if ((counts.get(key) ?? 0) >= 3) {
        best = key;
        break;
      }
    }
    if (!best) continue;
    if (!groups.has(best)) groups.set(best, []);
    groups.get(best).push(game);
  }
  return [...groups.entries()].map(([key, list]) => ({ key, name: starts.get(key), games: list }));
}

/** Words that dress a title up without making it a different game. */
const DRESSING = new Set([...TAIL, 'java', 'bedrock', 'edition', 'game', 'standard', 'version']);
/** Words that mark a side release rather than the game itself. */
const SIDE = new Set(['preview', 'beta', 'demo', 'trial', 'test', 'server', 'dlc', 'pack', 'soundtrack', 'editor', 'tools']);

/**
 * The games whose art should stand for a series, best first: the one named most
 * plainly after it ("Minecraft" before "Minecraft Dungeons"), then the most played.
 */
/**
 * A series in the order you'd want to see it: what you're playing now, then what's
 * installed from newest to oldest, then the rest the same way, with previews last.
 */
export function seriesOrder(games, now = Date.now() / 1000) {
  const side = (g) => words(g.title).some((w) => SIDE.has(w));
  const recent = (g) => g.last_played && now - g.last_played < 30 * DAY;
  const rank = (g) => (side(g) ? 3 : recent(g) ? 0 : g.installed ? 1 : 2);
  return [...games].sort((a, b) => rank(a) - rank(b)
    || (rank(a) === 0 ? b.last_played - a.last_played : 0)
    || (b.year ?? 0) - (a.year ?? 0)
    || b.playtime - a.playtime
    || a.title.localeCompare(b.title));
}

export function seriesFaces(name, games) {
  const named = words(name).length;
  const extra = (game) => {
    const rest = words(game.title).slice(named);
    return rest.filter((w) => !DRESSING.has(w)).length + rest.filter((w) => SIDE.has(w)).length * 2;
  };
  return [...games].sort((a, b) => extra(a) - extra(b) || b.playtime - a.playtime || (b.year ?? 0) - (a.year ?? 0));
}

function shelf(id, kind, title, games, base, now, extra = {}) {
  return { id, kind, title, games: games.slice(0, MAX_ITEMS), total: games.length, score: base + engagement(games, now) * 4, ...extra };
}

const overlap = (a, b) => {
  const ids = new Set(b.games.map((g) => g.id));
  return a.games.filter((g) => ids.has(g.id)).length / Math.max(a.games.length, 1);
};

/** Every shelf worth showing, most relevant first. */
export function planShelves(games, collections = [], now = Date.now() / 1000) {
  const out = [];
  const installed = games.filter((g) => g.installed);
  const recent = games.filter((g) => g.last_played).sort((a, b) => b.last_played - a.last_played);

  if (recent.length) out.push({ ...shelf('recent', 'hero', 'Jump back in', recent.slice(0, 12), 0, now), score: 10000 });
  const downloading = games.filter((g) => g.progress != null);
  if (downloading.length) out.push({ ...shelf('downloading', 'row', 'Downloading', downloading, 0, now), score: 9000, subtitle: 'Installing in its store' });

  for (const name of collections) {
    const list = games.filter((g) => g.collections.includes(name)).sort(byEngagement(now));
    if (list.length) out.push(shelf(`collection:${name}`, 'row', name, list, 70, now, { subtitle: 'Your collection', filter: ['collection', name] }));
  }

  // Series get a stage of their own; the ones being played rise to the top.
  const series = findSeries(games)
    .map((s) => ({ ...s, games: seriesOrder(s.games, now) }))
    .sort((a, b) => engagement(b.games, now) * Math.sqrt(b.games.length) - engagement(a.games, now) * Math.sqrt(a.games.length));
  for (const s of series.slice(0, 6)) {
    const played = s.games.reduce((sum, g) => sum + g.playtime, 0);
    const lead = [...s.games].sort((a, b) => b.playtime - a.playtime)[0];
    out.push(shelf(`series:${s.key}`, 'theme', s.name, s.games, 62, now, { lead, faces: seriesFaces(s.name, s.games).slice(0, 4), played }));
  }

  const favorites = games.filter((g) => g.favorite).sort(byEngagement(now));
  if (favorites.length >= 2) out.push(shelf('favorites', 'row', 'Favorites', favorites, 66, now, { filter: ['status', 'favorites'] }));

  const mostPlayed = games.filter((g) => g.playtime >= 60).sort((a, b) => b.playtime - a.playtime);
  if (mostPlayed.length >= 4) out.push(shelf('played', 'row', 'Most played', mostPlayed, 52, now, { subtitle: 'All time, on every store' }));

  const added = games.filter((g) => g.added && now - g.added < 45 * DAY).sort((a, b) => b.added - a.added);
  if (added.length >= 3) out.push(shelf('added', 'row', 'New in your library', added, 46, now));

  const untouched = installed.filter((g) => !g.playtime && !g.last_played).sort((a, b) => (b.added ?? 0) - (a.added ?? 0));
  if (untouched.length >= 3) out.push(shelf('untouched', 'row', 'Installed, never played', untouched, 40, now, { subtitle: 'Ready when you are' }));

  // Genres weighted by what's played, so a racing fan sees racing before puzzles.
  const genres = new Map();
  for (const game of games) for (const genre of game.genres) {
    if (!genres.has(genre)) genres.set(genre, []);
    genres.get(genre).push(game);
  }
  const genreShelves = [...genres.entries()]
    .filter(([, list]) => list.length >= 5)
    .map(([genre, list]) => {
      const sorted = list.sort(byEngagement(now));
      const played = list.some((g) => g.playtime > 0);
      return shelf(`genre:${genre}`, 'row', genre, sorted, 30, now, { subtitle: played ? `Because you play ${genre.toLowerCase()} games` : null, filter: ['genre', genre] });
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  out.push(...genreShelves);

  const developers = new Map();
  for (const game of games) if (game.developer) {
    if (!developers.has(game.developer)) developers.set(game.developer, []);
    developers.get(game.developer).push(game);
  }
  out.push(...[...developers.entries()]
    .filter(([, list]) => list.length >= 3)
    .map(([dev, list]) => shelf(`dev:${dev}`, 'row', `From ${dev}`, list.sort(byEngagement(now)), 26, now))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2));

  const rated = games.filter((g) => (g.score ?? 0) >= 85).sort((a, b) => b.score - a.score);
  if (rated.length >= 4) out.push(shelf('rated', 'row', 'Highly rated', rated, 22, now, { subtitle: 'Loved by players' }));

  const owned = games.filter((g) => !g.installed && !g.gamepass && g.progress == null).sort(byEngagement(now));
  if (owned.length >= 3) out.push(shelf('owned', 'row', 'Ready to install', owned, 14, now, { subtitle: 'Games you own that aren’t on this PC', filter: ['status', 'available'] }));

  const pass = games.filter((g) => g.gamepass && !g.installed).sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.year ?? 0) - (a.year ?? 0));
  if (pass.length >= 3) out.push(shelf('gamepass', 'row', 'From your Game Pass plan', pass, 10, now, { filter: ['status', 'gamepass'] }));

  out.sort((a, b) => b.score - a.score);

  // A shelf mostly made of another's games adds nothing.
  const kept = [];
  for (const candidate of out) {
    if (candidate.kind !== 'hero' && kept.some((k) => overlap(candidate, k) > 0.75)) continue;
    kept.push(candidate);
  }
  // Two staged series in a row blur together; a plain shelf between them gives each room.
  for (let i = 1; i < kept.length - 1; i++) {
    if (kept[i].kind === 'theme' && kept[i - 1].kind === 'theme') {
      const next = kept.findIndex((s, j) => j > i && s.kind !== 'theme');
      if (next > 0) kept.splice(i, 0, kept.splice(next, 1)[0]);
    }
  }
  return kept;
}
