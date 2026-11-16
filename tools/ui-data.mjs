// Reports what the interface has: counts, untitled or artless games, duplicates.
export default async ({ eval: ev }) => {
  const report = await ev(`(async () => {
    const lib = await window.__TAURI__.core.invoke('get_library');
    const games = lib.games;
    const check = async (kind, g) => {
      const r = await fetch('http://art.localhost/' + kind + '/' + encodeURIComponent(g.id) + '?r=' + g.art_rev);
      return r.ok;
    };
    const noCover = [];
    for (const g of games.filter((g) => g.installed)) if (!(await check('cover', g))) noCover.push(g.title + ' [' + g.source + ']');
    const titles = new Map();
    for (const g of games) titles.set(g.title, (titles.get(g.title) ?? 0) + 1);
    return {
      total: games.length,
      installed: games.filter((g) => g.installed).length,
      gamepass: games.filter((g) => g.gamepass).length,
      withGenres: games.filter((g) => g.genres.length).length,
      withYear: games.filter((g) => g.year).length,
      scanning: lib.scanning,
      noCover,
      dupes: [...titles].filter(([, n]) => n > 1),
      minecraft: games.filter((g) => /minecraft/i.test(g.title)).map((g) => [g.title, g.source, g.installed, g.gamepass, g.variants.length]),
      local: games.filter((g) => g.source === 'local').map((g) => g.title),
      multi: games.filter((g) => g.variants.length > 1 && g.installed).map((g) => g.title + ': ' + g.variants.map((v) => v.source + (v.installed ? '*' : '')).join(',')).slice(0, 30),
    };
  })()`);
  console.log(JSON.stringify(report, null, 1));
};
