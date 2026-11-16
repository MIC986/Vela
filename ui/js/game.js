// The game page, opened from the Library. Its poster flies out of the tile you
// came from, then the page settles around it.

import { artUrl, clamp, el, escapeHtml, fmtAgo, fmtBytes, fmtPlaytime, invoke, rem, Spring, STORE_NAMES } from './core.js';
import { icons, storeIcon } from './icons.js';
import { play } from './sound.js';
import { closeWith, layers, loadLogo, posterStyle, setHints } from './ui.js';
import { inputMode } from './input.js';
import { store } from './state.js';

export class GamePage {
  constructor(app, game, origin) {
    this.app = app;
    this.game = game;
    this.origin = origin;
    this.full = true;
    this.rows = [];
    this.row = 0;
    this.col = 0;
    this.el = el('section', 'gp', `
      <div class="gp-hero"><div class="art"></div><div class="gp-shade"></div></div>
      <div class="gp-scroll">
        <div class="gp-top">
          <div class="gp-poster"><img class="t-cover" alt=""></div>
          <div class="gp-head"><div class="gp-brand"></div><div class="gp-sub"></div><div class="gp-actions"></div><div class="gp-progress-slot"></div></div>
          <div class="gp-stats"></div>
        </div>
        <div class="gp-body"></div>
      </div>
      <div class="gp-more">${icons.down}More</div>
      <div class="gp-hints"></div>`);
    this.heroEl = this.el.querySelector('.gp-hero');
    this.scrollEl = this.el.querySelector('.gp-scroll');
    this.body = this.el.querySelector('.gp-body');
    this.moreEl = this.el.querySelector('.gp-more');
    this.spring = new Spring(0, (v) => this.onScroll(v), { stiffness: 170, damping: 29 });
    this.shots = new Spring(0, (v) => { this.shotTrack.style.transform = `translate3d(${-v}px,0,0)`; }, { stiffness: 210, damping: 31 });
    this.el.addEventListener('wheel', (e) => this.onWheel(e), { passive: true });

    this.fillArt();
    this.drawHead();
    setHints(this.el.querySelector('.gp-hints'), [
      { action: 'confirm', label: 'Select' },
      { action: 'menu', label: 'Options' },
      { action: 'back', label: 'Back', mouse: true },
    ], (a) => this.onAction(a));
    layers.push(this);
    this.flyFrom();
    this.loadDetail();
  }

  fillArt() {
    const { game } = this;
    // The blurred cover is on screen at once; the sharp art fades in over it.
    const art = this.el.querySelector('.gp-hero .art');
    art.classList.add('soft');
    art.style.backgroundImage = `url("${artUrl('cover', game)}")`;
    const hero = new Image();
    hero.src = artUrl('hero', game);
    hero.decode().then(() => {
      if (this.gone) return;
      const sharp = el('div', 'art');
      sharp.style.backgroundImage = `url("${hero.src}")`;
      // Once it's covered, the blur has no reason to cost anything.
      sharp.addEventListener('animationend', () => art.remove(), { once: true });
      art.after(sharp);
    }, () => {});
    const cover = this.el.querySelector('.gp-poster img');
    cover.src = artUrl('cover', game);
    cover.onerror = () => {
      const box = this.el.querySelector('.gp-poster');
      box.innerHTML = `<div class="t-poster on" style="${posterStyle(game.title)}"><span>${escapeHtml(game.title)}</span></div>`;
    };
    const brand = this.el.querySelector('.gp-brand');
    brand.innerHTML = `<h1 class="gp-title">${escapeHtml(game.title)}</h1>`;
    loadLogo(game, 'gp-logo').then((logo) => brand.replaceChildren(logo), () => {});
  }

  drawHead() {
    const { game } = this;
    const sub = this.el.querySelector('.gp-sub');
    const parts = [];
    if (game.year) parts.push(`<span>${game.year}</span>`);
    if (game.developer) parts.push(`<span>${escapeHtml(game.developer)}</span>`);
    parts.push(`<span class="store">${storeIcon(game.source)}${escapeHtml(STORE_NAMES[game.source] ?? game.source)}</span>`);
    if (game.gamepass) parts.push('<span>Game Pass</span>');
    sub.innerHTML = parts.join('');

    const actions = this.el.querySelector('.gp-actions');
    actions.innerHTML = '';
    const buttons = [];
    const add = (node, run) => {
      node._run = run;
      actions.append(node);
      buttons.push(node);
      return node;
    };
    const primary = game.installed
      ? add(el('button', 'btn primary', `${icons.play}Play`), () => this.app.launch(game))
      : add(el('button', 'btn primary', `${icons.download}${game.progress != null ? 'Installing' : 'Install'}`), () => this.app.install(game));
    primary.dataset.primary = '1';
    const shown = new Set([game.source]);
    for (const variant of game.variants.slice(1).filter((v) => v.installed)) {
      if (shown.has(variant.source)) continue;
      shown.add(variant.source);
      add(el('button', 'btn', `${storeIcon(variant.source)}${escapeHtml(STORE_NAMES[variant.source] ?? variant.source)}`), () => this.app.launch({ ...game, id: variant.id }));
    }
    const fav = add(el('button', `btn round${game.favorite ? ' on' : ''}`, game.favorite ? icons.heartFill : icons.heart), () => this.toggleFavorite(fav));
    add(el('button', 'btn round', icons.more), () => this.app.openMenu(game, { fromPage: this }));

    const slot = this.el.querySelector('.gp-progress-slot');
    slot.innerHTML = game.progress != null ? `<div class="gp-progress"><i style="transform:scaleX(${game.progress})"></i></div>` : '';

    const stats = [
      ['Time played', fmtPlaytime(game.playtime)],
      ['Last played', fmtAgo(game.last_played)],
    ];
    if (game.size) stats.push(['Size', fmtBytes(game.size)]);
    if (game.score) stats.push(['Rating', `${game.score}%`]);
    this.el.querySelector('.gp-stats').innerHTML = stats.map(([k, v]) => `<div class="stat"><small>${k}</small><b>${escapeHtml(v)}</b></div>`).join('');

    this.rows[0] = buttons;
    this.bindRow(buttons, 0);
    this.paint();
  }

  bindRow(items, row) {
    items.forEach((node, col) => {
      node.onpointermove = () => {
        if (inputMode() === 'mouse') this.moveTo(row, col);
      };
      node.onclick = () => {
        this.moveTo(row, col);
        this.run();
      };
    });
  }

  async loadDetail() {
    const detail = await invoke('get_game', { id: this.game.id });
    if (!detail || this.gone) return;
    this.detail = detail;
    const { game } = this;
    const sections = [];
    if (detail.description) sections.push(`<div class="gp-section"><h3>About</h3><p class="gp-about">${escapeHtml(detail.description)}</p></div>`);
    if (detail.screenshots.length) sections.push('<div class="gp-section gp-media"><h3>Screenshots</h3><div class="gp-shots-clip"><div class="gp-shots"></div></div></div>');
    const facts = [
      ['Developer', game.developer],
      ['Publisher', game.publisher],
      ['Released', game.year],
      ['Genres', game.genres.join(', ')],
      ['Available on', [...new Set(game.variants.map((v) => STORE_NAMES[v.source] ?? v.source))].join(', ')],
      ['Installed at', detail.install_dir],
    ].filter(([, v]) => v);
    if (facts.length) sections.push(`<div class="gp-section"><h3>Details</h3><div class="gp-facts">${facts.map(([k, v]) => `<div class="fact"><small>${k}</small><span>${escapeHtml(v)}</span></div>`).join('')}</div></div>`);
    this.body.innerHTML = sections.join('');
    this.moreEl.style.visibility = sections.length ? '' : 'hidden';

    this.shotTrack = this.body.querySelector('.gp-shots');
    if (this.shotTrack) {
      const shots = detail.screenshots.map((url, i) => {
        const shot = el('div', 'shot');
        const img = new Image();
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = '';
        img.src = url;
        shot.append(img);
        shot._run = () => this.openShot(i);
        this.shotTrack.append(shot);
        return shot;
      });
      this.rows[1] = shots;
      this.bindRow(shots, 1);
    }
    this.measure();
  }

  measure() {
    this.maxScroll = Math.max(0, this.scrollEl.scrollHeight - this.el.clientHeight);
  }

  /** The poster's image on its own, travelling from one rectangle to another. */
  fly(from, to, duration) {
    const flyer = el('div', 'flip');
    const clone = new Image();
    clone.src = this.el.querySelector('.gp-poster img')?.src ?? artUrl('cover', this.game);
    flyer.append(clone);
    flyer.style.width = `${to.width}px`;
    flyer.style.height = `${to.height}px`;
    flyer.style.backgroundImage = `url("${this.origin.querySelector('.t-cover').src}")`;
    document.body.append(flyer);
    const start = from.width / to.width;
    const animation = flyer.animate([
      { transform: `translate3d(${from.left}px,${from.top}px,0) scale(${start})`, borderRadius: `${1 / start}rem` },
      { transform: `translate3d(${to.left}px,${to.top}px,0) scale(1)`, borderRadius: '1.05rem' },
    ], { duration, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'both' });
    return animation.finished.finally(() => flyer.remove());
  }

  /** Whether the tile this page opened from is still there to fly to and from. */
  get flyable() {
    return this.origin?.isConnected && this.origin._game?.id === this.game.id
      && this.origin.querySelector('.t-cover.ready') && !document.documentElement.classList.contains('reduced');
  }

  flyFrom() {
    const poster = this.el.querySelector('.gp-poster');
    const to = poster.getBoundingClientRect();
    if (!this.flyable || !to.width) return;
    poster.style.visibility = 'hidden';
    this.fly(this.origin.querySelector('.t-card').getBoundingClientRect(), to, 560).then(() => {
      poster.style.visibility = '';
      poster.style.animation = 'none';
    });
  }

  flyBack() {
    const poster = this.el.querySelector('.gp-poster');
    const from = poster.getBoundingClientRect();
    if (!this.flyable || this.spring.value > 10) return;
    const card = this.origin.querySelector('.t-card');
    const to = card.getBoundingClientRect();
    if (to.bottom < 0 || to.top > innerHeight || to.right < 0 || to.left > innerWidth) return;
    poster.style.visibility = 'hidden';
    card.style.visibility = 'hidden';
    this.fly(from, to, 440).then(() => { card.style.visibility = ''; });
  }

  onScroll(value) {
    this.scrollEl.style.transform = `translate3d(0,${-value}px,0)`;
    this.heroEl.style.transform = `translate3d(0,${-value * 0.32}px,0)`;
    this.moreEl.style.opacity = value > 10 ? 0 : 1;
  }

  onWheel(e) {
    this.measure();
    this.spring.to(clamp(this.spring.target + e.deltaY * 1.1, 0, this.maxScroll));
  }

  paint() {
    this.rows.forEach((items, r) => items?.forEach((node, c) => node.classList.toggle('focused', r === this.row && c === this.col)));
  }

  moveTo(row, col) {
    if (this.row === row && this.col === col) return;
    this.row = row;
    this.col = col;
    this.paint();
    if (row === 1) this.revealShot(col);
  }

  revealShot(col) {
    const shot = this.rows[1]?.[col];
    if (!shot) return;
    const view = this.el.clientWidth - rem() * 8;
    const max = Math.max(0, this.shotTrack.scrollWidth - view);
    this.shots.to(clamp(shot.offsetLeft - rem() * 4 - view * 0.3, 0, max));
  }

  scrollForRow(row) {
    this.measure();
    if (row === 0) return this.spring.to(0);
    const media = this.body.querySelector('.gp-media');
    const top = this.scrollEl.clientHeight + (media?.offsetTop ?? 0);
    this.spring.to(clamp(top - this.el.clientHeight * 0.3, 0, this.maxScroll));
  }

  run() {
    const node = this.rows[this.row]?.[this.col];
    if (!node) return;
    node._run?.();
  }

  openShot(index) {
    play('select');
    const urls = this.detail.screenshots;
    let current = index;
    const box = el('div', 'lightbox', `<img alt=""><div class="count"></div>`);
    const show = () => {
      const image = box.querySelector('img');
      image.src = urls[current];
      box.querySelector('.count').textContent = `${current + 1} / ${urls.length}`;
    };
    show();
    const layer = {
      el: box,
      full: true,
      close() {
        layers.remove(layer);
        closeWith(box);
      },
      onAction: (action) => {
        if (action === 'left' && current > 0) { current -= 1; play('move'); show(); }
        else if (action === 'right' && current < urls.length - 1) { current += 1; play('move'); show(); }
        else if (action === 'back' || action === 'confirm') { play('back'); layer.close(); }
        return true;
      },
    };
    box.addEventListener('click', () => layer.close());
    layers.push(layer);
  }

  toggleFavorite(button) {
    const game = this.game;
    const favorite = !game.favorite;
    game.favorite = favorite;
    play('toggle');
    button.classList.toggle('on', favorite);
    button.innerHTML = favorite ? icons.heartFill : icons.heart;
    invoke('set_favorite', { id: game.id, favorite });
  }

  /** The library changed underneath: pick up the fresh record. */
  refresh() {
    const fresh = store.byId.get(this.game.id) ?? [...store.games].find((g) => g.variants.some((v) => v.id === this.game.id));
    if (!fresh) return;
    const restyled = fresh.art_rev !== this.game.art_rev || fresh.title !== this.game.title;
    this.game = fresh;
    if (restyled) this.fillArt();
    if (this.row === 0) this.col = Math.min(this.col, this.rows[0].length - 1);
    this.drawHead();
  }

  close() {
    this.gone = true;
    layers.remove(this);
    this.flyBack();
    closeWith(this.el);
  }

  onAction(action) {
    const { row, col, rows } = this;
    switch (action) {
      case 'left':
        if (col > 0) { play('move'); this.moveTo(row, col - 1); }
        break;
      case 'right':
        if (col < rows[row].length - 1) { play('move'); this.moveTo(row, col + 1); }
        break;
      case 'down':
        if (rows[row + 1]?.length) {
          play('move');
          this.moveTo(row + 1, clamp(col, 0, rows[row + 1].length - 1));
          this.scrollForRow(row + 1);
        } else {
          this.measure();
          this.spring.to(this.maxScroll);
        }
        break;
      case 'up':
        if (row > 0) {
          play('move');
          this.moveTo(row - 1, clamp(col, 0, rows[row - 1].length - 1));
          this.scrollForRow(row - 1);
        } else {
          this.spring.to(0);
        }
        break;
      case 'lt': this.spring.to(0); break;
      case 'rt': this.measure(); this.spring.to(this.maxScroll); break;
      case 'confirm': this.run(); break;
      case 'menu': this.app.openMenu(this.game, { fromPage: this }); break;
      case 'back': play('back'); this.close(); break;
      default: return false;
    }
    return true;
  }
}
