// Full screen as a place of its own: Vela fades to black, its mark comes up with
// a swell of sound, and the interface opens around you. Leaving reverses it.

import { el, invoke } from './core.js';
import { play } from './sound.js';
import { store } from './state.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Without a mouse moving, the pointer disappears after this long. */
const IDLE_MS = 2600;

export class BigPicture {
  constructor(app) {
    this.app = app;
    this.busy = false;
    this.overlay = document.body.appendChild(el('div', 'bp-intro', `
      <div class="bp-glow"></div>
      <div class="bp-ring"></div>
      <div class="bp-mark"><img src="assets/icon.png" alt=""><b>Vela</b></div>`));
    document.body.prepend(el('div', 'bp-amb', '<i></i><i></i>'));
    let idle = 0;
    window.addEventListener('pointermove', () => {
      document.body.classList.remove('idle');
      clearTimeout(idle);
      if (this.on) idle = setTimeout(() => document.body.classList.add('idle'), IDLE_MS);
    });
  }

  get on() {
    return document.body.classList.contains('fullscreen');
  }

  get quick() {
    return store.settings.reduced_motion;
  }

  async toggle() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.on) await this.leave();
      else await this.enter();
    } finally {
      this.busy = false;
    }
  }

  /** Changes the window while the screen is black, so the jump in size is never seen. */
  async enter() {
    if (!this.quick) {
      this.overlay.className = 'bp-intro black';
      await wait(240);
    }
    await invoke('set_fullscreen', { on: true });
    document.body.classList.add('fullscreen');
    this.app.applySettings();
    if (this.quick) return;
    await wait(120);
    await this.arrive();
  }

  /** The intro itself, also played when Vela starts in full screen. */
  async arrive() {
    if (this.quick) return;
    this.overlay.className = 'bp-intro black play';
    play('intro');
    await wait(1250);
    this.overlay.className = 'bp-intro black play open';
    document.body.classList.add('bp-arrive');
    document.body.classList.remove('intro');
    void document.body.offsetWidth;
    document.body.classList.add('intro');
    await wait(900);
    this.overlay.className = 'bp-intro';
    document.body.classList.remove('bp-arrive');
    setTimeout(() => document.body.classList.remove('intro'), 1200);
  }

  async leave() {
    document.body.classList.remove('idle');
    if (!this.quick) {
      play('outro');
      this.overlay.className = 'bp-intro black out';
      await wait(260);
    }
    await invoke('set_fullscreen', { on: false });
    document.body.classList.remove('fullscreen');
    this.app.applySettings();
    if (this.quick) return;
    await wait(160);
    this.overlay.className = 'bp-intro fading';
    await wait(380);
    this.overlay.className = 'bp-intro';
  }
}
