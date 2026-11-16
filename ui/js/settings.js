import { clamp, el, escapeHtml, fmtBytes, invoke, rem, Spring } from './core.js';
import { icons, storeIcon } from './icons.js';
import { inputMode, padType } from './input.js';
import { play } from './sound.js';
import { closeWith, Glide, layers, setHints, toast } from './ui.js';
import { saveSettings, store } from './state.js';
import { confirmDialog, promptDialog, Sheet } from './overlays.js';

const ACCENTS = [
  ['auto', 'conic-gradient(#7dcdff,#b496ff,#ffb46e,#78e6aa,#7dcdff)'],
  ['125, 205, 255', 'rgb(125,205,255)'],
  ['90, 225, 215', 'rgb(90,225,215)'],
  ['120, 230, 170', 'rgb(120,230,170)'],
  ['190, 230, 100', 'rgb(190,230,100)'],
  ['245, 210, 90', 'rgb(245,210,90)'],
  ['255, 180, 110', 'rgb(255,180,110)'],
  ['255, 130, 100', 'rgb(255,130,100)'],
  ['255, 130, 160', 'rgb(255,130,160)'],
  ['180, 150, 255', 'rgb(180,150,255)'],
  ['225, 232, 245', 'rgb(225,232,245)'],
];

const TILE_SIZES = [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']];

/** What "Restore the default look" puts back. */
const DEFAULT_LOOK = {
  ui_scale: 1, accent: 'auto', background: 'art', background_level: 1, ambient_motion: true, reduced_motion: false, corners: 'soft', focus_glow: true,
};

const group = (name) => ({ type: 'static', html: () => `<div class="set-group">${name}</div>` });
const percent = (v) => `${Math.round(v * 100)}%`;

export class Settings {
  constructor(app) {
    this.app = app;
    this.full = true;
    this.sections = this.schema();
    this.tab = 0;
    this.region = 'nav';
    this.item = 0;
    this.el = el('section', 'settings', `<div class="set-frame">
      <nav class="set-nav"><h1>Settings</h1></nav>
      <div class="set-main"><div class="set-track"></div></div>
      <div class="set-hints"></div></div>`);
    this.frame = this.el.querySelector('.set-frame');
    this.nav = this.el.querySelector('.set-nav');
    this.track = this.el.querySelector('.set-track');
    this.main = this.el.querySelector('.set-main');
    this.spring = new Spring(0, (v) => { this.track.style.transform = `translate3d(0,${-v}px,0)`; });
    this.tabs = this.sections.map((s, i) => {
      const tab = el('button', 'set-tab', `${s.icon}${s.label}`);
      tab.addEventListener('click', () => {
        this.region = 'nav';
        this.selectTab(i);
        this.paint();
      });
      this.nav.append(tab);
      return tab;
    });
    this.navGlide = new Glide(this.nav);
    this.main.addEventListener('wheel', (e) => {
      this.spring.to(clamp(this.spring.target + e.deltaY, 0, this.maxScroll()));
    }, { passive: true });
    this.track.addEventListener('pointerleave', () => {
      if (inputMode() === 'mouse') {
        this.region = 'nav';
        this.paint();
      }
    });
    setHints(this.el.querySelector('.set-hints'), [
      { action: 'confirm', label: 'Select' },
      { action: 'back', label: 'Back', mouse: true },
    ], (a) => this.onAction(a));
    layers.push(this);
    this.drawPage();
    this.paint();
  }

  schema() {
    return [
      { label: 'General', icon: icons.gear, items: () => [
        { type: 'choice', key: 'start_tab', label: 'Open on', options: [['home', 'Home'], ['library', 'Library']] },
        { type: 'toggle', key: 'start_fullscreen', label: 'Start in full screen', hint: 'Opens as a console-style screen, ready for a controller.' },
        { type: 'action', label: 'Switch display mode', hint: 'Move between desktop window and full screen. F11 does this too.', value: () => (document.body.classList.contains('fullscreen') ? 'Full screen' : 'Desktop'), run: () => this.app.toggleFullscreen().then(() => this.drawPage()) },
        { type: 'async', load: async () => {
          const displays = await invoke('list_displays').catch(() => []);
          if (displays.length < 2) return [];
          return [{ type: 'select', key: 'display', label: 'Screen', hint: 'Where Vela opens and goes full screen.', options: [
            ['', 'Main screen'],
            ...displays.map((d) => [d.id, d.primary ? `${d.label} (main)` : d.label]),
          ] }];
        } },
        group('Windows'),
        { type: 'toggle', key: 'start_with_windows', label: 'Start with Windows' },
        { type: 'toggle', key: 'start_minimized', label: 'Start hidden in the tray', hint: 'Only when Vela starts with Windows.' },
        group('Clock'),
        { type: 'toggle', key: 'show_clock', label: 'Show the clock', redraw: true },
        ...(store.settings.show_clock ? [
          { type: 'toggle', key: 'show_date', label: 'Show the date' },
          { type: 'toggle', key: 'clock_24h', label: '24-hour clock' },
          { type: 'toggle', key: 'show_seconds', label: 'Show seconds' },
        ] : []),
      ] },
      { label: 'Appearance', icon: icons.display, items: () => [
        // Applied once the slider is let go: everything is sized from this, the slider included.
        { type: 'slider', key: 'ui_scale', label: 'Interface size', min: 0.8, max: 1.3, step: 0.05, format: percent, settle: true },
        { type: 'accent', key: 'accent', label: 'Accent color', hint: 'The first one follows each game’s artwork.' },
        group('Background'),
        { type: 'choice', key: 'background', label: 'Style', options: [['art', 'Artwork'], ['soft', 'Blurred'], ['color', 'Color']] },
        { type: 'slider', key: 'background_level', label: 'Brightness', min: 0.2, max: 1, step: 0.05, format: percent },
        { type: 'toggle', key: 'ambient_motion', label: 'Slow background motion', hint: 'Artwork drifts gently behind the menu.' },
        group('Covers'),
        { type: 'choice', key: 'corners', label: 'Corners', options: [['sharp', 'Sharp'], ['soft', 'Soft'], ['round', 'Round']] },
        { type: 'toggle', key: 'focus_glow', label: 'Glow around the selected game' },
        group('Motion'),
        { type: 'toggle', key: 'reduced_motion', label: 'Reduce animation' },
        { type: 'static', html: () => '<div class="set-gap"></div>' },
        { type: 'action', icon: icons.restart, label: 'Restore the default look', run: () => this.restoreLook() },
      ] },
      { label: 'Home', icon: icons.home, items: () => [
        { type: 'select', key: 'home_order', label: 'Order', options: [
          ['recent', 'Recently played'], ['favorites', 'Favorites first'], ['played', 'Most played'], ['added', 'Recently added'], ['az', 'Name A–Z'],
        ] },
        { type: 'slider', key: 'home_count', label: 'Games in the row', min: 8, max: 48, step: 4, format: (v) => `${v}` },
        { type: 'choice', key: 'home_tile_size', label: 'Cover size', options: TILE_SIZES },
        { type: 'toggle', key: 'home_installed_only', label: 'Only installed games' },
        { type: 'toggle', key: 'home_details', label: 'Show game details', hint: 'Year, developer, genres and rating above the row.' },
        { type: 'toggle', key: 'home_logos', label: 'Use game logos', hint: 'Otherwise the name is written out.' },
      ] },
      { label: 'Library', icon: icons.grid, items: () => this.libraryItems() },
      { label: 'Playing', icon: icons.play, items: () => [
        { type: 'select', key: 'launch_behavior', label: 'When a game starts', options: [
          ['close', 'Close Vela', 'Frees nearly all of Vela’s memory while you play. Vela waits in the tray.'],
          ['minimize', 'Minimize Vela', 'Stays in the taskbar for a quick return, using more memory.'],
          ['keep', 'Keep Vela open', 'Stays on screen behind the game.'],
        ] },
        { type: 'toggle', key: 'restore_on_exit', label: 'Come back when the game closes', hint: 'Otherwise Vela stays in the tray until you open it.' },
        { type: 'toggle', key: 'guide_button', label: 'Xbox button opens Vela during a game', hint: 'Works with Xbox-compatible controllers.' },
      ] },
      { label: 'Sound', icon: icons.sound, items: () => [
        { type: 'toggle', key: 'sound', label: 'Interface sounds', redraw: true },
        ...(store.settings.sound ? [
          { type: 'slider', key: 'volume', label: 'Volume', min: 0, max: 1, step: 0.05, format: percent },
          { type: 'choice', key: 'sound_tone', label: 'Tone', options: [['deep', 'Deep'], ['normal', 'Normal'], ['bright', 'Bright']] },
        ] : []),
      ] },
      { label: 'Controller', icon: icons.pad, items: () => [
        { type: 'select', key: 'glyphs', label: 'Button icons', options: [['auto', 'Match my controller'], ['xbox', 'Xbox'], ['playstation', 'PlayStation']] },
        { type: 'toggle', key: 'swap_ab', label: 'Swap confirm and back', hint: 'Select with the right button, go back with the bottom one.', redraw: true },
        { type: 'choice', key: 'repeat_speed', label: 'Speed when holding a direction', options: [['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']] },
        { type: 'static', html: () => {
          const name = padType() === 'playstation' ? 'PlayStation controller connected' : padType() ? 'Xbox controller connected' : 'No controller detected. Press any button if one is plugged in.';
          return `<div class="set-group">Status</div><div class="map"><div>${icons.pad}${name}</div></div>`;
        } },
        { type: 'static', html: () => {
          const [ok, back] = store.settings.swap_ab ? ['b', 'a'] : ['a', 'b'];
          return `<div class="set-group">Buttons</div><div class="map">
          <div><span class="glyph ${ok}">${ok.toUpperCase()}</span>Select or play</div><div><span class="glyph ${back}">${back.toUpperCase()}</span>Back</div>
          <div><span class="glyph x">X</span>Game details</div><div><span class="glyph y">Y</span>Search</div>
          <div><span class="glyph pill">LB</span><span class="glyph pill">RB</span>Switch tabs</div><div><span class="glyph pill">LT</span><span class="glyph pill">RT</span>Page up and down</div>
          <div><span class="glyph">${icons.menu}</span>Game options</div><div><span class="glyph">${icons.view}</span>Sort the library</div></div>`;
        } },
      ] },
      { label: 'Storage', icon: icons.drive, items: () => this.storageItems() },
      { label: 'Power', icon: icons.power, items: () => [
        { type: 'action', icon: icons.desktop, label: 'Go to desktop', hint: 'Vela stays in the tray.', run: () => invoke('to_desktop') },
        { type: 'action', icon: icons.close, label: 'Quit Vela', run: () => invoke('quit_app') },
        group('This PC'),
        { type: 'action', icon: icons.moon, label: 'Sleep', run: () => this.power('sleep', 'Put this PC to sleep?', 'Sleep') },
        { type: 'action', icon: icons.restart, label: 'Restart', run: () => this.power('restart', 'Restart this PC?', 'Restart') },
        { type: 'action', icon: icons.power, label: 'Shut down', run: () => this.power('shutdown', 'Shut down this PC?', 'Shut down') },
      ] },
      { label: 'About', icon: icons.info, items: () => [
        { type: 'static', html: () => `<div class="about-mark"><img src="assets/icon.png" alt=""><div><b>Vela</b><small>Version ${escapeHtml(this.version ?? '')}</small></div></div>` },
        { type: 'static', html: () => '<div class="set-group">How artwork works</div><div class="map" style="grid-template-columns:1fr"><div>Game titles are sent to the Steam store and the Microsoft Store to find art and details, using your Windows region. Turn off Online artwork in Library to stop this.</div></div>' },
      ] },
    ];
  }

  libraryItems() {
    const folders = store.settings.scan_folders;
    return [
      { type: 'choice', key: 'library_tile_size', label: 'Cover size', options: TILE_SIZES },
      { type: 'toggle', key: 'library_titles', label: 'Always show game names', hint: 'Otherwise a name appears when its game is selected.' },
      group('Games'),
      { type: 'toggle', key: 'show_uninstalled', label: 'Show games that aren’t installed', hint: 'Games you own on any store appear in the Library, ready to install.' },
      { type: 'toggle', key: 'gamepass_on', label: 'Xbox Game Pass', hint: 'Adds your plan’s PC games, ready to install. Needs online artwork and details.', redraw: true },
      ...(store.settings.gamepass_on ? [
        { type: 'choice', key: 'gamepass_plan', label: 'Plan', options: [['ultimate', 'Ultimate'], ['pc', 'PC'], ['premium', 'Premium'], ['essential', 'Essential']] },
      ] : []),
      { type: 'toggle', key: 'online_art', label: 'Online artwork and details', hint: 'Sends game titles to the Steam store and the Microsoft Store, and gets the Game Pass lists.' },
      { type: 'action', icon: icons.refresh, label: 'Rescan for games', run: () => { invoke('rescan'); toast('Scanning for games', 'The library updates as games are found.', icons.refresh); } },
      { type: 'action', icon: icons.plus, label: 'Add a game manually', hint: 'For a game Vela didn’t find. Pick its program file.', run: async () => {
        const title = await invoke('add_game');
        if (title) toast('Added to your library', title, icons.check);
      } },
      group('Collections'),
      ...(store.collections.length
        ? store.collections.map((name) => ({
          type: 'action', icon: icons.stack, label: name,
          value: () => `${store.games.filter((g) => g.collections.includes(name)).length} games`,
          run: () => this.editCollection(name),
        }))
        : [{ type: 'static', html: () => '<div class="map" style="grid-template-columns:1fr"><div>Make one from any game’s options, with Add to a collection.</div></div>' }]),
      group('Extra folders to scan'),
      ...folders.map((folder) => ({ type: 'action', icon: icons.folder, label: folder, value: () => 'Remove', run: () => this.removeFolder(folder) })),
      { type: 'action', icon: icons.plus, label: 'Add a folder', run: () => this.addFolder() },
      group('Hidden games'),
      { type: 'async', load: async () => {
        const hidden = await invoke('hidden_games');
        if (!hidden.length) return [{ type: 'static', html: () => '<div class="map" style="grid-template-columns:1fr"><div>Games you hide appear here.</div></div>' }];
        return hidden.map((g) => ({ type: 'action', icon: storeIcon(g.source), label: g.title, value: () => 'Show again', run: async () => {
          await invoke('set_hidden', { id: g.id, hidden: false });
          toast('Back in your library', g.title, icons.check);
          this.drawPage();
        } }));
      } },
    ];
  }

  storageItems() {
    return [
      { type: 'async', load: async () => {
        const info = await invoke('storage_info');
        const drives = info.drives.map((d) => {
          const used = 1 - d.free / d.total;
          return { type: 'static', html: () => `<div class="drive"><div class="drive-row">${escapeHtml(d.name)}<span>${fmtBytes(d.free)} free of ${fmtBytes(d.total)}</span></div><div class="drive-bar"><i class="${used > 0.92 ? 'low' : ''}" style="width:${used * 100}%"></i></div></div>` };
        });
        return [...drives, group('Vela'), {
          type: 'action', icon: icons.image, label: 'Clear artwork cache', hint: 'Images download again when needed.', value: () => fmtBytes(info.cache) || '0 B', run: async () => {
            const freed = await invoke('clear_art_cache');
            toast('Artwork cache cleared', `${fmtBytes(freed) || '0 B'} freed`, icons.check);
            this.drawPage();
          },
        }];
      } },
    ];
  }

  editCollection(name) {
    new Sheet({ title: name, sub: 'Collection', items: [
      { label: 'Rename', icon: icons.tag, run: async () => {
        const to = await promptDialog({ title: 'Rename collection', value: name });
        if (!to?.trim() || to.trim() === name) return;
        try {
          await invoke('rename_collection', { name, to });
        } catch (e) {
          toast('That didn’t work', String(e));
        }
        setTimeout(() => this.drawPage(), 300);
      } },
      { label: 'Delete', icon: icons.trash, danger: true, run: async () => {
        if (!(await confirmDialog({ title: `Delete ${name}?`, body: 'The games stay in your library. Only the collection goes.', yes: 'Delete', danger: true }))) return;
        await invoke('delete_collection', { name });
        toast('Collection deleted', name, icons.trash);
        setTimeout(() => this.drawPage(), 300);
      } },
    ] });
  }

  async power(action, title, yes) {
    if (await confirmDialog({ title, body: 'Save anything open in other apps first.', yes })) {
      try {
        await invoke('power', { action });
      } catch (e) {
        toast('That didn’t work', String(e));
      }
    }
  }

  async restoreLook() {
    if (!(await confirmDialog({ title: 'Restore the default look?', body: 'Size, colors, background and covers go back to how Vela started.', yes: 'Restore' }))) return;
    this.pending = null;
    saveSettings(DEFAULT_LOOK);
    this.app.applySettings();
    this.drawPage();
  }

  async addFolder() {
    const folder = await invoke('pick_folder');
    if (!folder || store.settings.scan_folders.includes(folder)) return;
    await saveSettings({ scan_folders: [...store.settings.scan_folders, folder] });
    toast('Folder added', 'Scanning it for games now.', icons.folder);
    this.drawPage();
  }

  async removeFolder(folder) {
    await saveSettings({ scan_folders: store.settings.scan_folders.filter((f) => f !== folder) });
    this.drawPage();
  }

  async drawPage(animate = false) {
    const section = this.sections[this.tab];
    const token = (this.pageToken = {});
    let items = section.items();
    const expanded = [];
    for (const item of items) {
      if (item.type === 'async') expanded.push(...(await item.load()));
      else expanded.push(item);
    }
    if (token !== this.pageToken) return;
    this.version ??= await invoke('app_version');
    this.items = expanded;
    this.track.classList.remove('swap-page');
    if (animate) {
      void this.track.offsetWidth;
      this.track.classList.add('swap-page');
    }
    this.track.innerHTML = `<h2>${section.label}</h2>`;
    this.itemGlide = new Glide(this.track);
    this.rows = [];
    for (const item of expanded) {
      if (item.type === 'static') {
        const box = el('div');
        box.innerHTML = item.html();
        this.track.append(...box.childNodes);
        continue;
      }
      const row = this.drawItem(item);
      if (item.type === 'slider') this.bindSlider(row, item);
      const index = this.rows.length;
      row.addEventListener('pointermove', () => {
        if (inputMode() === 'mouse' && (this.region !== 'items' || this.item !== index)) {
          this.region = 'items';
          this.item = index;
          this.paint();
        }
      });
      row.addEventListener('click', (e) => {
        this.region = 'items';
        this.item = index;
        this.paint();
        this.activate(e);
      });
      this.rows.push({ node: row, item });
      this.track.append(row);
    }
    this.item = clamp(this.item, 0, Math.max(this.rows.length - 1, 0));
    // A redraw in place keeps your spot; only a new page starts at the top.
    if (animate) this.spring.jump(0);
    this.paint();
  }

  bindSlider(row, item) {
    const read = (e) => {
      const box = row.querySelector('.slider').getBoundingClientRect();
      const ratio = clamp((e.clientX - box.left) / box.width, 0, 1);
      const steps = Math.round((ratio * (item.max - item.min)) / item.step);
      return [Math.round((item.min + steps * item.step) * 100) / 100, ratio];
    };
    const drag = (e) => {
      const [value, ratio] = read(e);
      // The knob stays exactly under the pointer; the value moves in steps.
      this.paintSlider(row, item, value, ratio);
      if (item.settle) this.pending = { item, value };
      else if (value !== store.settings[item.key]) this.change(item, value);
    };
    const release = () => {
      row.classList.remove('dragging');
      row.removeEventListener('pointermove', drag);
      this.paintSlider(row, item, this.valueOf(item));
      this.commit();
    };
    row.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.slider')) return;
      row.setPointerCapture(e.pointerId);
      row.classList.add('dragging');
      row.addEventListener('pointermove', drag);
      drag(e);
    });
    row.addEventListener('pointerup', release);
    row.addEventListener('pointercancel', release);
  }

  /** A setting's value, counting one that's waiting to be applied. */
  valueOf(item) {
    return this.pending?.item === item ? this.pending.value : store.settings[item.key];
  }

  paintSlider(row, item, value, ratio = (value - item.min) / (item.max - item.min)) {
    row.querySelector('.slider i').style.transform = `scaleX(${ratio})`;
    row.querySelector('.slider u').style.left = `${ratio * 100}%`;
    row.querySelector('.num').textContent = item.format(value);
  }

  /** Applies a setting that was held back while the slider moved. */
  commit() {
    clearTimeout(this.commitTimer);
    const held = this.pending;
    this.pending = null;
    if (!held || held.value === store.settings[held.item.key]) return;
    const before = rem();
    this.change(held.item, held.value);
    const ratio = before / rem();
    this.spring.jump(clamp(this.spring.value / ratio, 0, this.maxScroll()));
    this.paint();
    // Starts at the old size and eases to the new one, so nothing jumps.
    if (!store.settings.reduced_motion) {
      this.frame.animate([{ transform: `scale(${ratio})` }, { transform: 'none' }], { duration: 360, easing: 'cubic-bezier(.22,.8,.3,1)' });
    }
  }

  drawItem(item) {
    const row = el('button', 'item');
    const text = `<div class="txt"><b>${escapeHtml(item.label)}</b>${this.hintFor(item) ? `<small>${escapeHtml(this.hintFor(item))}</small>` : ''}</div>`;
    const icon = item.icon ?? '';
    if (item.type === 'toggle') {
      row.innerHTML = `${text}<span class="switch${store.settings[item.key] ? ' on' : ''}"><i></i></span>`;
    } else if (item.type === 'select') {
      const option = item.options.find(([v]) => v === store.settings[item.key]) ?? item.options[0];
      row.innerHTML = `${text}<span class="val">${escapeHtml(option[1])}${icons.chevron}</span>`;
    } else if (item.type === 'slider') {
      row.innerHTML = `${text}${this.sliderHtml(item)}`;
    } else if (item.type === 'accent') {
      const current = store.settings.accent;
      const swatches = ACCENTS.map(([value, color]) => `<span class="swatch${value === current ? ' on' : ''}" data-value="${value}" style="background:${color}"></span>`).join('');
      row.innerHTML = `${text}<span class="swatches">${swatches}</span>`;
    } else if (item.type === 'choice') {
      const current = store.settings[item.key];
      const options = item.options.map(([value, label]) => `<span class="opt${value === current ? ' on' : ''}" data-value="${value}">${escapeHtml(label)}</span>`).join('');
      const index = Math.max(0, item.options.findIndex(([value]) => value === current));
      row.innerHTML = `${text}<span class="choice" style="--n:${item.options.length};--i:${index}"><i></i>${options}</span>`;
    } else {
      row.innerHTML = `${icon}${text}<span class="val">${item.value ? escapeHtml(item.value()) : ''}${icons.chevron}</span>`;
    }
    return row;
  }

  hintFor(item) {
    if (item.type === 'select') return (item.options.find(([v]) => v === store.settings[item.key]) ?? [])[2] ?? item.hint;
    return item.hint;
  }

  sliderHtml(item) {
    const value = store.settings[item.key];
    const ratio = (value - item.min) / (item.max - item.min);
    return `<span class="val"><span class="slider"><i style="transform:scaleX(${ratio})"></i><u style="left:${ratio * 100}%"></u></span><span class="num">${item.format(value)}</span></span>`;
  }

  paint() {
    this.tabs.forEach((tab, i) => {
      tab.classList.toggle('on', i === this.tab);
      tab.classList.toggle('focused', this.region === 'nav' && i === this.tab);
    });
    this.nav.classList.toggle('lit', this.region === 'nav');
    this.navGlide.to(this.tabs[this.tab]);
    this.rows?.forEach(({ node }, i) => node.classList.toggle('focused', this.region === 'items' && i === this.item));
    this.itemGlide?.to(this.region === 'items' ? this.rows?.[this.item]?.node : null);
    if (this.region === 'items') this.reveal();
  }

  maxScroll() {
    return Math.max(0, this.track.offsetHeight - this.main.clientHeight);
  }

  reveal() {
    const node = this.rows?.[this.item]?.node;
    // The mouse reaches what it can see. Following it would pull the page out from under it.
    if (!node || inputMode() === 'mouse') return;
    this.spring.to(clamp(node.offsetTop - this.main.clientHeight * 0.34, 0, this.maxScroll()));
  }

  selectTab(index) {
    if (index === this.tab) return;
    this.commit();
    play('move');
    this.tab = index;
    this.item = 0;
    this.paint();
    this.drawPage(true);
  }

  async change(item, value) {
    const saved = saveSettings({ [item.key]: value });
    this.app.applySettings();
    const node = this.rows.find((r) => r.item === item)?.node;
    if (item.redraw) this.drawPage();
    else if (node) this.show(node, item, value);
    await saved;
  }

  /** Updates a row in place, so switches and sliders glide instead of jumping. */
  show(node, item, value) {
    if (item.type === 'toggle') {
      node.querySelector('.switch').classList.toggle('on', value);
    } else if (item.type === 'slider') {
      this.paintSlider(node, item, value);
    } else if (item.type === 'choice' || item.type === 'accent') {
      const marks = [...node.querySelectorAll('[data-value]')];
      marks.forEach((mark) => mark.classList.toggle('on', mark.dataset.value === value));
      node.querySelector('.choice')?.style.setProperty('--i', marks.findIndex((mark) => mark.dataset.value === value));
    } else {
      node.innerHTML = this.drawItem(item).innerHTML;
    }
  }

  /** The values of a row picked from side to side. */
  valuesOf(item) {
    if (item.type === 'accent') return ACCENTS.map(([value]) => value);
    return item.type === 'choice' ? item.options.map(([value]) => value) : null;
  }

  activate(e) {
    const entry = this.rows?.[this.item];
    if (!entry) return;
    const { item } = entry;
    switch (item.type) {
      case 'toggle':
        play('toggle');
        this.change(item, !store.settings[item.key]);
        break;
      case 'select':
        this.openSelect(item);
        break;
      case 'choice':
      case 'accent': {
        const values = this.valuesOf(item);
        const next = values[(values.indexOf(store.settings[item.key]) + 1) % values.length];
        const value = e?.target.closest('[data-value]')?.dataset.value ?? next;
        if (value !== store.settings[item.key]) {
          play('toggle');
          this.change(item, value);
        }
        break;
      }
      case 'action':
        play('select');
        item.run();
        break;
      default:
        break;
    }
  }

  openSelect(item) {
    play('select');
    new Sheet({
      title: item.label,
      items: item.options.map(([value, label]) => ({ value, label, run: () => this.change(item, value).then(() => this.drawPage()) })),
      selected: store.settings[item.key],
    });
  }

  adjust(direction) {
    const item = this.rows?.[this.item]?.item;
    const values = item && this.valuesOf(item);
    if (values) {
      const value = values[clamp(values.indexOf(store.settings[item.key]) + direction, 0, values.length - 1)];
      if (value !== store.settings[item.key]) {
        play('toggle');
        this.change(item, value);
      }
      return true;
    }
    if (item?.type !== 'slider') return false;
    const current = this.valueOf(item);
    const value = clamp(Math.round((current + direction * item.step) * 100) / 100, item.min, item.max);
    if (value === current) return true;
    play('toggle');
    if (item.settle) {
      this.pending = { item, value };
      this.paintSlider(this.rows[this.item].node, item, value);
      clearTimeout(this.commitTimer);
      this.commitTimer = setTimeout(() => this.commit(), 420);
    } else {
      this.change(item, value);
    }
    return true;
  }

  close() {
    this.commit();
    layers.remove(this);
    closeWith(this.el);
  }

  onAction(action) {
    if (this.region === 'nav') {
      switch (action) {
        case 'up': if (this.tab > 0) this.selectTab(this.tab - 1); break;
        case 'down': if (this.tab < this.sections.length - 1) this.selectTab(this.tab + 1); break;
        case 'right': case 'confirm':
          if (this.rows?.length) {
            play('move');
            this.region = 'items';
            this.paint();
          }
          break;
        case 'back': play('back'); this.close(); break;
        default: break;
      }
      return true;
    }
    switch (action) {
      case 'up':
        if (this.item > 0) { play('move'); this.item -= 1; this.paint(); }
        break;
      case 'down':
        if (this.item < this.rows.length - 1) { play('move'); this.item += 1; this.paint(); }
        break;
      case 'left':
        if (!this.adjust(-1)) { play('move'); this.region = 'nav'; this.spring.to(0); this.paint(); }
        break;
      case 'right': this.adjust(1); break;
      case 'confirm': this.activate(); break;
      case 'back': play('back'); this.region = 'nav'; this.spring.to(0); this.paint(); break;
      default: break;
    }
    return true;
  }
}
