// An on-screen keyboard for controllers, shared by Search and the rename dialog.

import { el } from './core.js';
import { icons } from './icons.js';
import { play } from './sound.js';

const ROWS = ['1234567890', 'qwertyuiop', "asdfghjkl'", 'zxcvbnm,.-'];

export class Keyboard {
  /** `capitals` starts each word with a capital letter, for names. */
  constructor(input, onChange, { capitals = false } = {}) {
    this.input = input;
    this.onChange = onChange;
    this.capitals = capitals;
    this.el = el('div', 'osk');
    this.active = false;
    this.keys = [];
    this.shift = false;
    const addRow = (defs) => {
      const row = el('div', 'osk-row');
      const nodes = defs.map((def) => {
        const key = el('button', `key ${def.cls ?? ''}`, def.html ?? def.key);
        key._run = def.run ?? (() => this.type(def.key));
        if (def.key) key.dataset.letter = def.key;
        key.addEventListener('click', () => key._run());
        row.append(key);
        return key;
      });
      this.el.append(row);
      this.keys.push(nodes);
    };
    for (const row of ROWS) addRow([...row].map((key) => ({ key })));
    const bottom = [
      { html: 'Space', cls: 'wide', run: () => this.type(' ') },
      { html: icons.backspace, cls: 'mid', run: () => this.erase() },
      { html: 'Clear', cls: 'mid', run: () => this.clear() },
    ];
    if (capitals) bottom.unshift({ html: 'Shift', cls: 'mid shift', run: () => this.toggleShift() });
    addRow(bottom);
    this.row = 2;
    this.col = 4;
    this.autoShift();
  }

  /** Capitals where a name would have them: at the start, and after a space. */
  autoShift() {
    if (!this.capitals) return;
    const text = this.input.value;
    this.setShift(!text || text.endsWith(' '));
  }

  setShift(on) {
    this.shift = on;
    this.el.classList.toggle('shifted', on);
    for (const row of this.keys) {
      for (const key of row) if (key.dataset.letter) key.textContent = on ? key.dataset.letter.toUpperCase() : key.dataset.letter;
    }
  }

  toggleShift() {
    play('toggle');
    this.setShift(!this.shift);
  }

  type(text) {
    this.input.value += this.shift ? text.toUpperCase() : text;
    play('toggle');
    this.autoShift();
    this.onChange();
  }

  erase() {
    this.input.value = this.input.value.slice(0, -1);
    play('toggle');
    this.autoShift();
    this.onChange();
  }

  clear() {
    this.input.value = '';
    play('toggle');
    this.autoShift();
    this.onChange();
  }

  setActive(on) {
    this.active = on;
    this.paint();
  }

  paint() {
    this.keys.forEach((row, r) => row.forEach((key, c) => key.classList.toggle('focused', this.active && r === this.row && c === this.col)));
  }

  /** Moves between keys or presses one. Reports an edge the selection can't cross. */
  action(action) {
    const rows = this.keys;
    const across = (to) => {
      const ratio = (this.col + 0.5) / rows[this.row].length;
      this.row = to;
      this.col = Math.min(Math.floor(ratio * rows[to].length), rows[to].length - 1);
      play('move');
    };
    if (action === 'left' && this.col > 0) { this.col -= 1; play('move'); }
    else if (action === 'right' && this.col < rows[this.row].length - 1) { this.col += 1; play('move'); }
    else if (action === 'down') {
      if (this.row === rows.length - 1) return 'below';
      across(this.row + 1);
    } else if (action === 'up') {
      if (this.row === 0) return 'above';
      across(this.row - 1);
    } else if (action === 'confirm') rows[this.row][this.col]._run();
    this.paint();
    return null;
  }
}
