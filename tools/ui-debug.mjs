export default async ({ eval: ev, key, wait, mouse, send }) => {
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await wait(600);
  console.log('tab', await ev('document.body.dataset.tab'), 'overlays', await ev('document.getElementById("overlays").children.length'), 'bodyclass', await ev('document.body.className'));
  const box = await ev('(() => { const r = document.querySelector("[data-do=search]").getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()');
  console.log('box', box);
  const x = box[0] + box[2] / 2;
  const y = box[1] + box[3] / 2;
  console.log('at point', await ev(`(() => { const e = document.elementFromPoint(${x}, ${y}); return e ? e.tagName + '.' + (e.className.baseVal ?? e.className) : null; })()`));
  await ev(`window.__clicks = []; window.addEventListener('click', (e) => window.__clicks.push(e.target.tagName + ':' + (e.target.closest('[data-do]')?.dataset.do ?? 'none')), true)`);
  await mouse(x, y, true);
  await wait(600);
  console.log('clicks', await ev('window.__clicks'), 'search open', await ev('!!document.querySelector(".search")'));
  if (await ev('!!document.querySelector(".search")')) await key('Esc');
  await wait(400);
  await key('e');
  await wait(700);
  console.log('cols', await ev('[...new Set([...document.querySelectorAll(".grid .tile")].map((t) => t.style.transform.split(",")[0]))].length'));
  await key('Down');
  await key('PageDown', 6, 180);
  await wait(500);
  let ups = 0;
  while (!(await ev('document.querySelector(".lib-bar .chip.focused") !== null')) && ups < 50) {
    await key('Up', 1, 60);
    ups += 1;
  }
  console.log('ups needed', ups, 'reached bar', ups < 50);
  await key('Down');
  await wait(300);
  await key('q');
  await wait(500);
};
