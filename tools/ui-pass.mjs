// Game Pass: the question, the plans, and what turning it off leaves in place.
export default async ({ eval: ev, key, wait, shot, console: problems }) => {
  const ok = (label, value) => console.log(`${value ? 'PASS' : 'FAIL'}  ${label}`);
  const invoke = (command, args = {}) => ev(`window.__TAURI__.core.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
  const counts = () => ev(`window.__TAURI__.core.invoke("get_library").then((l) => ({
    installed: l.games.filter((g) => g.installed).length,
    catalog: l.games.filter((g) => g.gamepass && !g.installed).length,
    marked: l.games.filter((g) => g.gamepass && g.installed).length,
  }))`);
  const patch = async (changes) => {
    const settings = await invoke('get_settings');
    await invoke('set_settings', { settings: { ...settings, ...changes } });
    await wait(900);
  };
  const restart = async () => {
    await ev('location.reload()');
    await wait(3000);
  };
  const dialog = () => ev('document.querySelector(".dialog h2")?.textContent ?? ""');

  await wait(2500);
  while (await ev('window.__TAURI__.core.invoke("get_library").then((l) => l.scanning)')) await wait(200);
  for (let i = 0; i < 80 && (await counts()).catalog < 100; i++) await wait(500);

  const ultimate = await counts();
  ok(`Ultimate adds its catalog (${ultimate.catalog})`, ultimate.catalog > 300);
  await patch({ gamepass_plan: 'premium' });
  const premium = await counts();
  ok(`Premium brings fewer games (${premium.catalog})`, premium.catalog > 0 && premium.catalog < ultimate.catalog);
  await patch({ gamepass_plan: 'essential' });
  const essential = await counts();
  ok(`Essential brings fewer still (${essential.catalog})`, essential.catalog > 0 && essential.catalog < premium.catalog);

  await patch({ gamepass_on: false, gamepass_plan: 'ultimate' });
  const off = await counts();
  ok('off removes everything you could only download', off.catalog === 0);
  ok(`off keeps every installed game (${off.installed})`, off.installed === ultimate.installed);

  await patch({ gamepass_asked: false });
  await restart();
  ok('an installed Game Pass game brings up the question', (await dialog()).includes('Game Pass'));
  await shot('pass-question');
  await key('Enter');
  await wait(700);
  const plans = await ev('[...document.querySelectorAll(".sheet .mi")].map((m) => m.textContent)');
  ok(`yes asks which plan (${plans})`, plans.length === 4 && plans[2] === 'Game Pass Premium');
  await shot('pass-plans');
  await key('Down', 2, 90);
  await key('Enter');
  await wait(1200);
  let settings = await invoke('get_settings');
  ok('choosing a plan turns Game Pass on with that plan', settings.gamepass_on && settings.gamepass_plan === 'premium' && settings.gamepass_asked);
  ok('the plan shows its games straight away', (await counts()).catalog === premium.catalog);
  await restart();
  ok('the question comes only once', !(await dialog()));

  await patch({ gamepass_on: false, gamepass_asked: false });
  await restart();
  await key('Left');
  await key('Enter');
  await wait(1000);
  settings = await invoke('get_settings');
  ok('no leaves Game Pass off', !settings.gamepass_on && settings.gamepass_asked);
  await restart();
  ok('no is not asked again', !(await dialog()));

  const row = (label) => `[...document.querySelectorAll(".set-track .item")].find((r) => r.querySelector("b")?.textContent === ${JSON.stringify(label)})`;
  await ev('document.querySelector("[data-do=settings]").click()');
  await wait(600);
  await ev('[...document.querySelectorAll(".set-tab")].find((t) => t.textContent === "Library").click()');
  await wait(700);
  ok('off hides the plan', await ev(`!!${row('Xbox Game Pass')} && !${row('Plan')}`));
  await ev(`${row('Xbox Game Pass')}.click()`);
  await wait(900);
  ok('on offers the plan', await ev(`!!${row('Plan')}`));
  ok('there is no Auto any more', !(await ev('document.querySelector(".set-track").textContent.includes("Auto")')));
  await ev(`${row('Plan')}.querySelector('[data-value="essential"]').click()`);
  await wait(900);
  await shot('pass-settings');
  ok('settings can change the plan', (await invoke('get_settings')).gamepass_plan === 'essential');
  ok('settings changes the games too', (await counts()).catalog === essential.catalog);
  ok('no errors', problems.length === 0);
};
