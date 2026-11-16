// Interface sounds, synthesized so they're crisp at any volume and need no files.

let ctx = null;
let master = null;
let settings = { sound: true, volume: 0.5, tone: 'normal' };
let lastMove = 0;

const PITCH = { deep: 0.72, normal: 1, bright: 1.3 };

export function configureSound(next) {
  settings = next;
  if (master) master.gain.value = next.volume;
}

function context() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = settings.volume;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, { at = 0, length = 0.09, gain = 0.1, type = 'sine', to = null } = {}) {
  const audio = context();
  const start = audio.currentTime + at;
  const pitch = PITCH[settings.tone] ?? 1;
  const osc = audio.createOscillator();
  const env = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq * pitch, start);
  if (to) osc.frequency.exponentialRampToValueAtTime(to * pitch, start + length);
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(gain, start + 0.006);
  env.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(env).connect(master);
  osc.start(start);
  osc.stop(start + length + 0.02);
}

const sounds = {
  move() {
    // Held direction fires fast; thin the ticks out rather than rattling.
    const now = performance.now();
    if (now - lastMove < 55) return;
    lastMove = now;
    tone(1560, { length: 0.05, gain: 0.05, to: 1320 });
  },
  tab() { tone(980, { length: 0.08, gain: 0.07, to: 1240 }); },
  select() {
    tone(760, { length: 0.1, gain: 0.08 });
    tone(1140, { at: 0.05, length: 0.14, gain: 0.08 });
  },
  back() { tone(820, { length: 0.11, gain: 0.07, to: 560 }); },
  toggle() { tone(1320, { length: 0.05, gain: 0.06 }); },
  error() {
    tone(260, { length: 0.14, gain: 0.09, type: 'triangle' });
    tone(220, { at: 0.09, length: 0.16, gain: 0.08, type: 'triangle' });
  },
  /** Into full screen: a low swell that opens into a chord. */
  intro() {
    tone(98, { length: 1.8, gain: 0.08, to: 196 });
    for (const [i, f] of [392, 494, 587, 784].entries()) tone(f, { at: 0.22 + i * 0.1, length: 1.5 - i * 0.18, gain: 0.04 });
    tone(1568, { at: 0.62, length: 1, gain: 0.018 });
  },
  outro() {
    tone(587, { length: 0.4, gain: 0.05, to: 294 });
    tone(294, { at: 0.06, length: 0.55, gain: 0.04, to: 147 });
  },
  launch() {
    for (const [i, f] of [392, 587, 784, 1175].entries()) tone(f, { at: i * 0.075, length: 0.9 - i * 0.1, gain: 0.07 });
    tone(196, { length: 1.1, gain: 0.06, to: 392 });
  },
};

export function play(name) {
  if (!settings.sound) return;
  try {
    sounds[name]?.();
  } catch {
    // Audio is decoration: no output device must never break navigation.
  }
}
