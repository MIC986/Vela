// Pieces shared by every screen: tiles, hints, toasts, the backdrop and layers.

import { artUrl, el, escapeHtml, thumbUrl } from './core.js';
import { icons } from './icons.js';
import { inputMode, padType, SWAPPED } from './input.js';
import { store } from './state.js';

/* Tiles ------------------------------------------------------------------ */

function hue(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export const posterStyle = (title) => {
  const h = hue(title);
  return `background:linear-gradient(155deg,hsl(${h} 24% 21%),hsl(${(h + 48) % 360} 30% 11%))`;
};

export function makeTile() {
  const tile = el('div', 'tile', `
    <div class="t-card">
      <div class="t-clip">
        <img class="t-cover" decoding="async" alt="">
        <div class="t-poster"></div>
        <div class="t-shine"></div>
        <div class="t-state"><span>${icons.download}<b></b></span><u><i></i></u></div>
      </div>
      <div class="t-badges"></div>
      <div class="t-ring"></div>
    </div>
    <div class="t-caption"></div>`);
  const cover = tile.querySelector('.t-cover');
  const poster = tile.querySelector('.t-poster');
  cover.addEventListener('load', () => {
    cover.classList.add('ready');
    poster.classList.remove('on');
  });
  cover.addEventListener('error', () => showPoster(tile));
  return tile;
}

function showPoster(tile) {
  const game = tile._game;
  if (!game) return;
  tile.querySelector('.t-cover').removeAttribute('src');
  tile._artless = true;
  const poster = tile.querySelector('.t-poster');
  poster.innerHTML = `${game.source === 'local' ? `<img alt="" src="${artUrl('icon', game)}" onerror="this.remove()">` : ''}<span>${escapeHtml(game.title)}</span>`;
  poster.classList.add('on');
}

export function fillTile(tile, game, { caption = false, note = null } = {}) {
  const key = `${game.id}|${game.art_rev}`;
  if (tile._key !== key) {
    tile._key = key;
    tile._game = game;
    tile._src = thumbUrl(game);
    tile._artless = false;
    const cover = tile.querySelector('.t-cover');
    cover.classList.remove('ready');
    // The name on its color first, so a tile is never a blank hole while its image arrives.
    tile.querySelector('.t-clip').setAttribute('style', posterStyle(game.title));
    const poster = tile.querySelector('.t-poster');
    poster.innerHTML = `<span>${escapeHtml(game.title)}</span>`;
    poster.classList.add('on');
    cover.src = tile._src;
  } else if (tile._src !== thumbUrl(game)) {
    // A new size for the same art: the old image stays up until this one is ready.
    tile._src = thumbUrl(game);
    if (!tile._artless) tile.querySelector('.t-cover').src = tile._src;
  }
  tile._game = game;
  const busy = game.progress != null;
  tile.classList.toggle('missing', !game.installed && !busy);
  tile.classList.toggle('busy', busy);
  if (busy) {
    tile.querySelector('.t-state i').style.transform = `scaleX(${game.progress})`;
    tile.querySelector('.t-state b').textContent = `${Math.floor(game.progress * 100)}%`;
  }
  const badges = [];
  if (game.favorite) badges.push(`<span class="t-badge t-fav">${icons.heartFill}</span>`);
  if (!game.installed) badges.push(`<span class="t-badge t-get">${icons.download}</span>`);
  const badgeHtml = badges.join('');
  const box = tile.querySelector('.t-badges');
  if (box._html !== badgeHtml) {
    box._html = badgeHtml;
    box.innerHTML = badgeHtml;
  }
  if (caption) {
    const box = tile.querySelector('.t-caption');
    if (note) box.innerHTML = `${escapeHtml(game.title)}<small>${escapeHtml(note)}</small>`;
    else box.textContent = game.title;
  }
}

/* Button hints ------------------------------------------------------------ */

const KEY_LABELS = { confirm: 'Enter', back: 'Esc', x: 'Space', y: '/', menu: 'M', view: 'F', lb: 'Q', rb: 'E', lt: 'PgUp', rt: 'PgDn' };

function glyph(wanted) {
  if (inputMode() !== 'gamepad') return `<span class="glyph key">${KEY_LABELS[wanted] ?? wanted}</span>`;
  const action = store.settings?.swap_ab ? (SWAPPED[wanted] ?? wanted) : wanted;
  const style = store.settings?.glyphs === 'auto' ? padType() ?? 'xbox' : store.settings?.glyphs;
  if (style === 'playstation') {
    const face = { confirm: ['a', '✕'], back: ['b', '○'], x: ['x', '□'], y: ['y', '△'] }[action];
    if (face) return `<span class="glyph ps ${face[0]}">${face[1]}</span>`;
    const label = { menu: 'Options', view: 'Create', lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2' }[action];
    return `<span class="glyph pill">${label}</span>`;
  }
  const face = { confirm: ['a', 'A'], back: ['b', 'B'], x: ['x', 'X'], y: ['y', 'Y'] }[action];
  if (face) return `<span class="glyph ${face[0]}">${face[1]}</span>`;
  if (action === 'menu') return `<span class="glyph">${icons.menu}</span>`;
  if (action === 'view') return `<span class="glyph">${icons.view}</span>`;
  return `<span class="glyph pill">${{ lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT' }[action]}</span>`;
}

const mountedHints = new Set();

/**
 * Renders clickable hints into `node`. They redraw when the input device changes.
 * With a mouse the screen speaks for itself, so only those marked `mouse` stay.
 */
export function setHints(node, hints, onAction) {
  node._hints = { hints, onAction };
  mountedHints.add(node);
  drawHints(node);
}

function drawHints(node) {
  const { hints, onAction } = node._hints;
  node.classList.add('hints');
  const shown = inputMode() === 'mouse' ? hints.filter((h) => h.mouse) : hints;
  node.innerHTML = shown.map((h) => `<button class="hint" data-action="${h.action}">${glyph(h.action)}${escapeHtml(h.label)}</button>`).join('');
  node.onclick = (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action) onAction(action);
  };
}

export function redrawHints() {
  for (const node of mountedHints) {
    if (node.isConnected) drawHints(node);
    else mountedHints.delete(node);
  }
}

/* Logos -------------------------------------------------------------------- */

const logoProbe = el('canvas');
logoProbe.width = 64;
logoProbe.height = 32;
const logoPaint = logoProbe.getContext('2d', { willReadFrequently: true });

/** Logos made for a bright page would vanish on dark art. */
function isDarkLogo(image) {
  try {
    logoPaint.clearRect(0, 0, 64, 32);
    logoPaint.drawImage(image, 0, 0, 64, 32);
    const { data } = logoPaint.getImageData(0, 0, 64, 32);
    let [solid, dark] = [0, 0];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      solid += 1;
      if (data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11 < 72) dark += 1;
    }
    return solid > 0 && dark / solid > 0.3;
  } catch {
    return false;
  }
}

/** Resolves with a decoded logo, turned white if it would otherwise be unreadable. */
export function loadLogo(game, className = '') {
  const image = new Image();
  image.alt = '';
  image.className = className;
  image.crossOrigin = 'anonymous';
  image.src = artUrl('logo', game);
  return image.decode().then(() => {
    image.classList.toggle('dark-logo', isDarkLogo(image));
    return image;
  });
}

/* Toasts ------------------------------------------------------------------ */

export function toast(title, detail, icon = icons.info) {
  const box = document.getElementById('toasts');
  const item = el('div', 'toast', `${icon}<div>${escapeHtml(title)}${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</div>`);
  box.append(item);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => {
    item.classList.add('out');
    item.addEventListener('animationend', () => item.remove(), { once: true });
  }, 4200);
}

/* Layers ------------------------------------------------------------------ */

export const layers = {
  stack: [],
  top() {
    return this.stack[this.stack.length - 1];
  },
  push(layer) {
    this.stack.push(layer);
    document.getElementById('overlays').append(layer.el);
    this.sync();
  },
  remove(layer) {
    this.stack = this.stack.filter((l) => l !== layer);
    this.sync();
    this.top()?.onResume?.();
  },
  sync() {
    document.body.classList.toggle('overlay-full', this.stack.some((l) => l.full));
  },
};

/** Plays an element's exit animation, then removes it. */
export function closeWith(node, nodes = [node]) {
  for (const n of nodes) n.classList.add('closing');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    node.remove();
  };
  node.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 420);
}

/** One highlight that slides from row to row, instead of each row lighting up. */
export class Glide {
  constructor(parent) {
    this.node = parent.appendChild(el('i', 'glide'));
  }

  to(row) {
    const { node } = this;
    const first = !node.classList.contains('on');
    if (!row) return node.classList.remove('on');
    if (first) node.style.transition = 'none';
    node.style.width = `${row.offsetWidth}px`;
    node.style.height = `${row.offsetHeight}px`;
    node.style.transform = `translate3d(${row.offsetLeft}px,${row.offsetTop}px,0)`;
    node.classList.add('on');
    if (first) {
      void node.offsetWidth;
      node.style.transition = '';
    }
  }
}

/** A flat, focusable list with optional wrap, used by menus and bars. */
export class FocusList {
  constructor(items = [], onChange = () => {}) {
    this.items = items;
    this.index = 0;
    this.onChange = onChange;
    this.active = true;
  }
  set(items, index = 0) {
    this.items.forEach((i) => i.classList.remove('focused'));
    this.items = items;
    this.index = Math.min(index, Math.max(items.length - 1, 0));
    this.paint();
  }
  paint() {
    this.items.forEach((item, i) => item.classList.toggle('focused', this.active && i === this.index));
    this.onChange(this.items[this.index], this.index);
  }
  focus(index) {
    this.index = index;
    this.paint();
  }
  setActive(on) {
    this.active = on;
    this.paint();
  }
  get current() {
    return this.items[this.index];
  }
}

/* Backdrop ---------------------------------------------------------------- */

class Backdrop {
  constructor() {
    this.root = document.getElementById('backdrop');
    this.layers = [...this.root.querySelectorAll('.bd-layer')];
    this.ambient = this.root.querySelector('.bd-ambient');
    this.front = 0;
    this.wanted = null;
    this.shown = null;
    this.style = 'art';
    this.color = null;
    this.timer = 0;
    this.memory = new Map();
    this.canvas = el('canvas');
    this.canvas.width = this.canvas.height = 8;
    this.paint = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  /** Shows a game's art after `delay` ms, so fast scrolling doesn't churn images. */
  show(game, delay = 130) {
    if (!game) return;
    const key = `${game.id}|${game.art_rev}`;
    if (this.wanted === key) return;
    this.wanted = key;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.load(game, key), delay);
  }

  async load(game, key) {
    let found = this.memory.get(key);
    if (!found) {
      found = (await this.fetch(artUrl('hero', game), false)) ?? (await this.fetch(artUrl('cover', game), true));
      if (!found) return this.swap(null, false, key);
      this.memory.set(key, found);
      if (this.memory.size > 40) this.memory.delete(this.memory.keys().next().value);
    }
    this.swap(found.url, found.soft, key, found.color);
  }

  async fetch(url, soft) {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = url;
    try {
      await image.decode();
    } catch {
      return null;
    }
    return { url, soft, color: this.colorOf(image) };
  }

  colorOf(image) {
    try {
      this.paint.drawImage(image, 0, 0, 8, 8);
      const { data } = this.paint.getImageData(0, 0, 8, 8);
      let [r, g, b, weight] = [0, 0, 0, 0];
      for (let i = 0; i < data.length; i += 4) {
        // Colorful pixels speak for the image; greys and near-blacks don't.
        const spread = Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
        const w = 1 + spread * spread;
        r += data[i] * w;
        g += data[i + 1] * w;
        b += data[i + 2] * w;
        weight += w;
      }
      return [r / weight, g / weight, b / weight];
    } catch {
      return null;
    }
  }

  /** "art", "soft" or "color". */
  setStyle(style) {
    if (style === this.style) return;
    this.style = style;
    if (this.shown) this.swap(...this.shown);
  }

  swap(url, soft, key, color) {
    if (this.wanted !== key) return;
    this.shown = [url, soft, key, color];
    const previous = this.layers[this.front];
    const next = this.layers[1 - this.front];
    next.classList.remove('drift', 'on');
    void next.offsetWidth;
    next.classList.toggle('soft', !!soft || this.style === 'soft');
    next.style.backgroundImage = url && this.style !== 'color' ? `url("${url}")` : 'none';
    next.classList.add('on', 'drift');
    previous.classList.remove('on');
    this.front = 1 - this.front;
    if (color) this.tint(color);
  }

  /** Picks the game's color back up, for when "Match the game" is chosen again. */
  retint() {
    if (this.color) this.tint(this.color);
  }

  tint(color) {
    this.color = color;
    const [r, g, b] = color;
    // With no artwork over it, the color has to carry the whole background.
    const scale = (this.style === 'color' ? 62 : 26) / Math.max(r, g, b, 1);
    this.ambient.style.backgroundColor = `rgb(${r * scale + 6},${g * scale + 8},${b * scale + 14})`;
    if ((store.settings?.accent ?? 'auto') === 'auto') {
      const lift = 235 / Math.max(r, g, b, 1);
      const mix = (v) => Math.round(v * lift * 0.72 + 70);
      document.documentElement.style.setProperty('--accent', `${mix(r)}, ${mix(g)}, ${mix(b)}`);
    }
  }
}

export const backdrop = new Backdrop();
