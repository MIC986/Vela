// Search across everything, typed or picked out on an on-screen keyboard.

import { el } from './core.js';
import { Grid } from './grid.js';
import { icons } from './icons.js';
import { inputMode } from './input.js';
import { play } from './sound.js';
import { Keyboard } from './keyboard.js';
import { closeWith, layers, setHints } from './ui.js';
import { store } from './state.js';

/** Whether `word` starts one of the words of `text`. */
const startsWord = (text, word) => new RegExp(`(^|[^a-z0-9])${word.replace(/[^a-z0-9]/g, '\$&')}`).test(text);

function matchScore(game, words) {
  const title = game.title.toLowerCase();
  const initials = title.split(/[^a-z0-9]+/).map((w) => w[0] ?? '').join('');
  const about = [game.developer, game.publisher, ...game.genres].filter(Boolean).map((t) => t.toLowerCase());
  let score = 0;
  for (const word of words) {
    // A letter or two only means something at the start of a word; matching inside
    // words would make every first keystroke return everything.
    const at = title.indexOf(word);
    if (at === 0) score += 4;
    else if (startsWord(title, word)) score += 3;
    else if (at > 0 && word.length >= 3) score += 2;
    else if (word.length >= 2 && initials.startsWith(word)) score += 1;
    // Developer, publisher and genre count for less than the name, so a game called
    // what you typed comes before games merely made by someone called that.
    else if (word.length >= 2 && about.some((t) => startsWord(t, word))) score += 0.8;
    else if (word.length >= 4 && about.some((t) => t.includes(word))) score += 0.4;
    else return 0;
  }
  return score + (game.installed ? 0.25 : 0);
}

/** Why a game matched, when it wasn't by name. */
function matchReason(game, words) {
  const title = game.title.toLowerCase();
  if (words.every((w) => title.includes(w) || title.split(/[^a-z0-9]+/).map((x) => x[0] ?? '').join('').startsWith(w))) return null;
  const fields = [[game.developer, 'Developer'], [game.publisher, 'Publisher'], ...game.genres.map((g) => [g, 'Genre'])];
  const found = fields.find(([text]) => text && words.some((w) => text.toLowerCase().includes(w)));
  return found ? found[0] : null;
}

export class Search {
  constructor(app) {
    this.app = app;
    this.full = true;
    this.region = 'input';
    this.el = el('section', 'search', `
      <div class="search-box">${icons.search}<input type="text" spellcheck="false" placeholder="Search your games" aria-label="Search your games"><span class="search-count"></span></div>
      <div class="search-grid"><div class="search-track"></div></div>
      <div class="search-empty">${icons.search}<b>No games found</b><span>Check the spelling, or try fewer words.</span></div>
      <div class="search-hints"></div>`);
    this.input = this.el.querySelector('input');
    this.countEl = this.el.querySelector('.search-count');
    this.emptyEl = this.el.querySelector('.search-empty');
    this.grid = new Grid(this.el.querySelector('.search-grid'), {
      tileRem: 9.5,
      heightRem: 14.25,
      topRem: 1.2,
      onActivate: (game) => { if (game) this.app.openGame(game, this.grid.element); },
      onMenu: (game) => this.app.openMenu(game),
      note: (game) => this.reasons?.get(game.id),
    });
    this.input.addEventListener('input', () => this.query());
    this.keyboard = new Keyboard(this.input, () => this.query());
    this.el.insertBefore(this.keyboard.el, this.el.querySelector('.search-hints'));
    this.useKeyboard(inputMode() === 'gamepad');
    this.drawHints();
    layers.push(this);
    this.query();
    if (this.onScreen) this.setRegion('keys');
    else setTimeout(() => this.input.focus(), 30);
  }

  useKeyboard(on) {
    this.onScreen = on;
    this.el.classList.toggle('keyboard', on);
  }

  drawHints() {
    const hints = [{ action: 'confirm', label: 'Select' }, { action: 'back', label: 'Back', mouse: true }];
    if (this.onScreen) hints.splice(1, 0, { action: 'x', label: 'Delete' }, { action: 'y', label: 'Space' });
    setHints(this.el.querySelector('.search-hints'), hints, (a) => this.onAction(a));
  }

  setRegion(region) {
    this.region = region;
    this.keyboard.setActive(region === 'keys');
    this.grid.setActive(region === 'grid');
  }

  query() {
    const text = this.input.value.trim().toLowerCase();
    const words = text.split(/\s+/).filter(Boolean);
    let results;
    if (!words.length) {
      this.reasons = null;
      results = [...store.games].filter((g) => g.installed).sort((a, b) => (b.last_played ?? 0) - (a.last_played ?? 0));
      this.countEl.textContent = '';
    } else {
      results = store.games
        .map((g) => [matchScore(g, words), g])
        .filter(([s]) => s > 0)
        .sort((a, b) => b[0] - a[0] || a[1].title.localeCompare(b[1].title))
        .map(([, g]) => g);
      this.reasons = new Map(results.map((g) => [g.id, matchReason(g, words)]));
      this.countEl.textContent = `${results.length} ${results.length === 1 ? 'result' : 'results'}`;
    }
    this.grid.set(results, { keep: false });
    this.emptyEl.classList.toggle('on', !results.length);
  }

  refresh() {
    this.grid.refill();
  }

  close() {
    this.input.blur();
    layers.remove(this);
    closeWith(this.el);
  }

  onResume() {
    if (!this.onScreen && this.region === 'input') this.input.focus();
  }

  onAction(action) {
    if (action === 'back') {
      play('back');
      return this.close(), true;
    }
    if (this.onScreen) {
      if (action === 'x') return this.keyboard.erase(), true;
      if (action === 'y') return this.keyboard.type(' '), true;
    }
    if (this.region === 'keys') {
      if (this.keyboard.action(action) === 'above' && this.grid.items.length) {
        play('move');
        this.setRegion('grid');
      }
      return true;
    }
    if (this.region === 'input') {
      if (action === 'down' && this.grid.items.length) {
        this.input.blur();
        this.setRegion('grid');
      } else if (action === 'confirm' && this.grid.items.length) {
        this.input.blur();
        this.setRegion('grid');
      }
      return true;
    }
    switch (action) {
      case 'up':
        if (!this.grid.move('up') && !this.onScreen) {
          this.setRegion('input');
          this.input.focus();
        }
        break;
      case 'down':
        if (this.onScreen && this.grid.index + this.grid.cols >= this.grid.items.length) this.setRegion('keys');
        else this.grid.move('down');
        break;
      case 'left': case 'right': case 'lt': case 'rt': this.grid.move(action); break;
      case 'confirm': if (this.grid.game) this.app.openGame(this.grid.game, this.grid.element); break;
      case 'menu': if (this.grid.game) this.app.openMenu(this.grid.game); break;
      default: break;
    }
    return true;
  }
}
