import { el, escapeHtml, fmtAgo, fmtPlaytime, LIBRARY_TILE_REM, STORE_NAMES, tileSize } from './core.js';
import { Grid } from './grid.js';
import { icons, storeIcon } from './icons.js';
import { inputMode } from './input.js';
import { Shelves } from './shelves.js';
import { play } from './sound.js';
import { backdrop, FocusList, setHints } from './ui.js';
import { loadUi, recentFirst, saveUi, store } from './state.js';

const STATUS = [
  ['all', 'All'],
  ['installed', 'Installed'],
  ['available', 'Not installed'],
  ['favorites', 'Favorites'],
  ['gamepass', 'Game Pass'],
];

const SORTS = [
  ['recent', 'Recently played'],
  ['az', 'Name A–Z'],
  ['za', 'Name Z–A'],
  ['playtime', 'Most played'],
  ['added', 'Recently added'],
  ['release', 'Release year'],
  ['score', 'Top rated'],
  ['size', 'Install size'],
];

const byTitle = (a, b) => a.title.localeCompare(b.title);
const SORTERS = {
  recent: (a, b) => (b.last_played ?? 0) - (a.last_played ?? 0) || b.installed - a.installed || byTitle(a, b),
  az: byTitle,
  za: (a, b) => byTitle(b, a),
  playtime: (a, b) => b.playtime - a.playtime || byTitle(a, b),
  added: (a, b) => (b.added ?? 0) - (a.added ?? 0) || byTitle(a, b),
  release: (a, b) => (b.year ?? 0) - (a.year ?? 0) || byTitle(a, b),
  score: (a, b) => (b.score ?? 0) - (a.score ?? 0) || byTitle(a, b),
  size: (a, b) => (b.size ?? 0) - (a.size ?? 0) || byTitle(a, b),
};

const MODES = [['grid', 'All games'], ['shelves', 'Browse']];

/** Slides a marker under the chosen option. The first time it just appears there. */
function placeMarker(marker, target) {
  if (!target || !target.offsetWidth) return false;
  if (!marker.dataset.placed) {
    marker.style.transition = 'none';
    marker.dataset.placed = '1';
    requestAnimationFrame(() => { marker.style.transition = ''; });
  }
  marker.style.width = `${target.offsetWidth}px`;
  marker.style.transform = `translate3d(${target.offsetLeft}px,0,0)`;
  return true;
}

export class Library {
  constructor(app) {
    this.app = app;
    const saved = loadUi();
    this.filters = { status: 'all', store: 'all', genre: 'all', collection: 'all', sort: 'recent', ...saved.filters };
    this.mode = saved.libraryMode === 'shelves' ? 'shelves' : 'grid';
    this.root = el('section', 'view right', `
      <div class="lib-head"></div>
      <div class="lib-bar"></div>
      <div class="lib-pane lib-grid-pane">
        <div class="grid"><div class="grid-track"></div></div>
        <div class="grid-scroll"><i></i></div>
        <div class="lib-empty">${icons.grid}<b>Nothing matches</b><span>Try a different filter.</span></div>
      </div>
      <div class="lib-pane lib-shelf-pane"><div class="shelves"></div></div>
      <div class="lib-foot"><div class="lib-sel"></div><div class="lib-hints"></div></div>`);
    this.root.id = 'library';
    this.root.dataset.mode = this.mode;
    this.head = this.root.querySelector('.lib-head');
    this.bar = this.root.querySelector('.lib-bar');
    this.emptyEl = this.root.querySelector('.lib-empty');
    this.selEl = this.root.querySelector('.lib-sel');
    this.barFocus = new FocusList();
    this.region = 'grid';
    this.grid = new Grid(this.root.querySelector('.grid'), {
      tileRem: LIBRARY_TILE_REM,
      heightRem: LIBRARY_TILE_REM * 1.5,
      scrollbar: this.root.querySelector('.grid-scroll'),
      onFocus: (game) => {
        if (game && this.active) backdrop.show(game, 260);
        if (this.mode === 'grid') this.showSelection(game);
      },
      onActivate: (game) => { if (game) this.app.openGame(game, this.grid.element); },
      onMenu: (game) => this.app.openMenu(game),
    });
    this.grid.onPointerEnter = (index) => {
      this.setRegion('grid');
      this.grid.focus(index, { scroll: false });
    };
    this.shelves = new Shelves(this, this.root.querySelector('.shelves'));
    for (const strip of [this.head, this.bar]) {
      strip.addEventListener('pointermove', (e) => {
        const node = e.target.closest('[data-key]');
        if (node && inputMode() === 'mouse' && (e.movementX || e.movementY)) {
          this.setRegion('bar');
          this.barFocus.focus(this.barFocus.items.indexOf(node));
        }
      });
      strip.addEventListener('click', (e) => e.target.closest('[data-key]')?._run());
    }
    this.drawHints();
    this.drawBar();
  }

  /** The grid or shelves, whichever is showing. */
  get body() {
    return this.mode === 'shelves' ? this.shelves : this.grid;
  }

  get game() {
    return this.body.game;
  }

  drawHints() {
    setHints(this.root.querySelector('.lib-hints'), [
      { action: 'confirm', label: 'Open' },
      { action: 'menu', label: 'Options' },
      { action: 'x', label: this.mode === 'grid' ? 'Browse' : 'All games' },
      ...(this.mode === 'grid' ? [{ action: 'view', label: 'Sort' }] : []),
      { action: 'y', label: 'Search' },
    ], (a) => this.onAction(a));
  }

  /** Picks up the tile size and caption settings. The caller lays the grid out. */
  applyLook() {
    const { library_tile_size: size, library_titles: titles } = store.settings;
    this.grid.tileRem = LIBRARY_TILE_REM * tileSize(size);
    this.grid.heightRem = this.grid.tileRem * 1.5;
    // A selected tile grows upward, and needs room to clear the top of the grid.
    this.grid.topRem = 1.6 * tileSize(size);
    this.grid.root.classList.toggle('titled', titles);
  }

  statuses() {
    return STATUS.filter(([value]) => value !== 'gamepass' || store.games.some((g) => g.gamepass));
  }

  /**
   * Builds the header and filter row, but only when what's in them changes. A new
   * filter or count updates them in place, so nothing flickers or replays.
   */
  drawBar() {
    const shape = [this.mode, this.statuses().map(([v]) => v).join(), store.collections.length > 0].join('|');
    if (shape === this.shape) return this.paintBar();
    this.shape = shape;
    const remembered = this.barFocus.current?.dataset.key;
    const items = [];
    const button = (key, className, html, run, row) => {
      const node = el('button', className, html);
      Object.assign(node.dataset, { key, row });
      node._run = run;
      items.push(node);
      return node;
    };

    this.head.innerHTML = '';
    const modes = el('div', 'lib-modes');
    modes.append(el('i', 'lib-mark'));
    for (const [value, label] of MODES) modes.append(button(`mode:${value}`, 'lib-mode', label, () => this.setMode(value), 'head'));
    this.head.append(modes, el('div', 'lib-gap'), (this.countEl = el('span', 'lib-count')));

    this.bar.innerHTML = '';
    const seg = el('div', 'seg');
    seg.append(el('i', 'seg-pill'));
    for (const [value, label] of this.statuses()) seg.append(button(`status:${value}`, 'seg-opt', label, () => this.setFilter('status', value), 'bar'));
    const picks = el('div', 'lib-picks');
    const pick = (key, icon, run) => picks.append(button(key, 'pick', `${icon}<span></span>${icons.down}`, run, 'bar'));
    pick('store', icons.store, () => this.pickStore());
    pick('genre', icons.tag, () => this.pickGenre());
    if (store.collections.length) pick('collection', icons.stack, () => this.pickCollection());
    pick('sort', icons.sort, () => this.pickSort());
    this.bar.append(seg, el('div', 'lib-gap'), picks);

    const index = items.findIndex((c) => c.dataset.key === remembered);
    this.barFocus.active = this.region === 'bar' && this.active;
    this.barFocus.set(items, Math.max(index, 0));
    this.paintBar();
  }

  /** Marks what's chosen and slides the markers there. */
  paintBar() {
    const f = this.filters;
    for (const node of this.head.querySelectorAll('.lib-mode')) node.classList.toggle('on', node.dataset.key === `mode:${this.mode}`);
    for (const node of this.bar.querySelectorAll('.seg-opt')) node.classList.toggle('on', node.dataset.key === `status:${f.status}`);
    const labels = {
      store: [f.store === 'all' ? 'All stores' : STORE_NAMES[f.store] ?? f.store, f.store !== 'all'],
      genre: [f.genre === 'all' ? 'All genres' : f.genre, f.genre !== 'all'],
      collection: [f.collection === 'all' ? 'Collections' : f.collection, f.collection !== 'all'],
      sort: [SORTS.find(([v]) => v === f.sort)?.[1], false],
    };
    for (const node of this.bar.querySelectorAll('.pick')) {
      const [label, on] = labels[node.dataset.key];
      node.querySelector('span').textContent = label;
      node.classList.toggle('on', on);
    }
    const place = () => placeMarker(this.head.querySelector('.lib-mark'), this.head.querySelector('.lib-mode.on'))
      & placeMarker(this.bar.querySelector('.seg-pill'), this.bar.querySelector('.seg-opt.on'));
    // Before the Library is first on screen there's nothing to measure yet.
    if (!place()) requestAnimationFrame(place);
    this.paintCount();
  }

  paintCount() {
    if (!this.countEl) return;
    const n = this.mode === 'grid' ? this.grid.items.length : store.games.length;
    this.countEl.textContent = this.mode === 'grid' ? `${n.toLocaleString()} ${n === 1 ? 'game' : 'games'}` : `${n.toLocaleString()} games, sorted into shelves`;
  }

  setMode(mode) {
    if (this.mode === mode) return;
    play('tab');
    this.mode = mode;
    this.root.dataset.mode = mode;
    saveUi({ libraryMode: mode });
    this.drawBar();
    this.drawHints();
    this.apply();
    if (this.region === 'bar' && this.barFocus.current?.dataset.row === 'bar' && mode === 'shelves') {
      this.barFocus.focus(this.barFocus.items.findIndex((n) => n.dataset.key === 'mode:shelves'));
    }
    this.setRegion(this.region);
    this.showSelection(this.game);
  }

  toggleMode() {
    this.setMode(this.mode === 'grid' ? 'shelves' : 'grid');
  }

  /** From a shelf's "See all": the grid, filtered to that shelf. */
  showAll(key, value) {
    this.filters = { ...this.filters, status: 'all', store: 'all', genre: 'all', collection: 'all', [key]: value };
    saveUi({ filters: this.filters });
    this.setMode('grid');
    this.drawBar();
    this.apply({ keep: false });
  }

  setFilter(key, value) {
    if (this.filters[key] === value) return;
    this.filters[key] = value;
    saveUi({ filters: this.filters });
    play('toggle');
    this.paintBar();
    const grid = this.root.querySelector('.grid');
    grid.classList.add('fading');
    clearTimeout(this.fade);
    this.fade = setTimeout(() => {
      this.apply({ keep: false });
      grid.classList.remove('fading');
    }, 170);
  }

  pickStore() {
    const sources = [...new Set(store.games.flatMap((g) => g.variants.map((v) => v.source)))].sort();
    this.app.openPicker('Store', [
      { value: 'all', label: 'All stores', icon: icons.store },
      ...sources.map((s) => ({ value: s, label: STORE_NAMES[s] ?? s, icon: storeIcon(s) })),
    ], this.filters.store, (v) => this.setFilter('store', v));
  }

  pickGenre() {
    const counts = new Map();
    for (const game of store.games) for (const g of game.genres) counts.set(g, (counts.get(g) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([g]) => g).sort();
    this.app.openPicker('Genre', [{ value: 'all', label: 'All genres' }, ...top.map((g) => ({ value: g, label: g }))], this.filters.genre, (v) => this.setFilter('genre', v));
  }

  pickCollection() {
    this.app.openPicker('Collection', [
      { value: 'all', label: 'Every game', icon: icons.grid },
      ...store.collections.map((c) => ({ value: c, label: c, icon: icons.stack })),
    ], this.filters.collection, (v) => this.setFilter('collection', v));
  }

  pickSort() {
    this.app.openPicker('Sort by', SORTS.map(([value, label]) => ({ value, label })), this.filters.sort, (v) => this.setFilter('sort', v));
  }

  filtered() {
    const { status, store: source, genre, collection, sort } = this.filters;
    let list = store.games;
    if (status === 'installed') list = list.filter((g) => g.installed);
    else if (status === 'available') list = list.filter((g) => !g.installed);
    else if (status === 'favorites') list = list.filter((g) => g.favorite);
    else if (status === 'gamepass') list = list.filter((g) => g.gamepass);
    if (source !== 'all') list = list.filter((g) => g.variants.some((v) => v.source === source));
    if (genre !== 'all') list = list.filter((g) => g.genres.includes(genre));
    if (collection !== 'all' && store.collections.includes(collection)) list = list.filter((g) => g.collections.includes(collection));
    return [...list].sort(SORTERS[sort] ?? recentFirst);
  }

  apply({ keep = true } = {}) {
    if (this.mode === 'shelves') {
      this.shelves.update(store.games, store.collections);
      this.emptyEl.classList.remove('on');
      this.paintCount();
      return;
    }
    const items = this.filtered();
    this.grid.set(items, { keep });
    this.emptyEl.classList.toggle('on', !items.length);
    this.paintCount();
    if (!items.length && this.region === 'grid' && this.active) this.setRegion('bar');
  }

  update() {
    this.drawBar();
    this.apply();
  }

  /** The selected game's name and a line about it, along the bottom. */
  showSelection(game) {
    if (!game) {
      if (this.shownSel) this.selEl.innerHTML = '';
      this.shownSel = null;
      return;
    }
    const key = `${game.id}|${game.title}|${game.playtime}|${game.last_played}|${game.installed}`;
    if (this.shownSel === key) return;
    this.shownSel = key;
    const parts = [
      `<span class="store">${storeIcon(game.source)}${escapeHtml(STORE_NAMES[game.source] ?? game.source)}</span>`,
      game.installed ? '' : '<span>Not installed</span>',
      game.playtime ? `<span>${fmtPlaytime(game.playtime)}</span>` : '',
      game.last_played ? `<span>${fmtAgo(game.last_played)}</span>` : '',
    ].filter(Boolean);
    this.selEl.innerHTML = `<b>${escapeHtml(game.title)}</b><div>${parts.join('')}</div>`;
  }

  setRegion(region) {
    this.region = region;
    const on = this.active;
    this.barFocus.setActive(on && region === 'bar');
    const grid = this.mode === 'grid';
    this.grid.setActive(on && region === 'grid' && grid);
    this.shelves.setActive(on && region === 'grid' && !grid);
  }

  setActive(on) {
    this.active = on;
    this.setRegion(this.region);
    if (on && this.game) backdrop.show(this.game, 60);
    if (on) this.paintBar();
  }

  onAction(action) {
    if (this.region === 'bar') return this.barAction(action);
    if (action === 'x') return this.toggleMode(), true;
    if (action === 'y') return this.app.openSearch(), true;
    if (action === 'menu') {
      if (this.game) this.app.openMenu(this.game);
      return true;
    }
    if (this.mode === 'shelves') {
      if (action === 'confirm') return this.shelves.activate(), true;
      if (!this.shelves.move(action) && action === 'up') this.toBar('head');
      return true;
    }
    switch (action) {
      case 'up':
        if (!this.grid.move('up')) this.toBar('bar');
        break;
      case 'down': case 'left': case 'right': case 'lt': case 'rt':
        this.grid.move(action);
        break;
      case 'confirm': if (this.grid.game) this.app.openGame(this.grid.game, this.grid.element); break;
      case 'view': this.pickSort(); break;
      default: return false;
    }
    return true;
  }

  /** Moves up into the header, onto the nearest item of the given row. */
  toBar(row) {
    play('move');
    const current = this.barFocus.current;
    if (current?.dataset.row !== row) this.barFocus.index = this.nearestIn(row, current);
    this.setRegion('bar');
  }

  nearestIn(row, from) {
    const x = from ? from.getBoundingClientRect().left + from.offsetWidth / 2 : 0;
    let best = -1;
    let distance = Infinity;
    this.barFocus.items.forEach((node, i) => {
      if (node.dataset.row !== row) return;
      const box = node.getBoundingClientRect();
      const d = Math.abs(box.left + box.width / 2 - x);
      if (d < distance) [best, distance] = [i, d];
    });
    return best;
  }

  barAction(action) {
    const list = this.barFocus;
    const row = list.current?.dataset.row;
    const step = (delta) => {
      const next = list.index + delta;
      if (list.items[next]?.dataset.row === row) {
        play('move');
        list.focus(next);
      }
    };
    switch (action) {
      case 'left': step(-1); break;
      case 'right': step(1); break;
      case 'up':
        if (row === 'bar') {
          play('move');
          list.focus(this.nearestIn('head', list.current));
        } else this.app.focusTop();
        break;
      case 'down':
        if (row === 'head' && this.mode === 'grid') {
          play('move');
          list.focus(this.nearestIn('bar', list.current));
        } else if (this.mode === 'shelves' ? this.shelves.shelves.length : this.grid.items.length) {
          play('move');
          this.setRegion('grid');
        }
        break;
      case 'confirm': list.current?._run(); break;
      case 'x': this.toggleMode(); break;
      case 'view': if (this.mode === 'grid') this.pickSort(); break;
      case 'y': this.app.openSearch(); break;
      default: return false;
    }
    return true;
  }
}
