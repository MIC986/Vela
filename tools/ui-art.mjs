// Tiles at any window size: resizes the real window, and checks every tile is the
// same whole-pixel size, lands on a pixel boundary, and has art matching that size.
import { execFileSync } from 'node:child_process';

const RESIZE = `
Add-Type -Namespace Vela -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int h2, uint f);'
$w = (Get-Process vela | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1).MainWindowHandle
[void][Vela.Win]::SetWindowPos($w, [IntPtr]::Zero, 40, 40, WIDTH, HEIGHT, 0x14)`;

export default async ({ eval: ev, wait, shot, key }) => {
  const ok = (label, value) => console.log(`${value ? 'PASS' : 'FAIL'}  ${label}`);
  await wait(3000);
  const resize = async (width, height) => {
    execFileSync('powershell', ['-NoProfile', '-Command', RESIZE.replace('WIDTH', width).replace('HEIGHT', height)]);
    await wait(1500);
  };
  const check = async (name, selector) => {
    const r = await ev(`(() => {
      const tiles = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((t) => t.style.visibility !== 'hidden' && !t.classList.contains('focused'));
      const size = new Set(), off = [];
      let thumb = new Set();
      for (const t of tiles) {
        const c = t.querySelector('.t-card').getBoundingClientRect();
        size.add(c.width.toFixed(2) + 'x' + c.height.toFixed(2));
        const whole = (v) => Math.abs(v * devicePixelRatio - Math.round(v * devicePixelRatio)) < 0.02;
        if (!whole(c.left) || !whole(c.top) || !whole(c.width) || !whole(c.height)) off.push([c.left, c.top]);
        const w = /[?&]w=(\\d+)/.exec(t.querySelector('.t-cover').src)?.[1];
        if (w) thumb.add(w);
      }
      return { win: innerWidth + 'x' + innerHeight, tiles: tiles.length, sizes: [...size], off: off.length, sample: off[0], thumbs: [...thumb] };
    })()`);
    console.log(name, JSON.stringify(r));
    ok(`${name}: every tile the same size`, r.sizes.length === 1);
    ok(`${name}: every tile on the pixel grid`, r.off === 0);
    ok(`${name}: all art asked for at one size`, r.thumbs.length === 1);
  };

  await check('home', '#home .tile:not(.more)');
  await key('e');
  await wait(900);
  await check('library', '#library .tile');
  for (const [w, h] of [[1000, 640], [1920, 1000], [1377, 911], [1440, 900]]) {
    await resize(w, h);
    await check(`library ${w}x${h}`, '#library .tile');
    await shot(`art-lib-${w}`);
  }
  await key('F11');
  await wait(1500);
  await check('library full', '#library .tile');
  await shot('art-lib-full');
  await key('q');
  await wait(900);
  await check('home full', '#home .tile:not(.more)');
  await shot('art-home-full');
  await key('F11');
  await wait(1500);
  await check('home window', '#home .tile:not(.more)');
  await key('/');
  await wait(800);
  await check('search', '.search .tile');
  await key('Esc');
  await wait(500);

  const report = await ev(`(async () => {
    const { games } = await window.__TAURI__.core.invoke('get_library');
    const out = [];
    let i = 0;
    const worker = async () => {
      while (i < games.length) {
        const g = games[i++];
        const img = new Image();
        img.src = 'http://art.localhost/cover/' + encodeURIComponent(g.id) + '?r=' + g.art_rev;
        try { await img.decode(); out.push([g.title, g.source, g.installed, img.naturalWidth, img.naturalHeight]); }
        catch { out.push([g.title, g.source, g.installed, 0, 0]); }
      }
    };
    await Promise.all([1, 2, 3, 4, 5, 6].map(worker));
    return out;
  })()`);
  const missing = report.filter((r) => !r[3]);
  const offRatio = report.filter((r) => r[3] && Math.abs(r[3] / r[4] - 2 / 3) > 0.03);
  console.log(`covers ${report.length}, none ${missing.length}, not 2:3 ${offRatio.length}`);
  console.log('no cover', JSON.stringify(missing.map((r) => r[0])));
  ok('every cover is 2:3', offRatio.length === 0);
};
