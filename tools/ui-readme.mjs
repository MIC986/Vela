// Takes the README's screenshots at a fixed size, on test data prepared by
// tools/readme-data.py. It switches tabs and modes but saves nothing that matters.
export default async ({ eval: ev, key, wait, shot, mouse, send }) => {
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1.25, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await wait(2500);
  while (await ev('window.__TAURI__.core.invoke("get_library").then((l) => l.scanning)')) await wait(300);
  await wait(2000);
  // Keys, not the mouse, so every selection shows at its brightest.
  await key('Right');
  await key('Left');
  await wait(2600);
  await shot('home');

  await key('Right');
  await wait(400);
  await key('Space');
  await wait(2800);
  await shot('game');
  await key('Esc');
  await wait(1200);

  await key('e');
  await wait(1500);
  await key('Right', 3, 200);
  await wait(1600);
  await shot('library');

  await ev('document.querySelector(".tab[data-tab=library]").click()');
  await wait(1800);
  await key('Down');
  await key('Up');
  await wait(1800);
  await shot('browse');
  const series = await ev('[...document.querySelectorAll(".shelf")].findIndex((s) => s.dataset.id === "series:battlefield")');
  await key('Down', Math.max(series, 1), 400);
  await key('Right');
  await wait(2600);
  await shot('series');
  await ev('document.querySelector(".tab[data-tab=library]").click()');
  await wait(600);

  await key('e');
  await wait(3000);
  await shot('stats');
  await key('q');
  await key('q');
  await wait(1200);

  await key('F11');
  await wait(1050);
  await shot('intro');
  await wait(2600);
  await shot('fullscreen');
  await key('F11');
  await wait(1500);
};
