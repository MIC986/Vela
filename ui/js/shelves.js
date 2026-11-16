// The Library's browse view: shelves of games, some staged around a series.

import { artUrl, clamp, el, escapeHtml, fmtAgo, fmtPlaytime, rem, snap, Spring } from './core.js';
import { icons } from './icons.js';
import { inputMode } from './input.js';
import { planShelves } from './shelf-plan.js';
import { play } from './sound.js';
import { backdrop, fillTile, loadLogo, makeTile } from './ui.js';

const TILE_REM = 9.6;
const GAP_REM = 1.1;
/** A wide card is this many tiles across. */
const WIDE = 2.6;

const signatureOf = (plan) => `${plan.id}:${plan.games.map((g) => g.id).join(',')}`;

class Shelf {
  constructor(owner, plan) {
    this.owner = owner;
    this.plan = plan;
    this.signature = signatureOf(plan);
    this.index = 0;
    this.items = [];
    this.filled = false;
    this.el = el('section', `shelf kind-${plan.kind}`);
    this.el.dataset.id = plan.id;
    this.row = el('div', 'shelf-row', '<div class="shelf-track"></div>');
    this.track = this.row.firstElementChild;
    const arrow = (dir) => {
      const button = el('button', `shelf-arrow ${dir}`, dir === 'prev' ? icons.back : icons.chevron);
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        this.page(dir === 'prev' ? -1 : 1);
      });
      return button;
    };
    this.row.append(arrow('prev'), arrow('next'));
    if (plan.kind === 'theme') {
      const hours = plan.played >= 60 ? `<span>${icons.clock}${fmtPlaytime(plan.played)} played</span>` : '';
      const lead = plan.lead.playtime ? `<p>Most played: <b>${escapeHtml(plan.lead.title)}</b></p>` : '';
      this.el.innerHTML = `<div class="shelf-stage">
        <div class="stage-glow"></div><div class="stage-art"></div><div class="stage-shade"></div>
        <div class="stage-info"><small>${icons.sparkle}Series</small><h3>${escapeHtml(plan.title)}</h3>
          <div class="stage-meta"><span>${icons.grid}${plan.total} games</span>${hours}</div>${lead}</div>
      </div>`;
      this.el.firstElementChild.append(this.row);
    } else {
      const count = plan.total > 1 ? `<em>${plan.total} games</em>` : '';
      this.el.innerHTML = `<header class="shelf-head"><h3>${escapeHtml(plan.title)}</h3>${plan.subtitle ? `<span>${escapeHtml(plan.subtitle)}</span>` : ''}${count}</header>`;
      this.el.append(this.row);
    }
    this.spring = new Spring(0, (v) => {
      this.track.style.transform = `translate3d(${-v}px,0,0)`;
      this.paintArrows();
    }, { stiffness: 220, damping: 31 });
  }

  get game() {
    return this.items[this.index]?.game ?? null;
  }

  /** Builds the cards once the shelf comes near the screen. */
  fill() {
    if (this.filled) return;
    this.filled = true;
    for (const [i, game] of this.plan.games.entries()) {
      const wide = this.plan.kind === 'hero' && i === 0;
      const node = wide ? this.wideCard(game) : makeTile();
      if (!wide) fillTile(node, game, { caption: true });
      node.dataset.index = i;
      this.track.append(node);
      this.items.push({ game, node, wide });
    }
    if (this.plan.filter && this.plan.total > this.plan.games.length) {
      const node = el('div', 'tile more', `<div class="t-card"><div class="t-clip">${icons.grid}<span>See all ${this.plan.total}</span></div><div class="t-ring"></div></div>`);
      node.dataset.index = this.items.length;
      this.track.append(node);
      this.items.push({ game: null, node, more: true });
    }
    if (this.plan.kind === 'theme') this.stage();
    this.layout();
  }

  /** The series' best art behind it, and its colors on everything in it. */
  async stage() {
    const art = this.el.querySelector('.stage-art');
    const glow = this.el.querySelector('.stage-glow');
    // The series' main game, or the next best one that has a background to show.
    let found = null;
    let url = null;
    for (const face of this.plan.faces) {
      url = artUrl('hero', face);
      found = await backdrop.fetch(url, false);
      if (found) break;
    }
    {
      if (!found) return;
      art.style.backgroundImage = glow.style.backgroundImage = `url("${url}")`;
      art.classList.add('on');
      glow.classList.add('on');
      const [r, g, b] = found.color ?? [120, 140, 200];
      const lift = 235 / Math.max(r, g, b, 1);
      const mix = (v) => Math.round(v * lift * 0.72 + 70);
      const deep = 34 / Math.max(r, g, b, 1);
      this.el.style.setProperty('--accent', `${mix(r)}, ${mix(g)}, ${mix(b)}`);
      this.el.style.setProperty('--deep', `${Math.round(r * deep + 5)}, ${Math.round(g * deep + 6)}, ${Math.round(b * deep + 10)}`);
    }
  }

  wideCard(game) {
    const node = el('div', 'tile wide', `<div class="t-card"><div class="t-clip">
      <div class="w-art"></div><div class="w-shade"></div>
      <div class="w-text"><div class="w-logo"><b>${escapeHtml(game.title)}</b></div><span>${game.last_played ? fmtAgo(game.last_played) : ''}${game.playtime ? ` · ${fmtPlaytime(game.playtime)}` : ''}</span></div>
      </div><div class="t-ring"></div></div><div class="t-caption">${escapeHtml(game.title)}</div>`);
    const art = node.querySelector('.w-art');
    const image = new Image();
    image.src = artUrl('hero', game);
    image.decode().then(() => {
      art.style.backgroundImage = `url("${image.src}")`;
      art.classList.add('on');
    }, () => {
      art.style.backgroundImage = `url("${artUrl('cover', game)}")`;
      art.classList.add('on', 'soft');
    });
    loadLogo(game).then((logo) => node.querySelector('.w-logo').replaceChildren(logo), () => {});
    node._game = game;
    return node;
  }

  refill(games) {
    const byId = new Map(games.map((g) => [g.id, g]));
    for (const item of this.items) {
      const fresh = item.game && byId.get(item.game.id);
      if (fresh && !item.wide) fillTile(item.node, fresh, { caption: true });
      if (fresh) item.game = fresh;
    }
  }

  layout() {
    const unit = rem();
    const tileW = snap(TILE_REM * unit);
    const gap = snap(GAP_REM * unit);
    let x = 0;
    for (const item of this.items) {
      item.x = x;
      item.w = item.wide ? snap(tileW * WIDE) : tileW;
      item.node.style.transform = `translate(${x}px,0)`;
      x += item.w + gap;
    }
    this.width = Math.max(0, x - gap);
    this.gap = gap;
    // The track's own inset, so a staged row and a plain one both line up with their edges.
    const inset = this.track.offsetLeft;
    this.viewW = this.row.clientWidth - inset * 2;
    this.max = Math.max(0, this.width - this.viewW);
    this.spring.jump(clamp(this.spring.target, 0, this.max));
    this.paintArrows();
  }

  paintArrows() {
    this.row.classList.toggle('can-prev', this.spring.target > 1);
    this.row.classList.toggle('can-next', this.spring.target < this.max - 1);
  }

  reveal() {
    const item = this.items[this.index];
    if (!item) return;
    if (inputMode() === 'mouse') {
      const view = this.spring.target;
      if (item.x < view) this.spring.to(snap(item.x));
      else if (item.x + item.w > view + this.viewW) this.spring.to(snap(clamp(item.x + item.w - this.viewW, 0, this.max)));
      return;
    }
    // One card stays visible to the left, so there's always a sense of where you came from.
    const anchor = this.index > 0 ? this.items[this.index - 1].w + this.gap : 0;
    this.spring.to(snap(clamp(item.x - anchor, 0, this.max)));
  }

  page(direction) {
    play('move');
    this.spring.to(snap(clamp(this.spring.target + direction * this.viewW * 0.8, 0, this.max)));
  }

  paint(lit) {
    this.el.classList.toggle('lit', lit);
    this.items.forEach((item, i) => item.node.classList.toggle('focused', lit && i === this.index));
  }

  /** The card nearest a horizontal position on screen, for moving between shelves. */
  nearest(screenX) {
    let best = 0;
    let bestDistance = Infinity;
    const offset = this.row.getBoundingClientRect().left + this.track.offsetLeft;
    for (const [i, item] of this.items.entries()) {
      const d = Math.abs(offset + item.x - this.spring.target + item.w / 2 - screenX);
      if (d < bestDistance) [best, bestDistance] = [i, d];
    }
    return best;
  }

  /** Where the selected card's middle is on screen. */
  focusX() {
    const item = this.items[this.index];
    if (!item) return 0;
    return this.row.getBoundingClientRect().left + this.track.offsetLeft + item.x - this.spring.target + item.w / 2;
  }
}

export class Shelves {
  constructor(library, root) {
    this.library = library;
    this.root = root;
    this.track = root.appendChild(el('div', 'shelves-track'));
    this.shelves = [];
    this.current = 0;
    this.active = false;
    // Under a mouse, the selection shows only while the pointer is over a game.
    this.lit = true;
    this.spring = new Spring(0, (v) => {
      this.track.style.transform = `translate3d(0,${-v}px,0)`;
      this.fillNear();
    }, { stiffness: 190, damping: 30 });
    root.addEventListener('wheel', (e) => this.onWheel(e), { passive: true });
    root.addEventListener('pointermove', (e) => {
      if (!e.movementX && !e.movementY) return;
      const hit = this.hit(e.target);
      if (hit) this.focusAt(...hit, { scroll: false });
      else this.unlight();
    });
    root.addEventListener('pointerleave', () => this.unlight());
    root.addEventListener('click', (e) => {
      const hit = this.hit(e.target);
      if (hit) {
        this.focusAt(...hit, { scroll: false });
        this.activate();
      }
    });
    root.addEventListener('contextmenu', (e) => {
      const hit = this.hit(e.target);
      if (hit) {
        this.focusAt(...hit, { scroll: false });
        if (this.game) this.library.app.openMenu(this.game);
      }
    });
    new ResizeObserver(() => this.layout()).observe(root);
  }

  get shelf() {
    return this.shelves[this.current];
  }

  get game() {
    return this.shelf?.game ?? null;
  }

  hit(target) {
    const node = target.closest('.tile');
    const section = target.closest('.shelf');
    if (!node || !section) return null;
    const s = this.shelves.findIndex((x) => x.el === section);
    return s >= 0 ? [s, +node.dataset.index] : null;
  }

  /**
   * Rebuilds only the shelves that changed. The rest keep their cards and scroll,
   * so a background update never makes the page flash or jump.
   */
  update(games, collections) {
    const plans = planShelves(games, collections);
    const old = new Map(this.shelves.map((s) => [s.signature, s]));
    const keepShelf = this.shelf?.plan.id;
    const keepGame = this.game?.id;
    const first = !this.shelves.length;
    const next = plans.map((plan) => {
      const reused = old.get(signatureOf(plan));
      if (reused) {
        old.delete(reused.signature);
        reused.refill(games);
        return reused;
      }
      const shelf = new Shelf(this, plan);
      if (!first) shelf.el.classList.add('quiet');
      return shelf;
    });
    const unchanged = next.length === this.shelves.length && next.every((s, i) => s === this.shelves[i]);
    if (unchanged) return;
    for (const gone of old.values()) gone.el.remove();
    next.forEach((shelf) => this.track.append(shelf.el));
    this.shelves = next;
    const s = this.shelves.findIndex((x) => x.plan.id === keepShelf);
    this.current = clamp(s >= 0 ? s : this.current, 0, Math.max(this.shelves.length - 1, 0));
    this.layout();
    if (this.shelf && keepGame) {
      const i = this.shelf.items.findIndex((item) => item.game?.id === keepGame);
      if (i >= 0) this.shelf.index = i;
    }
    this.paint();
  }

  layout() {
    this.viewH = this.root.clientHeight;
    for (const shelf of this.shelves) shelf.top = shelf.el.offsetTop;
    this.contentH = this.track.scrollHeight;
    this.maxScroll = Math.max(0, this.contentH - this.viewH + rem() * 2);
    this.fillNear();
    for (const shelf of this.shelves) if (shelf.filled) shelf.layout();
    this.spring.jump(clamp(this.spring.target, 0, this.maxScroll));
  }

  /** Cards are only made for shelves on or near the screen. */
  fillNear() {
    const top = this.spring.value - this.viewH;
    const bottom = this.spring.value + this.viewH * 2;
    for (const shelf of this.shelves) {
      if (!shelf.filled && shelf.top < bottom && shelf.top + shelf.el.offsetHeight > top) {
        shelf.fill();
        shelf.paint(this.shown && shelf === this.shelf);
      }
    }
  }

  get shown() {
    return this.active && this.lit;
  }

  paint() {
    for (const shelf of this.shelves) shelf.paint(this.shown && shelf === this.shelf);
  }

  unlight() {
    if (!this.lit) return;
    this.lit = false;
    this.paint();
  }

  setActive(on) {
    this.active = on;
    if (on && inputMode() !== 'mouse') this.lit = true;
    this.paint();
    if (on && this.game) backdrop.show(this.game, 120);
  }

  /** Whether the wheel moved the page a moment ago; the pointer mustn't fight it. */
  get wheeling() {
    return performance.now() - (this.wheelAt ?? 0) < 600;
  }

  focusAt(s, i, { scroll = true } = {}) {
    const relight = !this.lit;
    this.lit = true;
    if (s === this.current && i === this.shelf?.index && !relight) return;
    const shelf = this.shelves[s];
    if (!shelf) return;
    this.current = s;
    shelf.fill();
    shelf.index = clamp(i, 0, shelf.items.length - 1);
    this.paint();
    // Under a mouse the page only moves when asked: a hover never scrolls it.
    if (scroll) {
      shelf.reveal();
      this.scrollToShelf();
    } else if (!this.wheeling) shelf.reveal();
    if (this.game) backdrop.show(this.game, 200);
    this.library.showSelection(this.game);
  }

  scrollToShelf() {
    const shelf = this.shelf;
    if (!shelf) return;
    // The first shelf sits at the top; the rest rise to just below the bar.
    const target = this.current === 0 ? 0 : shelf.top - rem() * 1.2;
    this.spring.to(snap(clamp(target, 0, this.maxScroll)));
  }

  onWheel(e) {
    this.wheelAt = performance.now();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      const section = e.target.closest('.shelf');
      const shelf = this.shelves.find((x) => x.el === section);
      if (shelf) shelf.spring.to(snap(clamp(shelf.spring.target + (e.deltaX || e.deltaY), 0, shelf.max)));
      return;
    }
    this.spring.to(snap(clamp(this.spring.target + e.deltaY * 1.15, 0, this.maxScroll)));
  }

  activate() {
    const item = this.shelf?.items[this.shelf.index];
    if (!item) return;
    if (item.more) {
      const [key, value] = this.shelf.plan.filter;
      this.library.showAll(key, value);
    } else this.library.app.openGame(item.game, item.node);
  }

  move(action) {
    const shelf = this.shelf;
    if (!shelf) return false;
    if (!this.lit) {
      // The first press only brings the selection back where it was.
      this.lit = true;
      this.paint();
      return true;
    }
    if (action === 'left' || action === 'right') {
      const next = shelf.index + (action === 'left' ? -1 : 1);
      if (next < 0 || next >= shelf.items.length) return true;
      play('move');
      this.focusAt(this.current, next);
      return true;
    }
    const delta = { up: -1, down: 1, lt: -3, rt: 3 }[action];
    if (!delta) return false;
    const target = clamp(this.current + delta, 0, this.shelves.length - 1);
    if (target === this.current) return action !== 'up';
    play('move');
    const x = shelf.focusX();
    const next = this.shelves[target];
    next.fill();
    this.focusAt(target, next.nearest(x));
    return true;
  }
}
