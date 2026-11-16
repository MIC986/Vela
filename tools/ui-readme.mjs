// Takes the README's screenshots at a fixed size. Run against test data:
// it switches tabs and modes but saves nothing that matters.
export default async ({ eval: ev, key, wait, shot, mouse, send }) => {
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1.25, mobile: false });
  await wait(2500);
  while (await ev('window.__TAURI__.core.invoke("get_library").then((l) => l.scanning)')) await wait(300);
  await wait(2500);
  await mouse(1590, 890);
  await key('Right');
  await key('Left');
  await wait(1800);
  await shot('home');

  await key('Space');
  await wait(2400);
  await shot('game');
  await key('Esc');
  await wait(900);

  await key('e');
  await wait(1400);
  await key('Down');
  await wait(1200);
  await shot('library');

  await ev('document.querySelector(".tab[data-tab=library]").click()');
  await wait(1500);
  const series = await ev('[...document.querySelectorAll(".shelf")].findIndex((s) => s.dataset.id.startsWith("series:"))');
  await key('Down', series, 400);
  await key('Right');
  await wait(2200);
  await shot('browse');
  await ev('document.querySelector(".tab[data-tab=library]").click()');
  await wait(600);

  await key('e');
  await wait(2800);
  await shot('stats');
  await key('q');
  await key('q');
  await wait(900);

  await key('/');
  await wait(600);
  await ev('(() => { const i = document.querySelector(".search input"); i.value = "mine"; i.dispatchEvent(new Event("input")); })()');
  await wait(1200);
  await shot('search');
  await key('Esc');
  await wait(600);

  await ev('document.querySelector("[data-do=settings]").click()');
  await wait(900);
  await ev('[...document.querySelectorAll(".set-tab")].find((t) => t.textContent === "Appearance").click()');
  await wait(1200);
  await shot('settings');
};
