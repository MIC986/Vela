// How the mouse feels: the wheel, sliders that hold still, and the customization
// controls. Uses real input events, because that's where these things go wrong.
export default async ({ eval: ev, key, wait, mouse, wheel, press, release, drag, shot, console: problems }) => {
  const ok = (label, value) => console.log(`${value ? 'PASS' : 'FAIL'}  ${label}`);
  const settings = () => ev('window.__TAURI__.core.invoke("get_settings")');
  const rect = (selector) => ev(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const clickOn = async (selector) => {
    const r = await rect(selector);
    await mouse(r.x + r.w / 2, r.y + r.h / 2, true);
    await wait(350);
  };
  const selected = async () => +(await ev('document.querySelector("#home .tile.focused")?.dataset.index'));
  const under = (x, y) => ev(`document.elementFromPoint(${x}, ${y})?.closest(".tile")?.dataset.index`);
  await wait(2500);
  // A scan can add or drop a game, which moves everything along the row by one.
  while (await ev('window.__TAURI__.core.invoke("get_library").then((l) => l.scanning)')) await wait(200);
  await wait(1200);

  // The wheel on Home ---------------------------------------------------------
  const tile = await rect('#home .tile[data-index="2"] .t-card');
  const [x, y] = [tile.x + tile.w / 2, tile.y + tile.h / 2];
  await mouse(x - 1, y);
  await mouse(x, y);
  await wait(300);
  const start = await selected();
  ok(`hovering selects the tile (${start})`, start === 2);

  for (let i = 0; i < 3; i += 1) {
    await wheel(x, y, 100);
    await wait(90);
  }
  ok('each notch moves one game', (await selected()) === start + 3);
  await wait(700);
  ok('the selected game stays under the pointer', +(await under(x, y)) === start + 3);

  for (let i = 0; i < 4; i += 1) {
    await wheel(x + i, y, 100);
    await mouse(x + i + 2, y + 2);
    await wait(90);
  }
  ok(`nudging the mouse while wheeling never pulls the selection back (${await selected()})`, (await selected()) === start + 7);
  await wait(700);
  await mouse(x + 6, y - 3);
  await wait(250);
  ok(`nor does nudging it afterwards (${await selected()})`, (await selected()) === start + 7);

  const count = await ev('document.querySelectorAll("#home .tile").length');
  for (let i = 0; i < count; i += 1) {
    await wheel(x, y, 100);
    await wait(16);
  }
  await wait(800);
  ok(`the wheel reaches the last tile (${await selected()} of ${count})`, (await selected()) === count - 1);
  await mouse(x + 2, y + 1);
  await wait(250);
  ok('a nudge at the end of the row stays there', (await selected()) === count - 1);
  await mouse(x + 400, y);
  await wait(300);
  ok('really moving the mouse takes over again', (await selected()) === +(await under(x + 400, y)));
  for (let i = 0; i < count; i += 1) {
    await wheel(x, y, -100);
    await wait(16);
  }
  await wait(800);
  ok('the wheel comes back to the first game', (await selected()) === 0);

  const before = await selected();
  await wheel(x, y, 8);
  await wait(30);
  await wheel(x, y, 8);
  ok('a touchpad needs a real swipe to move', (await selected()) === before);

  // Settings holds still under the mouse ---------------------------------------
  await clickOn('[data-do=settings]');
  await wait(500);
  const page = () => ev('document.querySelector(".set-track h2").textContent');
  const tabs = await ev('[...document.querySelectorAll(".set-tab")].map((t) => t.textContent)');
  const box = await rect('.set-tab:nth-of-type(4)');
  await mouse(box.x + 20, box.y + 10);
  await mouse(box.x + 24, box.y + 90);
  await wait(200);
  ok('passing over a section doesn’t open it', (await page()) === 'General');
  await clickOn(`.set-tab:nth-of-type(${tabs.indexOf('Appearance') + 1})`);
  ok('clicking a section opens it', (await page()) === 'Appearance');
  await wait(500);

  const unit = () => ev('parseFloat(getComputedStyle(document.documentElement).fontSize)');
  const slider = await rect('.slider');
  const size = (await settings()).ui_scale;
  const remBefore = await unit();
  const at = (ratio) => slider.x + slider.w * ratio;
  const midY = slider.y + slider.h / 2;
  await press(at(0.2), midY);
  await wait(60);
  let still = true;
  let under_pointer = true;
  for (const ratio of [0.3, 0.45, 0.6, 0.75, 0.9, 0.8]) {
    await drag(at(ratio), midY);
    await wait(50);
    const now = await rect('.slider');
    const knob = await rect('.slider u');
    still &&= Math.abs(now.x - slider.x) < 0.5 && Math.abs(now.w - slider.w) < 0.5 && Math.abs(now.y - slider.y) < 0.5;
    under_pointer &&= Math.abs(knob.x + knob.w / 2 - at(ratio)) < 1;
  }
  ok('dragging leaves the slider where it is', still);
  ok('the knob stays under the pointer', under_pointer);
  ok('the interface waits for you to let go', (await unit()) === remBefore && (await settings()).ui_scale === size);
  ok('the number shows where it will land', (await ev('document.querySelector(".num").textContent')) === '120%');
  await release(at(0.8), midY);
  await wait(60);
  ok('letting go applies the size', (await settings()).ui_scale === 1.2 && (await unit()) > remBefore);
  await shot('feel-resizing');
  await wait(500);
  const settled = await ev('document.querySelector(".set-frame").getAnimations().length');
  ok('and it eases into place', settled === 0);

  await key('Down', 1);
  await key('Up', 1);
  await wait(200);
  const steps = await settings();
  await key('Left', 2, 90);
  ok('keys hold the size back while pressed', (await settings()).ui_scale === steps.ui_scale);
  await wait(800);
  ok('and apply it after a moment', Math.abs((await settings()).ui_scale - (steps.ui_scale - 0.1)) < 0.001);
  await ev('window.__TAURI__.core.invoke("get_settings")');

  // The wheel in Settings isn't undone by a nudge.
  const scrolled = () => ev('(() => { const m = new DOMMatrix(getComputedStyle(document.querySelector(".set-track")).transform); return -m.m42; })()');
  const main = await rect('.set-main');
  await mouse(main.x + 300, main.y + 300);
  await wheel(main.x + 300, main.y + 300, 400);
  await wait(700);
  const down = await scrolled();
  await mouse(main.x + 304, main.y + 306);
  await wait(500);
  ok(`a nudge doesn’t scroll Settings back (${Math.round(down)})`, down > 10 && Math.abs((await scrolled()) - down) < 1);
  await wheel(main.x + 304, main.y + 306, -800);
  await wait(600);

  // Inline controls ------------------------------------------------------------
  await clickOn('.opt[data-value="soft"]');
  ok('a choice applies with one click', (await settings()).background === 'soft');
  await wait(400);
  ok('the choice’s marker slides to it', (await ev('document.querySelector(".opt.on").textContent')) === 'Blurred');
  await wait(900);
  ok('the background follows', await ev('!!document.querySelector(".bd-layer.on.soft")'));
  await clickOn('.opt[data-value="art"]');
  await clickOn('.swatch:nth-child(5)');
  const accent = await settings();
  ok('an accent color can be picked', accent.accent === '190, 230, 100');
  ok('and is used', (await ev('getComputedStyle(document.documentElement).getPropertyValue("--accent")')).trim() === '190, 230, 100');
  await clickOn('.swatch:nth-child(1)');
  ok('Match the game comes back', (await settings()).accent === 'auto');
  await clickOn('.opt[data-value="round"]');
  ok('corners change', (await ev('getComputedStyle(document.querySelector("#home .t-card")).borderTopLeftRadius')) !== '');
  await clickOn('.opt[data-value="soft"]');

  await clickOn(`.set-tab:nth-of-type(${tabs.indexOf('Home') + 1})`);
  await wait(500);
  const row = await rect('.slider');
  await mouse(row.x + row.w * 0.2, row.y + row.h / 2, true);
  await wait(400);
  ok('the row holds as many games as asked', (await ev('document.querySelectorAll("#home .tile:not(.more)").length')) === (await settings()).home_count);
  await clickOn('.opt[data-value="large"]');
  await wait(300);
  const big = await ev('document.querySelector("#home .tile").offsetWidth');
  await clickOn('.opt[data-value="medium"]');
  await wait(300);
  ok('Home covers change size', big > (await ev('document.querySelector("#home .tile").offsetWidth')));

  await clickOn(`.set-tab:nth-of-type(${tabs.indexOf('Sound') + 1})`);
  await wait(400);
  ok('sound options hide while sound is off', !(await ev('!!document.querySelector(".slider")')));
  await key('Esc');
  await wait(300);
  await key('Esc');
  await wait(600);
  ok('settings closes', !(await ev('!!document.querySelector(".settings")')));

  // Your own name and art -------------------------------------------------------
  const id = await ev('document.querySelector("#home .tile")._game.id');
  await ev(`window.__TAURI__.core.invoke("rename_game", { id: ${JSON.stringify(id)}, title: "  My Game  " })`);
  await wait(1500);
  ok('a game can be renamed', (await ev('document.querySelector("#home .tile")._game?.title')) === 'My Game');
  await key('m');
  await wait(500);
  ok('a renamed game keeps its options', await ev('[...document.querySelectorAll(".mi")].some((m) => m.textContent === "Customize")'));
  await key('Esc');
  await wait(400);
  await ev(`window.__TAURI__.core.invoke("reset_game_look", { id: ${JSON.stringify(id)} })`);
  await wait(1500);
  ok('and put back', (await ev('document.querySelector("#home .tile")._game?.customized')) === false);
  ok('no errors', problems.length === 0);
};
