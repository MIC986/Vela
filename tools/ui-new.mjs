// The Library's two modes, shelves, Statistics, collections, search by maker,
// the controller keyboard, and full screen.
export default async ({ eval: ev, key, wait, shot, mouse, wheel, send, console: problems }) => {
  const ok = (label, value) => console.log(`${value ? 'PASS' : 'FAIL'}  ${label}`);
  const invoke = (command, args = {}) => ev(`window.__TAURI__.core.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
  await wait(2500);
  while (await ev('window.__TAURI__.core.invoke("get_library").then((l) => l.scanning)')) await wait(300);
  await wait(1500);

  // Library: clicking its tab again switches mode.
  await ev('document.querySelector(".tab[data-tab=library]").click()');
  await wait(800);
  ok('the Library opens on all games', (await ev('document.getElementById("library").dataset.mode')) === 'grid');
  await ev('document.querySelector(".tab[data-tab=library]").click()');
  await wait(1200);
  ok('clicking Library again switches to shelves', (await ev('document.getElementById("library").dataset.mode')) === 'shelves');
  const shelves = await ev('[...document.querySelectorAll(".shelf")].map((s) => s.dataset.id)');
  ok(`shelves are built (${shelves.length})`, shelves.length >= 5);
  ok('the first shelf is the last games played', shelves[0] === 'recent');
  ok('a series gets a stage of its own', shelves.some((id) => id.startsWith('series:')));
  const overlaps = await ev(`(() => {
    const boxes = [...document.querySelectorAll('.shelf')].slice(0, 6).map((s) => s.getBoundingClientRect());
    return boxes.some((b, i) => i && b.top < boxes[i - 1].bottom - 1);
  })()`);
  ok('shelves stack without overlapping', !overlaps);
  await key('Down');
  await wait(500);
  ok('down moves to the second shelf', (await ev('document.querySelector(".shelf .tile.focused")?.closest(".shelf").dataset.id')) === shelves[1]);
  const along = await ev('+document.querySelector(".shelf .tile.focused")?.dataset.index');
  await key('Right', 2, 160);
  await wait(400);
  ok('right moves along a shelf', (await ev('+document.querySelector(".shelf .tile.focused")?.dataset.index')) === along + 2);
  ok('the bottom bar names the selected game', (await ev('document.querySelector(".lib-sel b")?.textContent ?? ""')).length > 0);
  await shot('new-shelves');

  // Wheeling through shelves while the mouse drifts: the page goes where the wheel says.
  const scrolled = () => ev('parseFloat(document.querySelector(".shelves-track").style.transform.split(",")[1] ?? 0)');
  for (let i = 0; i < 4; i++) {
    await wheel(700, 520, 240);
    await mouse(700 + i * 3, 520 + i * 2);
    await wait(80);
  }
  await wait(1500);
  const afterWheel = await scrolled();
  await mouse(705, 530);
  await mouse(712, 540);
  await wait(900);
  ok(`hovering doesn't move the page (${afterWheel} → ${await scrolled()})`, afterWheel < -200 && Math.abs((await scrolled()) - afterWheel) < 1);
  await key('Up');
  await wait(300);
  await key('Space');
  await wait(900);
  ok('X switches back to all games', (await ev('document.getElementById("library").dataset.mode')) === 'grid');

  // Collections.
  const target = await ev('document.querySelector(".grid .tile.focused")?._game ?? document.querySelector(".grid .tile")._game');
  await invoke('set_in_collection', { id: target.id, name: 'Weekend', member: true });
  await wait(1500);
  ok('a game joins a collection', (await ev(`window.__TAURI__.core.invoke("get_library").then((l) => l.collections.includes("Weekend") && l.games.find((g) => g.id === ${JSON.stringify(target.id)}).collections.includes("Weekend"))`)));
  ok('collections get a filter in the Library', await ev('!!document.querySelector(".lib-bar [data-key=collection]")'));
  await invoke('rename_collection', { name: 'Weekend', to: 'Sunday' });
  await wait(900);
  ok('a collection can be renamed', (await invoke('get_library')).collections[0] === 'Sunday');
  await invoke('delete_collection', { name: 'Sunday' });
  await wait(900);
  ok('a collection can be deleted', (await invoke('get_library')).collections.length === 0);

  // Statistics.
  await key('e');
  await wait(2200);
  ok('E moves on to Statistics', (await ev('document.body.dataset.tab')) === 'stats');
  ok('the headline numbers are there', (await ev('document.querySelectorAll(".st-kpi").length')) === 5);
  ok('most played lists games', (await ev('document.querySelectorAll(".st-row[data-game]").length')) > 0);
  const counted = await ev('document.querySelector(".st-kpi[data-key=\\"kpi:games\\"] b").textContent');
  ok(`the game count matches the library (${counted})`, +counted.replace(/\D/g, '') === (await invoke('get_library')).games.length);
  await key('Down', 2, 300);
  await wait(500);
  const focusedStat = await ev('document.querySelector(".st-focus.focused")?.dataset.key');
  ok(`down moves through Statistics (${focusedStat})`, focusedStat && focusedStat !== 'kpi:time');
  await shot('new-stats');
  await key('q');
  await key('q');
  await wait(800);
  ok('Q goes back to Home', (await ev('document.body.dataset.tab')) === 'home');

  // Search finds games by who made them.
  const made = (await invoke('get_library')).games.find((g) => g.developer && g.developer.length > 3 && !g.title.toLowerCase().includes(g.developer.toLowerCase().split(' ')[0]));
  await key('/');
  await wait(500);
  await ev(`(() => { const i = document.querySelector(".search input"); i.value = ${JSON.stringify(made.developer.split(' ')[0].toLowerCase())}; i.dispatchEvent(new Event("input")); })()`);
  await wait(500);
  ok(`search finds games by developer (${made.developer})`, await ev(`[...document.querySelectorAll(".search .tile")].some((t) => t._game?.id === ${JSON.stringify(made.id)})`));
  await key('Esc');
  await wait(500);

  // A controller brings up a keyboard for renaming.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await ev(`(() => {
    const pad = { id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    window.__pad = pad;
    navigator.getGamepads = () => [pad];
    window.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: pad }));
  })()`);
  // The app checks for controllers slowly until one is there.
  await wait(700);
  const hold = async (index) => {
    await ev(`window.__pad.buttons[${index}].pressed = true`);
    await wait(90);
    await ev(`window.__pad.buttons[${index}].pressed = false`);
    await wait(140);
  };
  await hold(15);
  ok('the controller is in charge', (await ev('document.body.dataset.input')) === 'gamepad');
  const game = await ev('document.querySelector("#home .tile.focused")._game');
  await ev(`(async () => { const { promptDialog } = await import('./js/overlays.js'); window.__rename = promptDialog({ title: 'Rename game', value: '' }); })()`);
  await wait(600);
  ok('a controller gets an on-screen keyboard', await ev('!!document.querySelector(".dialog .osk .key.focused")'));
  ok('the first letter is a capital', await ev('document.querySelector(".dialog .osk").classList.contains("shifted")'));
  await hold(0);
  await hold(15);
  await hold(0);
  await wait(200);
  const typed = await ev('document.querySelector(".dialog-input").value');
  ok(`pressing keys types, capital first (${typed})`, typed.length === 2 && typed[0] === typed[0].toUpperCase() && typed[1] === typed[1].toLowerCase());
  await shot('new-keyboard');
  await hold(1);
  await wait(500);
  ok('back cancels the keyboard dialog', !(await ev('!!document.querySelector(".dialog")')) && (await ev('window.__rename.then((v) => v === null)')));
  ok(`nothing was renamed (${game.title})`, (await ev('document.querySelector("#home .tile.focused")._game.title')) === game.title);
  await ev('navigator.getGamepads = () => []');
  await mouse(500, 500);

  // Full screen: an intro, a menu, and the way back.
  await key('F11');
  await wait(700);
  ok('full screen starts with the intro', await ev('document.querySelector(".bp-intro").classList.contains("play")'));
  await wait(2000);
  ok('the intro gets out of the way', !(await ev('document.querySelector(".bp-intro").classList.contains("black")')));
  ok('the window is full screen', await invoke('is_fullscreen'));
  ok('the top bar shows Vela', await ev('getComputedStyle(document.querySelector(".bp-brand")).display !== "none"'));
  await key('Esc');
  await wait(700);
  ok('back on Home opens the full screen menu', (await ev('document.querySelector(".sheet h2")?.textContent')) === 'Vela');
  await key('Enter');
  await wait(1400);
  ok('Leave full screen goes back to a window', !(await invoke('is_fullscreen')) && !(await ev('document.body.classList.contains("fullscreen")')));
  ok('no errors', problems.length === 0);
};
