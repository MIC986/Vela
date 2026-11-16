// A virtualized game grid: only tiles near the viewport exist, recycled as it
// scrolls, so a thousand-game library scrolls exactly like a ten-game one.

import { clamp, el, rem, snap, Spring } from './core.js';
import { fillTile, makeTile } from './ui.js';
import { inputMode, step } from './input.js';

export class Grid {
  constructor(root, { tileRem, heightRem, gutterRem = 4, rowGapRem = 3.2, topRem = 1.8, onFocus, onActivate, onMenu, scrollbar, note }) {
    Object.assign(this, { root, tileRem, heightRem, gutterRem, rowGapRem, topRem, onFocus, onActivate, onMenu, scrollbar, note });
    this.track = root.querySelector('.grid-track, .search-track') ?? root.appendChild(el('div', 'grid-track'));
    this.items = [];
    this.index = 0;
    this.active = false;
    // Under a mouse, the selection shows only while the pointer is over a game.
    this.lit = true;
    this.live = new Map();
    this.pool = [];
    this.range = null;
    this.spring = new Spring(0, (v) => this.onScroll(v), { stiffness: 190, damping: 30 });
    new ResizeObserver(() => this.layout()).observe(root);
    root.addEventListener('wheel', (e) => this.onWheel(e), { passive: true });
    root.addEventListener('pointermove', (e) => this.onPointer(e));
    root.addEventListener('pointerleave', () => this.unlight());
    root.addEventListener('click', (e) => {
      const tile = e.target.closest('.tile');
      if (tile) this.onActivate(this.items[+tile.dataset.index]);
    });
    root.addEventListener('contextmenu', (e) => {
      const tile = e.target.closest('.tile');
      if (tile) {
        this.focus(+tile.dataset.index, { scroll: false });
        this.onMenu?.(this.items[+tile.dataset.index]);
      }
    });
  }

  get game() {
    return this.items[this.index];
  }

  layout() {
    const unit = rem();
    const width = this.root.clientWidth;
    const gutter = snap(this.gutterRem * unit);
    // Whole pixels, so every tile in a row is the same size and its art stays sharp.
    this.tileW = snap(this.tileRem * unit);
    this.tileH = snap(this.tileW * (this.heightRem / this.tileRem));
    this.root.style.setProperty('--tile-w', `${this.tileW}px`);
    this.root.style.setProperty('--tile-h', `${this.tileH}px`);
    const minGap = 1.15 * unit;
    this.cols = Math.max(1, Math.floor((width - gutter * 2 + minGap) / (this.tileW + minGap)));
    this.gapX = this.cols > 1 ? (width - gutter * 2 - this.cols * this.tileW) / (this.cols - 1) : 0;
    this.gutter = gutter;
    this.rowH = snap(this.tileH + this.rowGapRem * unit);
    this.top = snap(this.topRem * unit);
    this.viewH = this.root.clientHeight;
    const rows = Math.ceil(this.items.length / this.cols);
    this.contentH = this.top + rows * this.rowH + unit * 2;
    this.maxScroll = Math.max(0, this.contentH - this.viewH);
    this.track.style.height = `${this.contentH}px`;
    for (const [i, tile] of this.live) this.place(tile, i);
    this.range = null;
    this.spring.target = clamp(this.spring.target, 0, this.maxScroll);
    this.render();
    this.drawBar();
  }

  place(tile, i) {
    const col = i % this.cols;
    const row = Math.floor(i / this.cols);
    const x = snap(this.gutter + col * (this.tileW + this.gapX));
    const y = this.top + row * this.rowH;
    // 2D on purpose: tiles share their track's layer, so scrolling moves one thing.
    tile.style.transform = `translate(${x}px,${y}px)`;
  }

  onScroll(value) {
    this.track.style.transform = `translate3d(0,${-value}px,0)`;
    this.render();
    this.drawBar();
  }

  render() {
    if (!this.cols) return;
    const y = this.spring.value;
    const firstRow = Math.max(0, Math.floor((y - this.top) / this.rowH) - 2);
    const lastRow = Math.ceil((y + this.viewH) / this.rowH) + 2;
    const first = firstRow * this.cols;
    const last = Math.min(this.items.length - 1, (lastRow + 1) * this.cols - 1);
    if (this.range && first === this.range[0] && last === this.range[1]) return;
    this.range = [first, last];
    for (const [i, tile] of this.live) {
      if (i < first || i > last) {
        tile.classList.remove('focused');
        tile.style.visibility = 'hidden';
        this.pool.push(tile);
        this.live.delete(i);
      }
    }
    for (let i = first; i <= last; i += 1) {
      if (this.live.has(i)) continue;
      const tile = this.pool.pop() ?? this.track.appendChild(makeTile());
      tile.style.visibility = '';
      tile.dataset.index = i;
      this.live.set(i, tile);
      this.place(tile, i);
      fillTile(tile, this.items[i], { caption: true, note: this.note?.(this.items[i]) });
      tile.classList.toggle('focused', this.shown && i === this.index);
    }
  }

  get shown() {
    return this.active && this.lit;
  }

  unlight() {
    if (!this.lit) return;
    this.lit = false;
    this.live.get(this.index)?.classList.remove('focused');
  }

  drawBar() {
    if (!this.scrollbar) return;
    const show = this.maxScroll > 0;
    this.scrollbar.classList.toggle('on', show);
    if (!show) return;
    const thumb = this.scrollbar.firstElementChild;
    const size = this.scrollbar.clientHeight;
    const h = Math.max(size * (this.viewH / this.contentH), 24);
    thumb.style.height = `${h}px`;
    thumb.style.transform = `translate3d(0,${(this.spring.value / this.maxScroll) * (size - h)}px,0)`;
  }

  /** Replaces the contents, keeping focus on the same game when it's still there. */
  set(items, { keep = true } = {}) {
    // Nobody has chosen a game until they arrive: a grid still at its top stays there.
    const id = keep && (this.active || this.index > 0) ? this.game?.id : null;
    const previous = this.index;
    this.items = items;
    let index = id ? items.findIndex((g) => g.id === id) : 0;
    if (index < 0) index = Math.min(this.index, Math.max(items.length - 1, 0));
    this.index = index;
    this.layout();
    this.refill();
    if (!keep) this.spring.jump(0);
    // Only follow a game that moved: a background update mustn't yank the page around.
    else if (index !== previous) this.scrollTo(index);
  }

  /** Redraws the tiles on screen from the current items. */
  refill() {
    for (const [i, tile] of this.live) {
      fillTile(tile, this.items[i], { caption: true, note: this.note?.(this.items[i]) });
      tile.classList.toggle('focused', this.shown && i === this.index);
    }
  }

  setActive(on) {
    this.active = on;
    if (on && inputMode() !== 'mouse') this.lit = true;
    this.live.get(this.index)?.classList.toggle('focused', this.shown);
    if (on) this.onFocus?.(this.game);
  }

  focus(index, { scroll = true } = {}) {
    const relight = !this.lit;
    this.lit = true;
    if (index === this.index && this.active && !relight) return;
    this.live.get(this.index)?.classList.remove('focused');
    this.index = index;
    this.live.get(index)?.classList.toggle('focused', this.shown);
    if (scroll) this.scrollTo(index);
    else if (performance.now() - (this.wheelAt ?? 0) > 600) this.keepVisible(index);
    this.onFocus?.(this.game);
  }

  /** A selected game grows; if that would push it past an edge, the grid moves just enough. */
  keepVisible(index) {
    const unit = rem();
    const y = this.top + Math.floor(index / this.cols) * this.rowH;
    const top = y - this.tileH * 0.09 - unit * 0.4;
    const bottom = y + this.tileH + unit * 2.6;
    const view = this.spring.target;
    if (top < view) this.spring.to(snap(clamp(top, 0, this.maxScroll)));
    else if (bottom > view + this.viewH) this.spring.to(snap(clamp(bottom - this.viewH, 0, this.maxScroll)));
  }

  scrollTo(index) {
    const row = Math.floor(index / this.cols);
    const y = this.top + row * this.rowH;
    this.spring.to(snap(clamp(y - this.viewH * 0.14, 0, this.maxScroll)));
  }

  move(action) {
    this.lit = true;
    this.live.get(this.index)?.classList.toggle('focused', this.shown);
    const { index, cols, items } = this;
    if (action === 'left' && index % cols > 0) this.focus(step(index, -1, items.length));
    else if (action === 'right' && index % cols < cols - 1) this.focus(step(index, 1, items.length));
    else if (action === 'up') {
      if (index < cols) return false;
      this.focus(step(index, -cols, items.length));
    } else if (action === 'down') {
      const next = Math.min(index + cols, items.length - 1);
      // The last row may be short; drop to its end rather than refusing to move.
      if (Math.floor(next / cols) > Math.floor(index / cols)) this.focus(step(next, 0, items.length));
    } else if (action === 'lt' || action === 'rt') {
      const rows = Math.max(1, Math.floor(this.viewH / this.rowH));
      const delta = rows * cols * (action === 'lt' ? -1 : 1);
      this.focus(clamp(index + delta, 0, items.length - 1));
    }
    return true;
  }

  onWheel(e) {
    this.wheelAt = performance.now();
    this.spring.to(snap(clamp(this.spring.target + e.deltaY * 1.15, 0, this.maxScroll)));
  }

  onPointer(e) {
    // A still pointer gets these too, as the grid scrolls beneath it.
    if (!e.movementX && !e.movementY) return;
    const tile = e.target.closest('.tile');
    if (!tile) return this.unlight();
    if (this.active) this.focus(+tile.dataset.index, { scroll: false });
    else this.onPointerEnter?.(+tile.dataset.index);
  }

  /** The focused tile's element, if it's currently on screen. */
  get element() {
    return this.live.get(this.index);
  }
}
