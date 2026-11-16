// Turns keyboard, mouse-free navigation and controllers into one stream of actions.
// Views only ever see names like "up", "confirm" and "menu".

import { play } from './sound.js';

const KEYS = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Enter: 'confirm', Escape: 'back', Backspace: 'back', ' ': 'x', m: 'menu', M: 'menu', ContextMenu: 'menu',
  '/': 'y', f: 'view', F: 'view', q: 'lb', Q: 'lb', e: 'rb', E: 'rb', PageUp: 'lt', PageDown: 'rt',
};

const REPEATING = new Set(['up', 'down', 'left', 'right', 'lt', 'rt']);

/** For players used to the other side's confirm button. */
export const SWAPPED = { confirm: 'back', back: 'confirm' };

const BUTTONS = [
  [0, 'confirm'], [1, 'back'], [2, 'x'], [3, 'y'], [4, 'lb'], [5, 'rb'], [6, 'lt'], [7, 'rt'], [8, 'view'], [9, 'menu'],
  [12, 'up'], [13, 'down'], [14, 'left'], [15, 'right'],
];

const REPEAT_DELAY = 340;
const REPEAT_FIRST = 130;
const REPEAT_FAST = 62;
const REPEAT_SPEEDS = { slow: 1.6, normal: 1, fast: 0.6 };

let sink = () => {};
let onModeChange = () => {};
let onPadChange = () => {};
let mode = 'mouse';
let padKind = null;
let swapFaceButtons = false;
let repeatGap = 1;

export function configureInput({ swap, repeat }) {
  swapFaceButtons = swap;
  repeatGap = REPEAT_SPEEDS[repeat] ?? 1;
}

export const inputMode = () => mode;
export const padType = () => padKind;

function setMode(next) {
  if (mode === next) return;
  mode = next;
  document.body.dataset.input = next;
  onModeChange(next);
}

function identify(id) {
  return /dualsense|dualshock|wireless controller|054c/i.test(id) ? 'playstation' : 'xbox';
}

// Per-action press state, for edge detection and hold-to-repeat.
const held = new Map();

function press(action, now) {
  if (held.has(action)) {
    const state = held.get(action);
    if (REPEATING.has(action) && now >= state.next) {
      state.count += 1;
      state.next = now + Math.max(REPEAT_FAST, REPEAT_FIRST - state.count * 9) * repeatGap;
      sink(action, { repeat: true });
    }
    return;
  }
  held.set(action, { next: now + REPEAT_DELAY, count: 0 });
  sink(action, { repeat: false });
}

function pollPads(now) {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pressed = new Set();
  for (const pad of pads) {
    if (!pad || !pad.connected) continue;
    for (const [index, action] of BUTTONS) {
      if (pad.buttons[index]?.pressed) pressed.add(swapFaceButtons ? (SWAPPED[action] ?? action) : action);
    }
    const [x = 0, y = 0] = pad.axes;
    if (Math.abs(x) > 0.55 || Math.abs(y) > 0.55) {
      if (Math.abs(x) > Math.abs(y)) pressed.add(x > 0 ? 'right' : 'left');
      else pressed.add(y > 0 ? 'down' : 'up');
    }
  }
  if (pressed.size) setMode('gamepad');
  for (const action of held.keys()) {
    if (!pressed.has(action) && held.get(action).pad) held.delete(action);
  }
  for (const action of pressed) {
    const fresh = !held.has(action);
    press(action, now);
    if (fresh && held.has(action)) held.get(action).pad = true;
  }
}

// Every frame with a controller attached, for instant response. Without one, a
// slow check is enough, so an idle launcher doesn't wake up for every frame.
function loop(now) {
  if (document.hasFocus()) pollPads(now);
  if (held.size || [...(navigator.getGamepads?.() ?? [])].some(Boolean)) requestAnimationFrame(loop);
  else setTimeout(() => loop(performance.now()), 400);
}

const typing = () => document.activeElement?.tagName === 'INPUT';

function onKey(e) {
  // Keep browser shortcuts out of an app that isn't a browser.
  if (e.key === 'F5' || (e.ctrlKey && 'rpfgjsun+-=0'.includes(e.key.toLowerCase()))) e.preventDefault();
  if (e.key === 'F11') {
    e.preventDefault();
    sink('fullscreen', { repeat: e.repeat });
    return;
  }
  if (e.ctrlKey && e.key.toLowerCase() === 'f') {
    sink('y', { repeat: false });
    return;
  }
  let action = KEYS[e.key];
  if (typing()) {
    // In a text field only navigation keys are ours; the rest is text.
    if (!['ArrowUp', 'ArrowDown', 'Escape', 'Enter'].includes(e.key)) {
      if (e.key === 'Tab') e.preventDefault();
      return;
    }
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    action = e.shiftKey ? 'lb' : 'rb';
  }
  if (!action) return;
  e.preventDefault();
  setMode('keyboard');
  sink(action, { repeat: e.repeat });
}

export function startInput(handlers) {
  sink = handlers.action;
  onModeChange = handlers.mode;
  onPadChange = handlers.pad;
  window.addEventListener('keydown', onKey);
  window.addEventListener('pointermove', (e) => {
    if (e.movementX || e.movementY) setMode('mouse');
  });
  window.addEventListener('pointerdown', () => setMode('mouse'));
  window.addEventListener('wheel', () => setMode('mouse'), { passive: true });
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  window.addEventListener('gamepadconnected', (e) => {
    padKind = identify(e.gamepad.id);
    onPadChange(true, e.gamepad.id);
  });
  window.addEventListener('gamepaddisconnected', () => {
    if (![...navigator.getGamepads()].some(Boolean)) {
      padKind = null;
      onPadChange(false);
    }
  });
  window.addEventListener('blur', () => held.clear());
  loop(performance.now());
}

/** Moves a focus index through a list with a sound, or reports the edge. */
export function step(current, delta, length) {
  const next = current + delta;
  if (next < 0 || next >= length) return current;
  play('move');
  return next;
}
