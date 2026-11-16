// Statistics: how much, what and where you play, drawn from the library and from
// every session Vela has watched.

import { animate, artUrl, clamp, el, escapeHtml, fmtBytes, fmtPlaytime, invoke, rem, snap, Spring, STORE_NAMES } from './core.js';
import { icons, storeIcon } from './icons.js';
import { inputMode } from './input.js';
import { play } from './sound.js';
import { setHints } from './ui.js';
import { store } from './state.js';

const DAY = 86400;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** Played games by how long they've been played, in hours. */
const SPREAD = [[0, 1, 'Under 1 h'], [1, 5, '1–5 h'], [5, 20, '5–20 h'], [20, 50, '20–50 h'], [50, 100, '50–100 h'], [100, Infinity, '100 h +']];
const RATINGS = [[0, 60, 'Under 60'], [60, 70, '60s'], [70, 80, '70s'], [80, 90, '80s'], [90, 101, '90 +']];
/** Colors for the genre ring, in order of size. */
const RING = ['125, 205, 255', '180, 150, 255', '255, 180, 110', '120, 230, 170', '255, 130, 160', '245, 210, 90', '150, 160, 185'];

const hoursOf = (minutes) => minutes / 60;
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const shortHours = (minutes) => {
  const h = hoursOf(minutes);
  return h >= 10 ? `${Math.round(h).toLocaleString()} h` : h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(minutes)} min`;
};

/** "3 days ago" in as few characters as fit at the end of a row. */
function fmtAgoShort(seconds) {
  const days = Math.floor((Date.now() / 1000 - seconds) / DAY);
  if (days < 1) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  const d = new Date(seconds * 1000);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function sumBy(list, fn) {
  return list.reduce((total, item) => total + fn(item), 0);
}

/** Everything the page shows, worked out once from the library and the session log. */
export function summarize(games, history, now = Date.now() / 1000) {
  const installed = games.filter((g) => g.installed);
  const played = games.filter((g) => g.playtime > 0);
  const minutes = sumBy(games, (g) => g.playtime);
  const genres = new Map();
  for (const game of played) {
    for (const genre of game.genres.slice(0, 2)) genres.set(genre, (genres.get(genre) ?? 0) + game.playtime / Math.min(game.genres.length, 2));
  }
  const stores = new Map();
  for (const game of games) {
    const entry = stores.get(game.source) ?? { source: game.source, games: 0, minutes: 0 };
    entry.games += 1;
    entry.minutes += game.playtime;
    stores.set(game.source, entry);
  }
  const months = [];
  const today = new Date(now * 1000);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    months.push({ label: MONTHS[d.getMonth()], year: d.getFullYear(), month: d.getMonth(), count: 0 });
  }
  for (const game of games) {
    if (!game.last_played) continue;
    const d = new Date(game.last_played * 1000);
    const slot = months.find((m) => m.year === d.getFullYear() && m.month === d.getMonth());
    if (slot) slot.count += 1;
  }
  const weeks = [];
  const weekStart = now - ((today.getDay() + 6) % 7) * DAY - (today.getHours() * 3600 + today.getMinutes() * 60);
  for (let i = 11; i >= 0; i--) weeks.push({ start: weekStart - i * 7 * DAY, seconds: 0 });
  for (const record of history) {
    const slot = weeks.findLast((w) => record.start >= w.start);
    if (slot) slot.seconds += record.seconds;
  }
  const years = new Map();
  for (const game of games) if (game.year) years.set(game.year, (years.get(game.year) ?? 0) + 1);
  const yearList = [...years.keys()].sort((a, b) => a - b);
  const decades = new Map();
  for (const year of yearList) {
    const decade = Math.floor(year / 5) * 5;
    decades.set(decade, (decades.get(decade) ?? 0) + years.get(year));
  }
  const developers = new Map();
  for (const game of games) if (game.developer) developers.set(game.developer, (developers.get(game.developer) ?? 0) + game.playtime + 1);
  const longest = history.reduce((best, r) => (r.seconds > (best?.seconds ?? 0) ? r : best), null);
  const monthAgo = now - 30 * DAY;
  const recentByGame = new Map();
  for (const r of history) if (r.start >= monthAgo) recentByGame.set(r.id, (recentByGame.get(r.id) ?? 0) + r.seconds);
  const topRecent = [...recentByGame.entries()].sort((a, b) => b[1] - a[1])[0];

  // When sessions start, by hour of the day and day of the week.
  const hours = Array(24).fill(0);
  const weekdays = Array(7).fill(0);
  for (const r of history) {
    const d = new Date(r.start * 1000);
    hours[d.getHours()] += r.seconds;
    weekdays[(d.getDay() + 6) % 7] += r.seconds;
  }
  const spread = SPREAD.map(([lo, hi, label]) => ({ label, count: played.filter((g) => hoursOf(g.playtime) >= lo && hoursOf(g.playtime) < hi).length }));
  const scored = games.filter((g) => g.score);
  const ratings = RATINGS.map(([lo, hi, label]) => ({ label, count: scored.filter((g) => g.score >= lo && g.score < hi).length }));
  const growth = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    growth.push({ label: MONTHS[d.getMonth()], year: d.getFullYear(), month: d.getMonth(), count: 0 });
  }
  for (const game of games) {
    if (!game.added) continue;
    const d = new Date(game.added * 1000);
    const slot = growth.find((m) => m.year === d.getFullYear() && m.month === d.getMonth());
    if (slot) slot.count += 1;
  }
  const makers = (field) => {
    const map = new Map();
    for (const game of games) {
      const name = game[field];
      if (!name) continue;
      const entry = map.get(name) ?? { name, games: 0, minutes: 0 };
      entry.games += 1;
      entry.minutes += game.playtime;
      map.set(name, entry);
    }
    return [...map.values()].sort((a, b) => b.minutes - a.minutes || b.games - a.games).slice(0, 6);
  };
  const yearHours = new Map();
  for (const game of played) if (game.year) yearHours.set(game.year, (yearHours.get(game.year) ?? 0) + game.playtime);
  const bestYear = [...yearHours.entries()].sort((a, b) => b[1] - a[1])[0];
  const avgScore = scored.length ? Math.round(sumBy(scored, (g) => g.score) / scored.length) : 0;
  const top10 = [...played].sort((a, b) => b.playtime - a.playtime).slice(0, 10).filter((g) => g.score);
  const avgTop = top10.length ? Math.round(sumBy(top10, (g) => g.score) / top10.length) : 0;
  return {
    hours,
    weekdays,
    spread,
    ratings,
    growth,
    developers: makers('developer'),
    publishers: makers('publisher'),
    recent: games.filter((g) => g.last_played).sort((a, b) => b.last_played - a.last_played).slice(0, 8),
    waiting: installed.filter((g) => !g.playtime && !g.last_played).sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.added ?? 0) - (a.added ?? 0)).slice(0, 8),
    bestYear,
    avgScore,
    avgTop,
    centuries: played.filter((g) => g.playtime >= 6000).length,
    games,
    installed,
    played,
    minutes,
    backlog: installed.filter((g) => !g.playtime && !g.last_played),
    size: sumBy(installed, (g) => g.size ?? 0),
    top: [...played].sort((a, b) => b.playtime - a.playtime).slice(0, 8),
    genres: [...genres.entries()].sort((a, b) => b[1] - a[1]),
    stores: [...stores.values()].sort((a, b) => b.games - a.games),
    months,
    weeks,
    tracked: sumBy(history, (r) => r.seconds),
    sessions: history.length,
    decades: [...decades.entries()],
    oldest: games.filter((g) => g.year).sort((a, b) => a.year - b.year)[0],
    newest: games.filter((g) => g.year).sort((a, b) => b.year - a.year)[0],
    best: games.filter((g) => g.score).sort((a, b) => b.score - a.score)[0],
    biggest: installed.filter((g) => g.size).sort((a, b) => b.size - a.size).slice(0, 5),
    developer: [...developers.entries()].sort((a, b) => b[1] - a[1])[0]?.[0],
    longest,
    topRecent: topRecent ? { id: topRecent[0], seconds: topRecent[1], title: history.find((r) => r.id === topRecent[0])?.title } : null,
  };
}

export class Stats {
  constructor(app) {
    this.app = app;
    this.root = el('section', 'view right', `
      <div class="st-scroll"><div class="st-track"></div></div>
      <div class="st-foot"></div>`);
    this.root.id = 'stats';
    this.scroll = this.root.querySelector('.st-scroll');
    this.track = this.root.querySelector('.st-track');
    this.items = [];
    this.index = 0;
    this.active = false;
    this.dirty = true;
    this.spring = new Spring(0, (v) => { this.track.style.transform = `translate3d(0,${-v}px,0)`; }, { stiffness: 190, damping: 30 });
    this.scroll.addEventListener('wheel', (e) => {
      this.spring.to(snap(clamp(this.spring.target + e.deltaY * 1.15, 0, this.maxScroll())));
    }, { passive: true });
    this.track.addEventListener('pointermove', (e) => {
      if (inputMode() !== 'mouse' || (!e.movementX && !e.movementY)) return;
      const node = e.target.closest('.st-focus');
      if (node) this.focus(this.items.indexOf(node), { scroll: false });
    });
    this.track.addEventListener('click', (e) => {
      const node = e.target.closest('[data-game]');
      if (node) this.openGame(node);
    });
    setHints(this.root.querySelector('.st-foot'), [
      { action: 'confirm', label: 'Open game' },
      { action: 'y', label: 'Search' },
    ], (a) => this.onAction(a));
    new ResizeObserver(() => this.spring.jump(clamp(this.spring.target, 0, this.maxScroll()))).observe(this.scroll);
  }

  maxScroll() {
    return Math.max(0, this.track.scrollHeight - this.scroll.clientHeight);
  }

  update() {
    this.dirty = true;
    // Already on screen: redrawn in place, without the entrance, and only if anything changed.
    if (this.active) this.render({ quiet: true });
  }

  async render({ quiet = false } = {}) {
    this.dirty = false;
    const extra = await invoke('get_stats').catch(() => ({ history: [], drives: [] }));
    const data = summarize(store.games, extra.history);
    const html = this.html(data, extra.drives);
    if (quiet && html === this.drawn) return;
    this.drawn = html;
    const remembered = this.items[this.index]?.dataset.key;
    this.track.classList.toggle('quiet', quiet);
    this.track.innerHTML = html;
    this.items = [...this.track.querySelectorAll('.st-focus')];
    const back = this.items.findIndex((n) => n.dataset.key === remembered);
    this.index = back >= 0 ? back : 0;
    this.paint();
    if (!quiet) this.countUp();
  }

  /** Big numbers count up to their value as the page appears. */
  countUp() {
    const nodes = [...this.track.querySelectorAll('[data-count]')];
    if (store.settings.reduced_motion) return;
    const start = performance.now();
    animate(() => {
      const t = Math.min((performance.now() - start) / 1100, 1);
      const eased = 1 - (1 - t) ** 4;
      for (const node of nodes) {
        const value = +node.dataset.count;
        const digits = +(node.dataset.digits ?? 0);
        node.textContent = (value * eased).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
      }
      return t < 1;
    });
  }

  html(d, drives) {
    const count = (value, digits = 0) => `<b data-count="${value}" data-digits="${digits}">${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}</b>`;
    const totalHours = hoursOf(d.minutes);
    const share = d.games.length ? Math.round((d.played.length / d.games.length) * 100) : 0;
    const kpis = `
      <div class="st-kpis">
        <div class="st-card st-kpi st-focus hero" data-key="kpi:time">${icons.clock}<small>Time played</small>${count(Math.round(totalHours))}<span>hours across ${plural(d.played.length, 'game')}</span></div>
        <div class="st-card st-kpi st-focus" data-key="kpi:games">${icons.grid}<small>In your library</small>${count(d.games.length)}<span>${d.installed.length.toLocaleString()} installed</span></div>
        <div class="st-card st-kpi st-focus" data-key="kpi:played">${icons.play}<small>Played</small><b><i data-count="${share}">${share}</i>%</b><span>of your games, at least once</span></div>
        <div class="st-card st-kpi st-focus" data-key="kpi:size">${icons.drive}<small>Installed size</small><b>${fmtBytes(d.size) || '0 B'}</b><span>on this PC</span></div>
        <div class="st-card st-kpi st-focus" data-key="kpi:backlog">${icons.sparkle}<small>Never played</small>${count(d.backlog.length)}<span>installed, waiting for you</span></div>
      </div>`;

    const maxTop = d.top[0]?.playtime ?? 1;
    const top = d.top.length ? d.top.map((g, i) => `
      <button class="st-row st-focus" data-key="top:${escapeHtml(g.id)}" data-game="${escapeHtml(g.id)}" style="--d:${i * 50}ms">
        <span class="st-rank">${i + 1}</span>
        <img src="${artUrl('cover', g)}&w=80" alt="" onerror="this.style.visibility='hidden'">
        <span class="st-name">${escapeHtml(g.title)}</span>
        <span class="st-bar"><i style="transform:scaleX(${g.playtime / maxTop})"></i></span>
        <span class="st-val">${shortHours(g.playtime)}</span>
      </button>`).join('') : '<p class="st-none">Play something and it shows up here.</p>';

    const genreTotal = d.genres.reduce((s, [, m]) => s + m, 0) || 1;
    const shown = d.genres.slice(0, 6);
    const rest = d.genres.slice(6).reduce((s, [, m]) => s + m, 0);
    const slices = [...shown, ...(rest ? [['Everything else', rest]] : [])];
    let at = 0;
    const circumference = 2 * Math.PI * 42;
    const arcs = slices.map(([, m], i) => {
      const length = (m / genreTotal) * circumference;
      const arc = `<circle r="42" cx="60" cy="60" style="--c:${RING[Math.min(i, RING.length - 1)]};stroke-dasharray:${Math.max(length - 1.6, 0.1)} ${circumference};stroke-dashoffset:${-at};--d:${i * 70}ms"></circle>`;
      at += length;
      return arc;
    }).join('');
    const legend = slices.map(([name, m], i) => `<div><i style="--c:${RING[Math.min(i, RING.length - 1)]}"></i><span>${escapeHtml(name)}</span><em>${Math.round((m / genreTotal) * 100)}%</em></div>`).join('');
    const genres = d.genres.length ? `<div class="st-ring"><svg viewBox="0 0 120 120">${arcs}</svg><div><b>${escapeHtml(d.genres[0][0])}</b><span>your top genre</span></div></div><div class="st-legend">${legend}</div>`
      : '<p class="st-none">Genres appear once games have details and playtime.</p>';

    const maxMonth = Math.max(...d.months.map((m) => m.count), 1);
    const monthBars = d.months.map((m, i) => `<div class="st-col" style="--d:${i * 40}ms"><span>${m.count || ''}</span><i style="--h:${m.count / maxMonth}"></i><small>${m.label}</small></div>`).join('');
    const maxWeek = Math.max(...d.weeks.map((w) => w.seconds), 1);
    const weekBars = d.weeks.map((w, i) => {
      const date = new Date(w.start * 1000);
      return `<div class="st-col" style="--d:${i * 40}ms"><span>${w.seconds >= 360 ? Math.round(w.seconds / 3600 * 10) / 10 : ''}</span><i style="--h:${w.seconds / maxWeek}"></i><small>${date.getDate()} ${MONTHS[date.getMonth()]}</small></div>`;
    }).join('');
    const activity = `
      <div class="st-card st-focus" data-key="months"><h3>Games played, by month</h3><p>Each game counted in the month you last played it.</p><div class="st-cols">${monthBars}</div></div>
      <div class="st-card st-focus" data-key="weeks"><h3>Hours with Vela, by week</h3><p>${d.sessions ? `${plural(d.sessions, 'session')}, ${fmtPlaytime(Math.round(d.tracked / 60))} in all.` : 'Starts filling in as you play through Vela.'}</p><div class="st-cols${d.sessions ? '' : ' empty'}">${weekBars}</div></div>`;

    const maxStore = Math.max(...d.stores.map((s) => s.games), 1);
    const stores = d.stores.slice(0, 7).map((s, i) => `
      <div class="st-store" style="--d:${i * 50}ms">${storeIcon(s.source)}<span>${escapeHtml(STORE_NAMES[s.source] ?? s.source)}</span>
      <span class="st-bar"><i style="transform:scaleX(${s.games / maxStore})"></i></span><em>${s.games.toLocaleString()}</em><small>${s.minutes ? shortHours(s.minutes) : ''}</small></div>`).join('');

    const maxDecade = Math.max(...d.decades.map(([, n]) => n), 1);
    const eras = d.decades.length ? `<div class="st-cols eras">${d.decades.map(([decade, n], i) => `<div class="st-col" style="--d:${i * 40}ms"><span>${n}</span><i style="--h:${n / maxDecade}"></i><small>${decade}</small></div>`).join('')}</div>`
      : '<p class="st-none">Release years appear once games have details.</p>';

    const fact = (key, icon, label, value, detail, game) => `<div class="st-card st-fact st-focus" data-key="fact:${key}"${game ? ` data-game="${escapeHtml(game.id)}"` : ''}>${icon}<small>${label}</small><b>${escapeHtml(value)}</b><span>${escapeHtml(detail)}</span></div>`;
    const facts = [
      d.longest && fact('longest', icons.clock, 'Longest session', fmtPlaytime(Math.round(d.longest.seconds / 60)), d.longest.title),
      d.topRecent && fact('month', icons.trophy, 'Most played this month', d.topRecent.title ?? 'A game', fmtPlaytime(Math.round(d.topRecent.seconds / 60))),
      d.genres[0] && fact('genre', icons.tag, 'Favorite genre', d.genres[0][0], `${shortHours(d.genres[0][1])} played`),
      d.developer && fact('dev', icons.store, 'Top developer', d.developer, 'by time played and games owned'),
      d.oldest && fact('oldest', icons.restart, 'Oldest game', d.oldest.title, `Released ${d.oldest.year}`, d.oldest),
      d.best && fact('best', icons.sparkle, 'Highest rated', d.best.title, `${d.best.score}% positive`, d.best),
      d.newest && fact('newest', icons.plus, 'Newest game', d.newest.title, `Released ${d.newest.year}`, d.newest),
      d.backlog.length && fact('backlog', icons.play, 'Up next?', d.backlog[0].title, 'Installed and never played', d.backlog[0]),
    ].filter(Boolean).join('');

    const maxSize = d.biggest[0]?.size ?? 1;
    const biggest = d.biggest.map((g, i) => `<button class="st-row st-focus small" data-key="big:${escapeHtml(g.id)}" data-game="${escapeHtml(g.id)}" style="--d:${i * 50}ms">
      <img src="${artUrl('cover', g)}&w=80" alt="" onerror="this.style.visibility='hidden'"><span class="st-name">${escapeHtml(g.title)}</span>
      <span class="st-bar"><i style="transform:scaleX(${g.size / maxSize})"></i></span><span class="st-val">${fmtBytes(g.size)}</span></button>`).join('');
    const driveRows = drives.map((drive) => {
      const used = 1 - drive.free / drive.total;
      return `<div class="st-drive"><div><span>${escapeHtml(drive.name)}</span><em>${fmtBytes(drive.free)} free of ${fmtBytes(drive.total)}</em></div><span class="st-bar wide"><i class="${used > 0.92 ? 'low' : ''}" style="transform:scaleX(${used})"></i></span></div>`;
    }).join('');

    return `
      <header class="st-head"><h1>Statistics</h1><p>How you play, from every store and every session Vela has seen.</p></header>
      ${kpis}
      <div class="st-two">
        <div class="st-card wide st-list"><h3>Most played</h3><p>All time, adding up every store.</p>${top}</div>
        <div class="st-card st-focus st-genres" data-key="genres"><h3>Genres you play</h3><p>Shared out by hours played.</p>${genres}</div>
      </div>
      <div class="st-two even">${activity}</div>
      <div class="st-two">
        <div class="st-card st-focus" data-key="stores"><h3>Stores</h3><p>Games in your library, and hours played, by store.</p>${stores}</div>
        <div class="st-card st-focus" data-key="eras"><h3>Release years</h3><p>When your games came out, in five-year steps.</p>${eras}</div>
      </div>
      ${facts ? `<h2 class="st-sub">Highlights</h2><div class="st-facts">${facts}</div>` : ''}
      ${this.moreHtml(d)}
      <h2 class="st-sub">Storage</h2>
      <div class="st-two">
        <div class="st-card st-list"><h3>Biggest installs</h3><p>${d.installed.length ? 'Where your space goes.' : ''}</p>${biggest || '<p class="st-none">Sizes appear for games from Steam and other stores that report them.</p>'}</div>
        <div class="st-card st-focus" data-key="drives"><h3>Drives</h3><p>Space on this PC.</p>${driveRows}</div>
      </div>`;
  }

  /** Habits, spread, growth, makers, ratings and lists: everything below the first screens. */
  moreHtml(d) {
    const columns = (list, value, label, note = (x) => value(x) || '') => {
      const max = Math.max(...list.map(value), 1);
      return list.map((x, i) => `<div class="st-col" style="--d:${i * 30}ms"><span>${note(x)}</span><i style="--h:${value(x) / max}"></i><small>${label(x, i)}</small></div>`).join('');
    };
    const hasHistory = d.hours.some(Boolean);
    const hourLabel = (_, i) => (i % 3 === 0 ? `${i}` : '');
    const hoursCard = `<div class="st-card st-focus" data-key="hours"><h3>When you play</h3><p>${hasHistory ? 'Time played by the hour it started, through Vela.' : 'Fills in as you play through Vela.'}</p>
      <div class="st-cols dense${hasHistory ? '' : ' empty'}">${columns(d.hours, (s) => s, hourLabel, () => '')}</div></div>`;
    const daysCard = `<div class="st-card st-focus" data-key="days"><h3>Days of the week</h3><p>${hasHistory ? 'Which days you play most.' : 'Fills in as you play through Vela.'}</p>
      <div class="st-cols${hasHistory ? '' : ' empty'}">${columns(d.weekdays, (s) => s, (_, i) => WEEKDAYS[i], (s) => (s >= 360 ? `${Math.round(s / 360) / 10} h` : ''))}</div></div>`;
    const spreadCard = `<div class="st-card st-focus" data-key="spread"><h3>How your hours spread</h3><p>Played games, by how long you've played each.</p>
      <div class="st-cols">${columns(d.spread, (x) => x.count, (x) => x.label)}</div></div>`;
    const growthTotal = d.growth.reduce((s, m) => s + m.count, 0);
    const growthCard = `<div class="st-card st-focus" data-key="growth"><h3>Your library growing</h3><p>${growthTotal ? `${plural(growthTotal, 'game')} added in the last year.` : 'New games show up here as you add them.'}</p>
      <div class="st-cols">${columns(d.growth, (m) => m.count, (m) => m.label)}</div></div>`;
    const makerList = (list) => {
      if (!list.length) return '<p class="st-none">Appears once games have details.</p>';
      const max = Math.max(...list.map((m) => m.minutes), 1);
      return list.map((m, i) => `<div class="st-maker" style="--d:${i * 50}ms"><span class="st-name">${escapeHtml(m.name)}</span><em>${plural(m.games, 'game')}</em>
        <span class="st-bar"><i style="transform:scaleX(${m.minutes / max})"></i></span><small>${m.minutes ? shortHours(m.minutes) : '—'}</small></div>`).join('');
    };
    const ratingCard = `<div class="st-card st-focus" data-key="ratings"><h3>Ratings</h3><p>${d.avgScore ? `Your library averages ${d.avgScore}% positive${d.avgTop ? `; your ten most played, ${d.avgTop}%` : ''}.` : 'Ratings come from Steam reviews.'}</p>
      <div class="st-cols">${columns(d.ratings, (x) => x.count, (x) => x.label)}</div></div>`;
    const row = (g, i, value) => `<button class="st-row st-focus small" data-key="row:${escapeHtml(g.id)}:${i}" data-game="${escapeHtml(g.id)}" style="--d:${i * 40}ms">
      <img src="${artUrl('cover', g)}&w=80" alt="" onerror="this.style.visibility='hidden'"><span class="st-name">${escapeHtml(g.title)}</span><span></span><span class="st-val">${value}</span></button>`;
    const recentCard = `<div class="st-card st-list"><h3>Recently played</h3><p>The last games you opened, on any store.</p>
      ${d.recent.map((g, i) => row(g, i, fmtAgoShort(g.last_played))).join('') || '<p class="st-none">Nothing played yet.</p>'}</div>`;
    const waitingCard = `<div class="st-card st-list"><h3>Waiting for you</h3><p>Installed, never started. Best rated first.</p>
      ${d.waiting.map((g, i) => row(g, i, g.score ? `${g.score}%` : '')).join('') || '<p class="st-none">You’ve started everything you installed.</p>'}</div>`;
    const days = Math.round((d.minutes / 60 / 24) * 10) / 10;
    const average = d.played.length ? Math.round(d.minutes / d.played.length) : 0;
    const topStore = d.stores[0];
    const fact = (key, icon, label, value, detail) => `<div class="st-card st-fact st-focus" data-key="fact:${key}">${icon}<small>${label}</small><b>${escapeHtml(value)}</b><span>${escapeHtml(detail)}</span></div>`;
    const facts = [
      d.minutes && fact('nonstop', icons.clock, 'If you played nonstop', `${days.toLocaleString()} days`, 'every hour you’ve played, back to back'),
      average && fact('average', icons.play, 'Average per game', fmtPlaytime(average), 'across games you’ve played'),
      fact('centuries', icons.trophy, 'Over 100 hours', plural(d.centuries, 'game'), d.centuries ? 'real favorites' : 'none yet'),
      topStore && fact('store', icons.store, 'Biggest store', STORE_NAMES[topStore.source] ?? topStore.source, `${plural(topStore.games, 'game')} in your library`),
      d.bestYear && fact('year', icons.sparkle, 'Your best year of games', `${d.bestYear[0]}`, `${shortHours(d.bestYear[1])} in games from that year`),
    ].filter(Boolean).join('');
    return `
      <h2 class="st-sub">Your habits</h2>
      <div class="st-two even">${hoursCard}${daysCard}</div>
      <h2 class="st-sub">Your collection</h2>
      <div class="st-two even">${spreadCard}${growthCard}</div>
      <div class="st-two even">
        <div class="st-card st-focus" data-key="devs"><h3>Top developers</h3><p>By hours played, then by games owned.</p>${makerList(d.developers)}</div>
        <div class="st-card st-focus" data-key="pubs"><h3>Top publishers</h3><p>By hours played, then by games owned.</p>${makerList(d.publishers)}</div>
      </div>
      <div class="st-two even">${ratingCard}<div class="st-card st-focus st-facts-col" data-key="more-facts">${facts}</div></div>
      <div class="st-two even">${recentCard}${waitingCard}</div>`;
  }

  paint() {
    this.items.forEach((node, i) => node.classList.toggle('focused', this.active && i === this.index));
  }

  focus(index, { scroll = true } = {}) {
    if (index < 0 || index === this.index) return;
    this.index = index;
    this.paint();
    if (scroll) this.reveal();
  }

  reveal() {
    const node = this.items[this.index];
    if (!node) return;
    const box = node.getBoundingClientRect();
    const view = this.scroll.getBoundingClientRect();
    const top = box.top - view.top + this.spring.value;
    const margin = rem() * 2;
    let target = this.spring.target;
    if (top - margin < target) target = top - margin;
    else if (top + box.height + margin > target + view.height) target = top + box.height + margin - view.height;
    if (this.index === 0) target = 0;
    this.spring.to(snap(clamp(target, 0, this.maxScroll())));
  }

  /** The nearest item in a direction, measured on screen, so any layout can be crossed. */
  nearest(direction) {
    const from = this.items[this.index]?.getBoundingClientRect();
    if (!from) return -1;
    const [fx, fy] = [from.left + from.width / 2, from.top + from.height / 2];
    let best = -1;
    let bestScore = Infinity;
    for (const [i, node] of this.items.entries()) {
      if (i === this.index) continue;
      const box = node.getBoundingClientRect();
      const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
      const dx = x - fx;
      const dy = y - fy;
      const ahead = { up: -dy, down: dy, left: -dx, right: dx }[direction];
      const across = direction === 'up' || direction === 'down' ? Math.abs(dx) : Math.abs(dy);
      const overlapping = direction === 'left' || direction === 'right' ? box.bottom > from.top + 4 && box.top < from.bottom - 4 : true;
      if (ahead <= 4 || !overlapping) continue;
      const score = ahead + across * 2.2;
      if (score < bestScore) [best, bestScore] = [i, score];
    }
    return best;
  }

  setActive(on) {
    this.active = on;
    if (on && this.dirty) this.render();
    else this.paint();
  }

  openGame(node) {
    const game = store.byId.get(node.dataset.game);
    if (game) this.app.openGame(game);
  }

  onAction(action) {
    switch (action) {
      case 'up': case 'down': case 'left': case 'right': {
        const next = this.nearest(action);
        if (next >= 0) {
          play('move');
          this.focus(next);
        } else if (action === 'up') this.app.focusTop();
        break;
      }
      case 'lt': this.spring.to(snap(clamp(this.spring.target - this.scroll.clientHeight * 0.8, 0, this.maxScroll()))); break;
      case 'rt': this.spring.to(snap(clamp(this.spring.target + this.scroll.clientHeight * 0.8, 0, this.maxScroll()))); break;
      case 'confirm': {
        const node = this.items[this.index];
        if (node?.dataset.game) this.openGame(node);
        break;
      }
      case 'y': this.app.openSearch(); break;
      default: return false;
    }
    return true;
  }
}
