// Bridge to the Rust side, the spring engine, and small DOM helpers.

const tauri = window.__TAURI__;

export const invoke = (command, args) => tauri.core.invoke(command, args);
export const listen = (event, handler) => tauri.event.listen(event, (e) => handler(e.payload));

export const artUrl = (kind, game) =>
  `http://art.localhost/${kind}/${encodeURIComponent(game.id)}?r=${game.art_rev ?? 0}`;

let thumbWidth = 320;

/** Sets the size, in device pixels, covers are asked for. Reports whether it changed. */
export function setThumbWidth(width) {
  const changed = width !== thumbWidth;
  thumbWidth = width;
  return changed;
}

/** A tile's cover, resampled for its exact size on this screen. */
export const thumbUrl = (game) => `${artUrl('cover', game)}&w=${thumbWidth}`;

export function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize);
export const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export const HOME_TILE_REM = 11.4;
export const LIBRARY_TILE_REM = 11.1;

/** A tile size setting as a multiple of the normal size. */
export const tileSize = (name) => ({ small: 0.84, large: 1.2 })[name] ?? 1;

/** Rounds to a whole device pixel. Art on a pixel boundary is sharp, and every tile matches. */
export const snap = (v) => Math.round(v * devicePixelRatio) / devicePixelRatio;

// One animation loop for everything; it stops itself when nothing is moving, so
// an idle launcher draws nothing and costs nothing.
const active = new Set();
let frame = 0;
let last = 0;

function tick(now) {
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  for (const fn of active) {
    if (fn(dt) === false) active.delete(fn);
  }
  frame = active.size ? requestAnimationFrame(tick) : 0;
}

export function animate(fn) {
  active.add(fn);
  if (!frame) {
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }
}

export class Spring {
  constructor(value, onChange, { stiffness = 210, damping = 30 } = {}) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.stiffness = stiffness;
    this.damping = damping;
    this.onChange = onChange;
    this.step = this.step.bind(this);
    this.running = false;
  }

  to(target) {
    this.target = target;
    if (this.reduced) return this.jump(target);
    if (!this.running) {
      this.running = true;
      animate(this.step);
    }
  }

  jump(value) {
    this.value = this.target = value;
    this.velocity = 0;
    this.onChange(value);
  }

  step(dt) {
    // Small fixed substeps keep the spring stable through a slow frame.
    let left = dt;
    while (left > 0) {
      const h = Math.min(left, 1 / 240);
      const accel = this.stiffness * (this.target - this.value) - this.damping * this.velocity;
      this.velocity += accel * h;
      this.value += this.velocity * h;
      left -= h;
    }
    if (Math.abs(this.target - this.value) < 0.05 && Math.abs(this.velocity) < 0.5) {
      this.value = this.target;
      this.velocity = 0;
      this.onChange(this.value);
      this.running = false;
      return false;
    }
    this.onChange(this.value);
  }
}

export function fmtPlaytime(minutes) {
  if (!minutes) return 'Not played yet';
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return hours < 100 ? `${hours.toFixed(1).replace(/\.0$/, '')} hours` : `${Math.round(hours).toLocaleString()} hours`;
}

export function fmtAgo(seconds) {
  if (!seconds) return 'Never';
  const now = Date.now() / 1000;
  const days = Math.floor((now - seconds) / 86400);
  if (days < 1) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(seconds * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtBytes(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i < 3 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export const GAME_PASS_PLANS = [
  ['ultimate', 'Game Pass Ultimate'],
  ['pc', 'PC Game Pass'],
  ['premium', 'Game Pass Premium'],
  ['essential', 'Game Pass Essential'],
];

export const STORE_NAMES = {
  steam: 'Steam', epic: 'Epic Games', xbox: 'Xbox', gog: 'GOG', ea: 'EA', ubisoft: 'Ubisoft', rockstar: 'Rockstar',
  battlenet: 'Battle.net', riot: 'Riot Games', amazon: 'Amazon Games', itch: 'itch.io', local: 'On this PC',
};
