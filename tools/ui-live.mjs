// Live library updates, search relevance, and frame pacing.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const FOLDER = `${process.env.VELA_DATA_DIR}\\watch`;

export default async ({ eval: ev, key, wait, send, shot, console: problems }) => {
  const ok = (label, value) => console.log(`${value ? 'PASS' : 'FAIL'}  ${label}`);
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await wait(2500);
  const has = (title) => ev(`window.__TAURI__.core.invoke('get_library').then((l) => l.games.some((g) => g.title === ${JSON.stringify(title)}))`);
  const toasts = () => ev('[...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" | ")');
  const until = async (test, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await test()) return true;
      await wait(400);
    }
    return false;
  };

  // A game dropped into a scan folder appears; an app with game-like files doesn't.
  const game = `${FOLDER}\\Glimmer.Quest.v1.2.3`;
  mkdirSync(game, { recursive: true });
  cpSync('C:\\Windows\\System32\\cmd.exe', `${game}\\GlimmerQuest.exe`);
  writeFileSync(`${game}\\UnityPlayer.dll`, 'x');
  const app = `${FOLDER}\\Note Studio`;
  mkdirSync(`${app}\\resources`, { recursive: true });
  cpSync('C:\\Windows\\System32\\cmd.exe', `${app}\\NoteStudio.exe`);
  writeFileSync(`${app}\\steam_api64.dll`, 'x');
  writeFileSync(`${app}\\LICENSES.chromium.html`, 'x');
  writeFileSync(`${app}\\resources\\app.asar`, 'x');
  writeFileSync(`${FOLDER}\\touch.txt`, 'x');
  ok('new game appears by itself', await until(() => has('Glimmer Quest'), 25000));
  ok('Electron app with Steam files stays out', !(await has('Note Studio')));
  await wait(600);
  await shot('40-game-added');
  console.log('toast:', await toasts());
  rmSync(game, { recursive: true, force: true });
  writeFileSync(`${FOLDER}\\touch2.txt`, 'x');
  ok('deleted game disappears by itself', await until(async () => !(await has('Glimmer Quest')), 25000));
  await wait(400);
  console.log('toast:', await toasts());

  // Search relevance.
  await key('/');
  await wait(400);
  const results = async (text) => {
    await ev(`(() => { const i = document.querySelector(".search input"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input")); })()`);
    await wait(250);
    return ev('document.querySelector(".search-count").textContent');
  };
  const t = await results('t');
  console.log('"t":', t);
  ok('one letter is selective', parseInt(t) < 200);
  const gta = await results('gta');
  console.log('"gta":', gta);
  ok('initials find games', parseInt(gta) >= 1);
  await key('Esc');
  await wait(500);

  // Frame pacing while moving, measured inside the page.
  const measure = async (run) => {
    await ev(`window.__f = []; window.__last = performance.now(); window.__on = true;
      (function loop(now) { window.__f.push(now - window.__last); window.__last = now; if (window.__on) requestAnimationFrame(loop); })(performance.now())`);
    await run();
    return ev(`(() => { window.__on = false; const f = window.__f.slice(2).sort((a, b) => a - b);
      const at = (p) => f[Math.floor(f.length * p)];
      return { frames: f.length, median: +at(.5).toFixed(1), p95: +at(.95).toFixed(1), p99: +at(.99).toFixed(1), worst: +f[f.length - 1].toFixed(1) }; })()`);
  };
  console.log('home scroll', JSON.stringify(await measure(() => key('Right', 24, 70))));
  await key('e');
  await wait(900);
  await ev('void 0');
  console.log('tab switch + library', JSON.stringify(await measure(async () => {
    await key('PageDown', 8, 220);
    await key('Down', 10, 90);
  })));
  await key('q');
  await wait(500);
  await key('F11');
  await wait(1500);
  console.log('full screen home', JSON.stringify(await measure(() => key('Right', 24, 70))));
  await key('e');
  await wait(900);
  await ev(`window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] })`);
  console.log('full screen library', JSON.stringify(await measure(() => key('PageDown', 8, 220))));
  console.log('full screen main-thread stalls', JSON.stringify(await ev('window.__long')));
  await key('q');
  await wait(500);
  await key('F11');
  await wait(1000);
  ok('no console problems', problems.length === 0);
};
