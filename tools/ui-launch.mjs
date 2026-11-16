// Phase 1 of the lifecycle test: launches the fake game from Home through the UI.
export default async ({ eval: ev, key, wait, send, shot }) => {
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await wait(2500);
  const index = await ev(`(async () => {
    const lib = await window.__TAURI__.core.invoke('get_library');
    return lib.games.find((g) => /Fake Test Game/.test(g.title))?.id ?? null;
  })()`);
  console.log('fake game', index);
  // Move focus to it; it was just added, so search finds it.
  await key('/');
  await wait(500);
  await ev('(() => { const i = document.querySelector(".search input"); i.value = "fake test"; i.dispatchEvent(new Event("input")); })()');
  await wait(400);
  await key('Down');
  await wait(200);
  await key('Enter');
  await wait(1200);
  await shot('30-fake-page');
  // Backing out while it starts leaves no session behind and returns to the page.
  await key('Enter');
  await wait(400);
  await key('Esc');
  await wait(600);
  console.log('cancelled launch', await ev('!document.querySelector(".launch") && !!document.querySelector(".gp")'));
  console.log('session after cancel', await ev('window.__TAURI__.core.invoke("current_session")'));
  await wait(3000);
  console.log('still in the window', await ev('window.__TAURI__.window.getCurrentWindow().isVisible()'));
  await key('Enter');
  await wait(700);
  await shot('31-launching');
  console.log('launch overlay', await ev('!!document.querySelector(".launch")'));
};
