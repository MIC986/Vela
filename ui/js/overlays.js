// Menus, dialogs, and the launch screen.

import { artUrl, clamp, el, escapeHtml, Spring } from './core.js';
import { icons } from './icons.js';
import { play } from './sound.js';
import { inputMode } from './input.js';
import { Keyboard } from './keyboard.js';
import { closeWith, FocusList, Glide, layers, loadLogo, setHints } from './ui.js';

export class Sheet {
  constructor({ title, sub, items, selected, onDismiss }) {
    this.el = el('div');
    this.el.style.cssText = 'position:absolute;inset:0';
    this.el.innerHTML = `<div class="scrim"></div><aside class="sheet">
      <h2>${escapeHtml(title)}</h2>${sub ? `<p class="sub">${escapeHtml(sub)}</p>` : ''}
      <div class="sheet-list"><div class="sheet-track"></div></div></aside>`;
    this.panel = this.el.querySelector('.sheet');
    this.scrim = this.el.querySelector('.scrim');
    this.track = this.el.querySelector('.sheet-track');
    this.onDismiss = onDismiss;
    const rows = items.map((item, i) => {
      const row = el('button', `mi${item.danger ? ' danger' : ''}${item.value !== undefined && item.value === selected ? ' selected' : ''}`,
        `${item.icon ?? ''}<span>${escapeHtml(item.label)}</span>${item.value !== undefined ? `<span class="tick">${icons.check}</span>` : ''}`);
      row.addEventListener('pointermove', (e) => {
        if (inputMode() === 'mouse' && (e.movementX || e.movementY) && this.list.index !== i) this.list.focus(i);
      });
      row.addEventListener('click', () => this.choose(i));
      this.track.append(row);
      return row;
    });
    this.items = items;
    this.spring = new Spring(0, (v) => { this.track.style.transform = `translate3d(0,${-v}px,0)`; });
    this.glide = new Glide(this.track);
    this.list = new FocusList(rows, (row) => {
      this.glide.to(row);
      // The mouse chooses what it can see; only a key or button needs the list to follow.
      if (!this.shown || inputMode() !== 'mouse') this.keepInView(row);
    });
    this.scrim.addEventListener('click', () => this.dismiss());
    this.el.addEventListener('wheel', (e) => {
      const box = this.el.querySelector('.sheet-list');
      this.spring.to(clamp(this.spring.target + e.deltaY, 0, Math.max(0, this.track.scrollHeight - box.clientHeight)));
    }, { passive: true });
    layers.push(this);
    const start = Math.max(0, items.findIndex((i) => i.value !== undefined && i.value === selected));
    this.list.focus(start);
    this.shown = true;
  }

  keepInView(row) {
    if (!row) return;
    const box = this.el.querySelector('.sheet-list').clientHeight;
    const max = Math.max(0, this.track.scrollHeight - box);
    this.spring.to(clamp(row.offsetTop - box / 2 + row.offsetHeight / 2, 0, max));
  }

  close() {
    layers.remove(this);
    closeWith(this.el, [this.panel, this.scrim]);
  }

  dismiss() {
    play('back');
    this.close();
    this.onDismiss?.();
  }

  choose(index) {
    const item = this.items[index];
    play('select');
    this.close();
    item.run?.();
  }

  onAction(action) {
    const { list } = this;
    if (action === 'up' && list.index > 0) { play('move'); list.focus(list.index - 1); }
    else if (action === 'down' && list.index < list.items.length - 1) { play('move'); list.focus(list.index + 1); }
    else if (action === 'confirm') this.choose(list.index);
    else if (action === 'back' || action === 'menu') this.dismiss();
    return true;
  }
}

export function confirmDialog({ title, body, yes, no = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const root = el('div', 'dialog-wrap', `<div class="scrim"></div><div class="dialog">
      <h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p>
      <div class="dialog-actions"><button class="btn" data-v="0">${escapeHtml(no)}</button><button class="btn" data-v="1">${escapeHtml(yes)}</button></div></div>`);
    const buttons = [...root.querySelectorAll('.btn')];
    const list = new FocusList(buttons);
    const layer = {
      el: root,
      finish(value) {
        layers.remove(layer);
        play(value ? 'select' : 'back');
        closeWith(root, [root.querySelector('.dialog'), root.querySelector('.scrim')]);
        resolve(value);
      },
      onAction(action) {
        if (action === 'left' || action === 'right') {
          play('move');
          list.focus(1 - list.index);
        } else if (action === 'confirm') layer.finish(list.index === 1);
        else if (action === 'back') layer.finish(false);
        return true;
      },
    };
    buttons.forEach((b, i) => {
      b.addEventListener('pointermove', () => list.focus(i));
      b.addEventListener('click', () => layer.finish(i === 1));
    });
    layers.push(layer);
    list.focus(danger ? 0 : 1);
  });
}

/** Asks for a line of text. Resolves with it, or null if cancelled. */
/**
 * Asks for a line of text. With a controller an on-screen keyboard comes up, so
 * nothing needs a physical keyboard.
 */
export function promptDialog({ title, value = '', placeholder = '', yes = 'Save' }) {
  return new Promise((resolve) => {
    const pad = inputMode() === 'gamepad';
    const root = el('div', 'dialog-wrap', `<div class="scrim"></div><div class="dialog${pad ? ' with-osk' : ''}">
      <h2>${escapeHtml(title)}</h2>
      <input class="dialog-input" type="text" spellcheck="false" aria-label="${escapeHtml(title)}" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}">
      <div class="dialog-actions"><button class="btn" data-v="0">Cancel</button><button class="btn" data-v="1">${escapeHtml(yes)}</button></div></div>`);
    const input = root.querySelector('input');
    const buttons = [...root.querySelectorAll('.btn')];
    const list = new FocusList(buttons);
    const keyboard = pad ? new Keyboard(input, () => {}, { capitals: true }) : null;
    let region = pad ? 'keys' : 'input';
    const paint = () => {
      keyboard?.setActive(region === 'keys');
      list.setActive(region !== 'keys');
    };
    if (keyboard) {
      root.querySelector('.dialog-actions').before(keyboard.el);
      // The text stays put while the keyboard types; Windows' own keyboard stays away.
      input.readOnly = true;
    }
    const layer = {
      el: root,
      finish(ok) {
        input.blur();
        layers.remove(layer);
        play(ok ? 'select' : 'back');
        closeWith(root, [root.querySelector('.dialog'), root.querySelector('.scrim')]);
        resolve(ok ? input.value : null);
      },
      onAction(action) {
        if (action === 'back') return layer.finish(false), true;
        if (keyboard && action === 'x') return keyboard.erase(), true;
        if (keyboard && action === 'y') return keyboard.type(' '), true;
        if (region === 'keys') {
          if (keyboard.action(action) === 'below') {
            play('move');
            region = 'buttons';
            list.focus(1);
            paint();
          }
          return true;
        }
        if (action === 'confirm') layer.finish(region === 'input' || list.index === 1);
        else if ((action === 'left' || action === 'right') && region === 'buttons') {
          play('move');
          list.focus(1 - list.index);
        } else if (action === 'up' && keyboard) {
          play('move');
          region = 'keys';
          paint();
        }
        return true;
      },
    };
    buttons.forEach((b, i) => {
      b.addEventListener('click', () => layer.finish(i === 1));
      b.addEventListener('pointermove', () => {
        if (inputMode() !== 'mouse') return;
        region = 'buttons';
        list.focus(i);
        paint();
      });
    });
    layers.push(layer);
    list.focus(1);
    paint();
    if (!keyboard) {
      input.focus();
      input.select();
    }
  });
}

/** Full-screen "starting" moment. The backend hides the window behind it. */
export class LaunchScreen {
  constructor(game, heroUrl, onCancel) {
    this.full = true;
    this.onCancel = onCancel;
    this.el = el('div', 'launch', `
      <div class="art"></div><div class="veil"></div>
      <div class="mark"><h1>${escapeHtml(game.title)}</h1><div class="status"><span class="spinner"></span>Starting</div></div>
      <div class="hints"></div>`);
    const art = this.el.querySelector('.art');
    const probe = new Image();
    probe.src = artUrl('hero', game);
    probe.decode().then(() => { art.style.backgroundImage = `url("${probe.src}")`; }, () => {
      art.classList.add('soft');
      art.style.backgroundImage = `url("${artUrl('cover', game)}")`;
    });
    loadLogo(game, 'logo').then((logo) => this.el.querySelector('h1')?.replaceWith(logo), () => {});
    setHints(this.el.querySelector('.hints'), [{ action: 'back', label: 'Back to Vela', mouse: true }], (a) => this.onAction(a));
    layers.push(this);
  }

  close() {
    layers.remove(this);
    closeWith(this.el);
  }

  onAction(action) {
    if (action === 'back') {
      play('back');
      this.close();
      this.onCancel();
    }
    return true;
  }
}
