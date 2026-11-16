import { clamp, el, escapeHtml, fmtAgo, HOME_TILE_REM, rem, snap, Spring, tileSize } from './core.js';
import { inputMode, step } from './input.js';
import { icons } from './icons.js';
import { backdrop, fillTile, loadLogo, makeTile, setHints } from './ui.js';
import { homeGames, store } from './state.js';

/** One notch of a mouse wheel. A touchpad's small movements add up to it. */
const WHEEL_STEP = 100;
/** A pause this long ends a turn of the wheel. */
const WHEEL_GAP = 180;
/** How long the selection rests before its title and details change. */
const INFO_DELAY = 120;

export class Home {
  constructor(app) {
    this.app = app;
    this.root = el('section', 'view', `
      <div class="home-hero"><div class="home-logo"></div></div>
      <div class="home-info">
        <div class="home-meta"></div>
        <div class="home-hints"></div>
        <div class="home-genres"></div>
      </div>
      <div class="row"><div class="row-track"></div></div>
      <div class="home-empty"><span class="spinner"></span><h2>Finding your games</h2><p>Checking your stores and folders. Your library will appear here in a moment.</p></div>`);
    this.root.id = 'home';
    this.logo = this.root.querySelector('.home-logo');
    this.meta = this.root.querySelector('.home-meta');
    this.genres = this.root.querySelector('.home-genres');
    this.empty = this.root.querySelector('.home-empty');
    this.rowEl = this.root.querySelector('.row');
    this.track = this.root.querySelector('.row-track');
    this.tiles = new Map();
    this.games = [];
    this.index = 0;
    this.active = true;
    this.spring = new Spring(0, (v) => { this.track.style.transform = `translate3d(${-v}px,0,0)`; }, { stiffness: 220, damping: 31 });

    setHints(this.root.querySelector('.home-hints'), [
      { action: 'confirm', label: 'Play' },
      { action: 'x', label: 'Details' },
      { action: 'menu', label: 'Options' },
      { action: 'y', label: 'Search' },
    ], (a) => this.onAction(a, {}));

    this.rowEl.addEventListener('pointermove', (e) => {
      // A still pointer gets these too, as the row slides beneath it.
      if ((!e.movementX && !e.movementY) || this.wheelHolds(e)) return;
      const tile = e.target.closest('.tile');
      if (tile && inputMode() === 'mouse') {
        app.focusView();
        this.focus(+tile.dataset.index, { reveal: true });
      }
    });
    this.rowEl.addEventListener('click', (e) => {
      const tile = e.target.closest('.tile');
      if (tile) {
        this.focus(+tile.dataset.index, { reveal: true });
        this.activate();
      }
    });
    this.rowEl.addEventListener('contextmenu', (e) => {
      const tile = e.target.closest('.tile');
      if (tile && this.game) {
        this.focus(+tile.dataset.index, { reveal: true });
        app.openMenu(this.game);
      }
    });
    this.wheelTurn = 0;
    this.wheelAt = 0;
    this.heldAt = null;
    this.root.addEventListener('wheel', (e) => this.onWheel(e), { passive: true });
    new ResizeObserver(() => this.measure()).observe(this.root);
  }

  /**
   * The row moves with the selection, so the game under the pointer stays selected.
   * At either end the row stops and the selection carries on to the last game.
   */
  onWheel(e) {
    const now = performance.now();
    if (now - this.wheelAt > WHEEL_GAP) this.wheelTurn = 0;
    this.wheelAt = now;
    this.wheelTurn += e.deltaY || e.deltaX;
    this.heldAt = [e.clientX, e.clientY];
    const steps = Math.trunc(this.wheelTurn / WHEEL_STEP);
    if (!steps) return;
    this.wheelTurn -= steps * WHEEL_STEP;
    const index = clamp(this.index + steps, 0, this.count - 1);
    this.app.focusView();
    this.spring.to(snap(clamp(this.spring.target + (index - this.index) * this.stepX, 0, this.maxView)));
    this.focus(index);
  }

  /** After the wheel, a nudged mouse keeps its hands off until it really moves away. */
  wheelHolds(e) {
    if (!this.heldAt) return false;
    if (Math.hypot(e.clientX - this.heldAt[0], e.clientY - this.heldAt[1]) < this.stepX / 2) return true;
    this.heldAt = null;
    return false;
  }

  get game() {
    return this.games[this.index];
  }

  /** Library tile included. */
  get count() {
    return this.games.length + (this.games.length ? 1 : 0);
  }

  /** `hold` leaves the row where it is, for updates nobody asked for. */
  measure({ hold = false } = {}) {
    const unit = rem();
    // Whole pixels, so every tile is the same size and its art stays sharp.
    this.tileW = snap(HOME_TILE_REM * tileSize(store.settings.home_tile_size) * unit);
    this.root.style.setProperty('--tile-w', `${this.tileW}px`);
    this.root.style.setProperty('--tile-h', `${snap(this.tileW * 1.5)}px`);
    this.stepX = snap(this.tileW + 1.1 * unit);
    this.anchor = this.stepX;
    this.viewW = this.root.clientWidth - unit * 8;
    this.maxView = Math.max(0, this.count * this.stepX - (this.stepX - this.tileW) - this.viewW);
    for (const [i, tile] of this.ordered()) tile.style.transform = `translate(${i * this.stepX}px,0)`;
    if (!hold) this.reveal(this.index);
  }

  ordered() {
    return [...this.tiles.values()].map((t) => [+t.dataset.index, t]);
  }

  update() {
    const games = homeGames();
    const previous = this.game?.id;
    this.empty.classList.toggle('on', !games.length);
    this.root.querySelector('.home-info').style.visibility = games.length ? '' : 'hidden';
    const next = new Map();
    games.forEach((game, i) => {
      const tile = this.tiles.get(game.id) ?? this.track.appendChild(makeTile());
      this.tiles.delete(game.id);
      fillTile(tile, game);
      tile.dataset.index = i;
      tile.style.setProperty('--i', Math.min(i, 8));
      next.set(game.id, tile);
    });
    for (const tile of this.tiles.values()) tile.remove();
    this.tiles = next;
    this.games = games;
    if (games.length) {
      let more = this.tiles.get('__more') ?? this.moreTile;
      if (!more) {
        more = this.moreTile = el('div', 'tile more', `<div class="t-card"><div class="t-clip">${icons.grid}<span>All games</span></div><div class="t-ring"></div></div>`);
        this.track.append(more);
      }
      more.dataset.index = games.length;
      this.track.append(more);
      this.tiles.set('__more', more);
    }
    const kept = games.findIndex((g) => g.id === previous);
    const before = this.index;
    this.index = kept >= 0 ? kept : clamp(this.index, 0, Math.max(this.count - 1, 0));
    // When games arrive or leave around the selected one, the row moves under it by
    // the same amount at once, so nothing on screen slides.
    const shift = kept >= 0 && this.stepX ? (kept - before) * this.stepX : 0;
    if (shift) this.spring.jump(Math.max(0, this.spring.value + shift));
    this.measure({ hold: !!shift });
    this.paintFocus();
    this.showInfo(true);
  }

  paintFocus() {
    for (const [i, tile] of this.ordered()) tile.classList.toggle('focused', this.active && i === this.index);
  }

  reveal(index) {
    if (!this.stepX) return;
    const max = this.maxView;
    if (inputMode() === 'mouse') {
      // Leave the row still under the pointer unless the tile is cut off.
      const left = index * this.stepX;
      const right = left + this.tileW;
      const view = this.spring.target;
      if (left < view) this.spring.to(clamp(left, 0, max));
      else if (right > view + this.viewW) this.spring.to(snap(clamp(right - this.viewW, 0, max)));
      return;
    }
    this.spring.to(snap(clamp(index * this.stepX - this.anchor, 0, max)));
  }

  focus(index, { reveal = false, silent = false } = {}) {
    if (index === this.index) return;
    if (!silent && !reveal) step(this.index, Math.sign(index - this.index), this.count);
    this.index = index;
    this.paintFocus();
    this.reveal(index);
    // A row flying past needn't redraw the logo for every game on the way.
    clearTimeout(this.infoTimer);
    this.infoTimer = setTimeout(() => this.showInfo(), INFO_DELAY);
  }

  showInfo(force = false) {
    const game = this.game;
    if (!game) {
      this.logo.innerHTML = this.index === this.games.length && this.games.length ? '<div class="home-title swap">All games</div>' : '';
      this.meta.innerHTML = this.meta._html = '';
      this.genres.innerHTML = this.genres._html = '';
      this.shown = null;
      return;
    }
    const key = `${game.id}|${game.art_rev}|${game.year}|${game.developer}|${game.genres.join()}|${game.score}|${game.last_played}`;
    if (!force && this.shown === key) return;
    const id = `${game.id}|${game.art_rev}|${game.title}|${store.settings.home_logos}`;
    const sameGame = this.shownId === id;
    this.shown = key;
    this.shownId = id;
    // Once the row has nearly settled: a full-screen image costs the GPU a frame or two.
    backdrop.show(game, 200);
    if (!sameGame) this.showLogo(game);
    // Rewritten only when it reads differently, so coming back to the window doesn't replay its fade.
    const meta = [
      game.year ? `<span class="year">${game.year}</span>` : '',
      game.developer ? `<span class="dev">${escapeHtml(game.developer)}</span>` : '',
      game.last_played ? `<span class="played">${fmtAgo(game.last_played)}</span>` : '',
    ].join('');
    const genres = [
      ...game.genres.slice(0, 4).map((g) => `<span>${escapeHtml(g)}</span>`),
      game.score ? `<span class="score">${Math.round(game.score / 10)}</span>` : '',
    ].join('');
    if (this.meta._html !== meta) this.meta.innerHTML = this.meta._html = meta;
    if (this.genres._html !== genres) this.genres.innerHTML = this.genres._html = genres;
  }

  showLogo(game) {
    const title = `<div class="home-title swap">${escapeHtml(game.title)}</div>`;
    const token = (this.logoToken = {});
    if (!store.settings.home_logos) {
      this.logo.innerHTML = title;
      return;
    }
    // Keep the old logo until this one decodes, then cut straight to it. If it
    // doesn't exist, the title shows instead.
    loadLogo(game, 'swap').then(
      (image) => { if (this.logoToken === token) this.logo.replaceChildren(image); },
      () => { if (this.logoToken === token) this.logo.innerHTML = title; },
    );
  }

  setActive(on) {
    this.active = on;
    this.paintFocus();
    if (on) this.showInfo(true);
  }

  activate() {
    if (this.index === this.games.length) return this.app.setTab('library');
    const game = this.game;
    if (game) this.app.primary(game);
  }

  onAction(action) {
    const { index, count } = this;
    switch (action) {
      case 'left': if (index > 0) this.focus(index - 1); break;
      case 'right': if (index < count - 1) this.focus(index + 1); break;
      case 'up': this.app.focusTop(); break;
      case 'confirm': this.activate(); break;
      case 'x': if (this.game) this.app.openGame(this.game, this.tiles.get(this.game.id)); break;
      case 'menu': if (this.game) this.app.openMenu(this.game); break;
      case 'y': this.app.openSearch(); break;
      case 'lt': this.focus(0, { silent: true }); break;
      case 'rt': this.focus(Math.max(count - 1, 0), { silent: true }); break;
      default: return false;
    }
    return true;
  }
}
