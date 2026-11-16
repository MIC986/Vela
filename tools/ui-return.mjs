// Phase 2 of the lifecycle test: runs in the window recreated after the game exits.
export default async ({ eval: ev, wait, shot }) => {
  await wait(1500);
  await shot('32-returned');
  const toast = await ev('[...document.querySelectorAll(".toast")].map((t) => t.textContent)');
  console.log('toasts', JSON.stringify(toast));
  console.log('focused', await ev('document.querySelector("#home .tile.focused .t-cover")?.getAttribute("src") ?? null'));
  const stats = await ev(`(async () => {
    const lib = await window.__TAURI__.core.invoke('get_library');
    const g = lib.games.find((g) => /Fake Test Game/.test(g.title));
    return g && { playtime: g.playtime, last: g.last_played, installed: g.installed };
  })()`);
  console.log('stats', JSON.stringify(stats));
};
