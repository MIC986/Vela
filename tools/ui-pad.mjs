// Drives the interface with a simulated controller through the real polling path.
export default async ({ eval: ev, send, shot, wait, console: problems }) => {
  const ok = (label, value) => console.log(`${value ? 'PASS' : 'FAIL'}  ${label}`);
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await wait(2000);
  await ev(`(() => {
    const pad = { id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    window.__pad = pad;
    navigator.getGamepads = () => [pad];
    window.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: pad }));
  })()`);
  await wait(300);
  const hold = async (index, ms = 90) => {
    await ev(`window.__pad.buttons[${index}].pressed = true`);
    await wait(ms);
    await ev(`window.__pad.buttons[${index}].pressed = false`);
    await wait(90);
  };
  const stick = async (x, y, ms) => {
    await ev(`window.__pad.axes[0] = ${x}; window.__pad.axes[1] = ${y}`);
    await wait(ms);
    await ev('window.__pad.axes[0] = 0; window.__pad.axes[1] = 0');
    await wait(120);
  };
  const focused = () => ev('document.querySelector("#home .tile.focused")?.dataset.index');

  const start = +(await focused());
  await hold(15);
  ok('d-pad right moves one', +(await focused()) === start + 1);
  ok('controller glyphs show', await ev('document.querySelector(".home-hints .glyph.a")?.textContent === "A"'));
  ok('input mode is gamepad', await ev('document.body.dataset.input === "gamepad"'));
  ok('pad indicator is on', await ev('document.querySelector(".pad-dot").classList.contains("on")'));
  await shot('20-pad-home');
  await hold(15, 1000);
  const after = +(await focused());
  ok(`holding repeats (moved ${after - start - 1})`, after - start - 1 >= 4);
  await stick(-1, 0, 90);
  ok('stick moves left once', +(await focused()) === after - 1);
  await stick(0.3, 0, 200);
  ok('small stick drift is ignored', +(await focused()) === after - 1);

  await hold(5);
  await wait(800);
  ok('RB switches to Library', (await ev('document.body.dataset.tab')) === 'library');
  await hold(13);
  await hold(15);
  await hold(0);
  await wait(1600);
  ok('A opens the game page', await ev('!!document.querySelector(".gp")'));
  await shot('21-pad-game');
  await hold(1);
  await wait(600);
  ok('B closes the page', await ev('!document.querySelector(".gp")'));
  await hold(9);
  await wait(600);
  ok('Menu opens options', await ev('!!document.querySelector(".sheet")'));
  await hold(1);
  await wait(500);
  await hold(3);
  await wait(700);
  ok('Y opens search with on-screen keyboard', await ev('document.querySelector(".search")?.classList.contains("keyboard")'));
  await hold(12);
  await hold(14, 120);
  await hold(0);
  await wait(200);
  const typed = await ev('document.querySelector(".search input").value');
  console.log('typed', JSON.stringify(typed));
  ok('on-screen key types', typed.length === 1);
  await shot('22-pad-search');
  await hold(2);
  ok('X deletes', (await ev('document.querySelector(".search input").value')) === '');
  await hold(1);
  await wait(500);
  await hold(4);
  await wait(800);
  ok('LB returns Home', (await ev('document.body.dataset.tab')) === 'home');
  await ev('delete navigator.getGamepads');
  console.log('problems', problems.length);
};
