import { fmtPlaytime, GAME_PASS_PLANS, HOME_TILE_REM, invoke, LIBRARY_TILE_REM, listen, rem, setThumbWidth, Spring, STORE_NAMES, tileSize } from './core.js';
import { GamePage } from './game.js';
import { Home } from './home.js';
import { icons, storeIcon } from './icons.js';
import { configureInput, startInput } from './input.js';
import { Library } from './library.js';
import { confirmDialog, LaunchScreen, promptDialog, Sheet } from './overlays.js';
import { BigPicture } from './bigpicture.js';
import { Search } from './search.js';
import { Settings } from './settings.js';
import { Stats } from './stats.js';
import { configureSound, play } from './sound.js';
import { loadUi, onGamePassFound, onLibrary, refreshLibrary, saveSettings, saveUi, scheduleRefresh, store } from './state.js';
import { backdrop, FocusList, layers, redrawHints, toast } from './ui.js';

/** How much a tile grows when it's selected. */
const FOCUS_SCALE = 1.085;
/** Sizes snap to this step, so a small resize doesn't reload every cover. */
const THUMB_STEP = 40;
const CORNERS = { sharp: '.28rem', soft: '.95rem', round: '1.7rem' };
const TABS = ['home', 'library', 'stats'];

class App {
  constructor() {
    this.tab = 'home';
    this.scope = 'view';
    this.launchScreen = null;
  }

  /* Top bar ------------------------------------------------------------- */

  buildTopbar() {
    const bar = document.getElementById('topbar');
    bar.innerHTML = `
      <div class="bp-brand"><img src="assets/icon.png" alt=""><b>Vela</b></div>
      <div class="tabs">
        <button class="tab" data-tab="home">${icons.home}<span>Home</span></button>
        <button class="tab" data-tab="library">${icons.grid}<span>Library</span></button>
        <button class="tab" data-tab="stats">${icons.chart}<span>Statistics</span></button>
        <span class="tab-pill"></span>
      </div>
      <div class="top-space" data-tauri-drag-region></div>
      <div class="top-right">
        <span class="now-playing"><i></i><span></span></span>
        <button class="icon-btn" data-do="search" title="Search">${icons.search}</button>
        <button class="icon-btn" data-do="settings" title="Settings">${icons.gear}</button>
        <button class="icon-btn" data-do="fullscreen" title="Full screen"><span class="enter">${icons.fullscreen}</span><span class="leave">${icons.exit}</span></button>
        <span class="pad-dot">${icons.pad}</span>
        <div class="clock"><b></b><span></span></div>
        <div class="win-ctl">
          <button data-win="min" title="Minimize">${icons.minimize}</button>
          <button data-win="max" title="Maximize">${icons.maximize}</button>
          <button class="close" data-win="close" title="Close">${icons.close}</button>
        </div>
      </div>`;
    this.bar = bar;
    this.pill = bar.querySelector('.tab-pill');
    this.tabButtons = [...bar.querySelectorAll('.tab')];
    this.topItems = [...this.tabButtons, ...bar.querySelectorAll('.icon-btn')];
    this.top = new FocusList(this.topItems);
    this.top.active = false;
    bar.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      const act = e.target.closest('[data-do]');
      const win = e.target.closest('[data-win]');
      if (tab) this.setTab(tab.dataset.tab);
      else if (act) this.topAction(act.dataset.do);
      else if (win) this.windowAction(win.dataset.win);
    });
    new ResizeObserver(() => this.movePill()).observe(bar);
    this.tick();
  }

  tick() {
    const now = new Date();
    const { clock_24h: h24, show_seconds: seconds } = store.settings;
    this.bar.querySelector('.clock b').textContent = now.toLocaleTimeString(undefined, {
      hour: h24 ? '2-digit' : 'numeric', minute: '2-digit', second: seconds ? '2-digit' : undefined, hour12: !h24,
    });
    this.bar.querySelector('.clock span').textContent = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    clearTimeout(this.clockTimer);
    const wait = seconds ? 1000 - now.getMilliseconds() : 60000 - now.getSeconds() * 1000 - now.getMilliseconds();
    this.clockTimer = setTimeout(() => this.tick(), wait + 8);
  }

  movePill() {
    const button = this.tabButtons.find((b) => b.dataset.tab === this.tab);
    if (!button) return;
    this.pill.style.width = `${button.offsetWidth}px`;
    this.pill.style.transform = `translate3d(${button.offsetLeft}px,0,0)`;
  }

  topAction(what) {
    if (what === 'search') this.openSearch();
    else if (what === 'settings') this.openSettings();
    else if (what === 'fullscreen') this.toggleFullscreen();
  }

  windowAction(what) {
    if (what === 'min') invoke('minimize_window');
    else if (what === 'max') invoke('toggle_maximize');
    else if (what === 'close') invoke('quit_app');
  }

  focusTop() {
    play('move');
    this.scope = 'top';
    this.view.setActive(false);
    this.bar.classList.add('nav-focus');
    this.top.setActive(true);
    this.top.focus(this.tabButtons.findIndex((b) => b.dataset.tab === this.tab));
  }

  focusView() {
    if (this.scope === 'view') return;
    this.scope = 'view';
    this.bar.classList.remove('nav-focus');
    this.top.setActive(false);
    this.view.setActive(true);
  }

  topInput(action) {
    const { top } = this;
    switch (action) {
      case 'left': if (top.index > 0) { play('move'); top.focus(top.index - 1); } break;
      case 'right': if (top.index < top.items.length - 1) { play('move'); top.focus(top.index + 1); } break;
      case 'down': play('move'); this.focusView(); break;
      case 'back': play('back'); this.focusView(); break;
      case 'confirm': {
        const item = top.current;
        if (item.dataset.tab) {
          this.setTab(item.dataset.tab);
          this.focusView();
        } else {
          play('select');
          this.topAction(item.dataset.do);
        }
        break;
      }
      default: return false;
    }
    return true;
  }

  /* Views --------------------------------------------------------------- */

  get view() {
    return { home: this.home, library: this.library, stats: this.stats }[this.tab];
  }

  setTab(tab) {
    // Library again switches between all games and the shelves.
    if (tab === this.tab) {
      if (tab === 'library') this.library.toggleMode();
      return;
    }
    play('tab');
    const outgoing = this.view;
    const toRight = TABS.indexOf(tab) > TABS.indexOf(this.tab);
    outgoing.setActive(false);
    outgoing.root.classList.remove('active');
    outgoing.root.classList.toggle('left', toRight);
    outgoing.root.classList.toggle('right', !toRight);
    this.tab = tab;
    document.body.dataset.tab = tab;
    const incoming = this.view;
    incoming.root.classList.remove('left', 'right');
    incoming.root.classList.add('active');
    this.tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    this.movePill();
    if (this.scope === 'view') incoming.setActive(true);
    else this.top.focus(this.tabButtons.findIndex((b) => b.dataset.tab === tab));
    if (tab === 'library') this.library.apply();
  }

  /* Game actions -------------------------------------------------------- */

  primary(game) {
    return game.installed ? this.launch(game) : this.install(game);
  }

  openGame(game, origin) {
    play('select');
    new GamePage(this, game, origin);
  }

  openSearch() {
    if (layers.stack.some((l) => l instanceof Search)) return;
    play('select');
    new Search(this);
  }

  openSettings() {
    new Settings(this);
  }

  openPicker(title, items, selected, onPick) {
    play('select');
    new Sheet({ title, selected, items: items.map((i) => ({ ...i, run: () => onPick(i.value) })) });
  }

  openMenu(game, { fromPage } = {}) {
    play('select');
    const items = [];
    if (game.installed) items.push({ label: 'Play', icon: icons.play, run: () => this.launch(game) });
    else if (game.has_install) items.push({ label: 'Install', icon: icons.download, run: () => this.install(game) });
    if (!fromPage) items.push({ label: 'View details', icon: icons.info, run: () => this.openGame(game) });
    items.push({
      label: game.favorite ? 'Remove from favorites' : 'Add to favorites',
      icon: game.favorite ? icons.heartFill : icons.heart,
      run: () => invoke('set_favorite', { id: game.id, favorite: !game.favorite }),
    });
    if (game.installed) {
      items.push({ label: 'Open game folder', icon: icons.folder, run: () => this.guarded('open_game_folder', game) });
    }
    items.push({ label: game.collections.length ? 'Collections' : 'Add to a collection', icon: icons.stack, run: () => this.openCollections(game) });
    items.push({ label: 'Customize', icon: icons.image, run: () => this.openCustomize(game) });
    items.push({
      label: 'Hide from library',
      icon: icons.hide,
      run: async () => {
        await invoke('set_hidden', { id: game.id, hidden: true });
        toast('Hidden from your library', 'Bring it back from Settings, Library.', icons.hide);
        fromPage?.close();
      },
    });
    if (game.can_uninstall) {
      items.push({ label: 'Uninstall', icon: icons.trash, danger: true, run: () => this.uninstall(game) });
    }
    new Sheet({ title: game.title, sub: STORE_NAMES[game.source], items });
  }

  openCustomize(game) {
    play('select');
    const pick = (kind) => async () => {
      try {
        if (await invoke('pick_game_art', { id: game.id, kind })) toast('Artwork updated', game.title, icons.image);
      } catch (e) {
        play('error');
        toast('That didn’t work', String(e));
      }
    };
    const items = [
      { label: 'Rename', icon: icons.tag, run: () => this.renameGame(game) },
      { label: 'Change cover', icon: icons.image, run: pick('cover') },
      { label: 'Change background', icon: icons.image, run: pick('hero') },
      { label: 'Change logo', icon: icons.image, run: pick('logo') },
      {
        label: 'Refresh artwork',
        icon: icons.refresh,
        run: async () => {
          await invoke('refresh_art', { id: game.id });
          toast('Refreshing artwork', game.title, icons.image);
        },
      },
    ];
    if (game.customized) {
      items.push({
        label: 'Back to the original',
        icon: icons.restart,
        run: async () => {
          await invoke('reset_game_look', { id: game.id });
          toast('Back to the original', null, icons.check);
        },
      });
    }
    new Sheet({ title: 'Customize', sub: game.title, items });
  }

  /** Which of the user's collections hold this game, with a way to start a new one. */
  openCollections(game) {
    play('select');
    const items = store.collections.map((name) => ({
      label: name,
      value: name,
      icon: icons.stack,
      run: async () => {
        const member = !game.collections.includes(name);
        await invoke('set_in_collection', { id: game.id, name, member });
        toast(member ? `Added to ${name}` : `Removed from ${name}`, game.title, icons.stack);
      },
    }));
    items.push({ label: 'New collection', icon: icons.plus, run: () => this.newCollection(game) });
    const sheet = new Sheet({ title: 'Collections', sub: game.title, items });
    // Every collection the game is in carries a tick, not just one.
    sheet.items.forEach((item, i) => {
      if (item.value !== undefined) sheet.list.items[i].classList.toggle('selected', game.collections.includes(item.value));
    });
  }

  async newCollection(game) {
    const name = await promptDialog({ title: 'New collection', placeholder: 'Co-op nights', yes: 'Create' });
    if (!name?.trim()) return;
    try {
      await invoke('set_in_collection', { id: game.id, name, member: true });
      toast(`Added to ${name.trim()}`, 'Find it in the Library, under Collections.', icons.stack);
    } catch (e) {
      play('error');
      toast('That didn’t work', String(e));
    }
  }

  async uninstall(game) {
    const xbox = game.variants.some((v) => v.installed && v.source === 'xbox') && game.source === 'xbox';
    const ok = await confirmDialog({
      title: `Uninstall ${game.title}?`,
      body: xbox
        ? 'Vela removes it from this PC now, the way Windows Settings does. Your saves stay in the cloud if the game syncs them.'
        : `This opens ${STORE_NAMES[game.source] ?? 'its uninstaller'} to remove it.`,
      yes: xbox ? 'Uninstall' : 'Continue',
      danger: true,
    });
    if (!ok) return;
    if (xbox) toast(`Uninstalling ${game.title}`, 'This can take a minute.', icons.trash);
    try {
      const gone = await invoke('uninstall_game', { id: game.id });
      if (gone) toast(`${game.title} was uninstalled`, null, icons.check);
    } catch (e) {
      play('error');
      toast('That didn’t work', String(e));
    }
  }

  async renameGame(game) {
    const title = await promptDialog({ title: 'Rename game', value: game.title, placeholder: 'Leave empty for the original name' });
    if (title !== null) await invoke('rename_game', { id: game.id, title });
  }

  async guarded(command, game) {
    try {
      await invoke(command, { id: game.id });
    } catch (e) {
      play('error');
      toast('That didn’t work', String(e));
    }
  }

  async install(game) {
    if (!game.has_install) {
      play('error');
      return toast('Install this from its store', STORE_NAMES[game.source]);
    }
    play('select');
    await this.guarded('install_game', game);
    toast(`Opening ${STORE_NAMES[game.source] ?? 'the store'}`, `Install ${game.title} there. It will appear here when it’s ready.`, storeIcon(game.source));
  }

  async launch(game) {
    if (this.launchScreen) return;
    play('launch');
    // The interface may be closed while the game runs; this is where to come back to.
    saveUi({ focus: game.id, tab: this.tab });
    this.launchScreen = new LaunchScreen(game, null, () => {
      this.launchScreen = null;
      invoke('cancel_launch');
    });
    try {
      await invoke('launch_game', { id: game.id });
    } catch (e) {
      this.endLaunch();
      play('error');
      toast(`${game.title} didn’t start`, String(e));
    }
  }

  endLaunch() {
    this.launchScreen?.close();
    this.launchScreen = null;
  }

  /* Display ------------------------------------------------------------- */

  toggleFullscreen() {
    return this.bigPicture.toggle();
  }

  /** In full screen, Back on Home opens a console-style menu instead of doing nothing. */
  openQuickMenu() {
    play('select');
    const confirmPower = (action, title, yes) => async () => {
      if (await confirmDialog({ title, body: 'Save anything open in other apps first.', yes })) invoke('power', { action }).catch((e) => toast('That didn’t work', String(e)));
    };
    new Sheet({
      title: 'Vela',
      sub: new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
      items: [
        { label: 'Leave full screen', icon: icons.exit, run: () => this.toggleFullscreen() },
        { label: 'Settings', icon: icons.gear, run: () => this.openSettings() },
        { label: 'Go to desktop', icon: icons.desktop, run: () => invoke('to_desktop') },
        { label: 'Sleep', icon: icons.moon, run: confirmPower('sleep', 'Put this PC to sleep?', 'Sleep') },
        { label: 'Restart', icon: icons.restart, run: confirmPower('restart', 'Restart this PC?', 'Restart') },
        { label: 'Shut down', icon: icons.power, run: confirmPower('shutdown', 'Shut down this PC?', 'Shut down') },
        { label: 'Quit Vela', icon: icons.close, run: () => invoke('quit_app') },
      ],
    });
  }

  applySettings() {
    const s = store.settings;
    const root = document.documentElement;
    // Full screen is played from further away, so everything grows a little.
    root.style.setProperty('--ui-scale', s.ui_scale * (document.body.classList.contains('fullscreen') ? 1.06 : 1));
    root.style.setProperty('--tile-radius', CORNERS[s.corners] ?? CORNERS.soft);
    root.style.setProperty('--bd-level', s.background_level);
    root.classList.toggle('reduced', s.reduced_motion);
    root.classList.toggle('motion', s.ambient_motion && !s.reduced_motion);
    root.classList.toggle('no-glow', !s.focus_glow);
    root.classList.toggle('plain-home', !s.home_details);
    root.classList.toggle('no-clock', !s.show_clock);
    root.classList.toggle('no-date', !s.show_date);
    if (s.accent !== 'auto') root.style.setProperty('--accent', s.accent);
    else backdrop.retint();
    backdrop.setStyle(s.background);
    Spring.prototype.reduced = s.reduced_motion;
    configureSound({ sound: s.sound, volume: s.volume, tone: s.sound_tone });
    configureInput({ swap: s.swap_ab, repeat: s.repeat_speed });
    this.tick();
    redrawHints();
    this.library?.applyLook();
    this.fitArtwork();
    // Only when the row's contents change: this runs on every step of a slider.
    const row = [s.home_order, s.home_count, s.home_installed_only, s.home_logos].join();
    if (this.home && this.homeRow !== undefined && row !== this.homeRow) this.home.update();
    this.homeRow = row;
  }

  /** Lays tiles out for the current interface size, and asks for art to match. */
  fitArtwork() {
    const { home_tile_size: home, library_tile_size: library } = store.settings;
    const largest = Math.max(HOME_TILE_REM * tileSize(home), LIBRARY_TILE_REM * tileSize(library)) * FOCUS_SCALE;
    const changed = setThumbWidth(Math.ceil((rem() * largest * devicePixelRatio) / THUMB_STEP) * THUMB_STEP);
    if (!this.home) return;
    this.home.measure();
    this.library.grid.layout();
    if (changed) {
      this.home.update();
      this.library.update();
      for (const layer of layers.stack) layer.refresh?.();
    }
  }

  /** Nothing goes online until this has been answered. */
  async askAboutArtwork() {
    const online = await confirmDialog({
      title: 'Get artwork from online stores?',
      body: 'Vela sends your game titles to the Steam store and the Microsoft Store to find covers and details. Without this, games appear with simple posters. You can change this any time in Settings, Library.',
      yes: 'Turn on',
      no: 'Not now',
    });
    await saveSettings({ online_art: online, online_art_asked: true });
  }

  /** Only for someone with a Game Pass game on this PC; everyone else starts without it. */
  async askAboutGamePass() {
    if (this.askedGamePass || store.session || document.querySelector('.dialog-wrap')) return;
    this.askedGamePass = true;
    const member = await confirmDialog({
      title: 'Do you have Xbox Game Pass?',
      body: 'Vela found a Game Pass game on this PC. If you subscribe, your plan’s PC games can appear in your Library, ready to install. You can change this any time in Settings, Library.',
      yes: 'Yes',
      no: 'No',
    });
    const plan = member ? await new Promise((resolve) => new Sheet({
      title: 'Which plan do you have?',
      sub: 'Vela shows only the PC games it includes.',
      items: GAME_PASS_PLANS.map(([value, label]) => ({ label, run: () => resolve(value) })),
      onDismiss: () => resolve(null),
    })) : null;
    await saveSettings({ gamepass_on: !!plan, gamepass_plan: plan ?? store.settings.gamepass_plan, gamepass_asked: true });
    // An open Settings shows the answer straight away.
    for (const layer of layers.stack) if (layer instanceof Settings) layer.drawPage();
  }

  showSession(session) {
    store.session = session;
    const pill = this.bar.querySelector('.now-playing');
    pill.classList.toggle('on', !!session);
    if (session) pill.querySelector('span').textContent = session.title;
  }

  /* Input ---------------------------------------------------------------- */

  onAction(action, { repeat }) {
    if (action === 'fullscreen') {
      if (!repeat) this.toggleFullscreen();
      return;
    }
    const layer = layers.top();
    if (layer) {
      layer.onAction(action);
      return;
    }
    if (!repeat && (action === 'lb' || action === 'rb')) {
      const next = TABS.indexOf(this.tab) + (action === 'rb' ? 1 : -1);
      this.setTab(TABS[(next + TABS.length) % TABS.length]);
      return;
    }
    if (this.scope === 'top') {
      this.topInput(action);
      return;
    }
    if (action === 'back') {
      if (this.tab !== 'home') this.setTab('home');
      else if (document.body.classList.contains('fullscreen')) this.openQuickMenu();
      return;
    }
    this.view.onAction(action);
  }

  /* Startup -------------------------------------------------------------- */

  async start() {
    store.settings = await invoke('get_settings');
    this.buildTopbar();
    const views = document.getElementById('views');
    this.home = new Home(this);
    this.library = new Library(this);
    this.stats = new Stats(this);
    views.append(this.home.root, this.library.root, this.stats.root);
    this.bigPicture = new BigPicture(this);

    document.body.classList.add('intro');
    const fullscreen = await invoke('is_fullscreen');
    document.body.classList.toggle('fullscreen', fullscreen);
    this.applySettings();
    if (fullscreen) this.bigPicture.arrive();

    const saved = loadUi();
    await refreshLibrary();
    this.home.update();
    this.library.update();
    if (saved.focus) {
      const index = this.home.games.findIndex((g) => g.id === saved.focus);
      if (index >= 0) this.home.focus(index, { silent: true });
    }
    saveUi({ focus: null, tab: null });
    this.tab = 'home';
    this.home.root.classList.add('active');
    document.body.dataset.tab = 'home';
    this.tabButtons[0].classList.add('active');
    this.movePill();
    this.home.setActive(true);
    if (saved.focus ? saved.tab === 'library' : store.settings.start_tab === 'library') {
      this.setTab('library');
    }

    onLibrary(() => {
      this.home.update();
      this.library.update();
      this.stats.update();
      for (const layer of layers.stack) layer.refresh?.();
    });

    startInput({
      action: (action, info) => this.onAction(action, info),
      mode: () => redrawHints(),
      pad: (connected) => {
        this.bar.querySelector('.pad-dot').classList.toggle('on', connected);
        toast(connected ? 'Controller connected' : 'Controller disconnected', null, icons.pad);
        redrawHints();
      },
    });

    listen('library-updated', scheduleRefresh);
    listen('scan-state', (scanning) => { store.scanning = scanning; });
    listen('library-changed', ({ added, removed }) => {
      if (added.length) toast(added.length === 1 ? `${added[0]} is ready to play` : `${added.length} new games`, null, icons.sparkle);
      if (removed.length) toast(removed.length === 1 ? `${removed[0]} was removed` : `${removed.length} games were removed`, null, icons.trash);
    });
    listen('session-started', () => {
      this.endLaunch();
      invoke('current_session').then((s) => this.showSession(s));
    });
    listen('session-ended', (done) => this.onSessionEnd(done));

    window.addEventListener('focus', () => scheduleRefresh());
    let resizing = 0;
    window.addEventListener('resize', () => {
      // After the window settles, so a drag doesn't ask for every size on the way.
      clearTimeout(resizing);
      resizing = setTimeout(() => this.fitArtwork(), 220);
    });

    const finished = await invoke('take_last_session');
    if (finished) this.onSessionEnd(finished);
    this.showSession(await invoke('current_session'));

    // Two frames means the first paint is done. A hidden window may never draw a
    // frame, so a timer guarantees the window still appears.
    let shown = false;
    const reveal = () => {
      if (!shown) invoke('ui_ready');
      shown = true;
    };
    requestAnimationFrame(() => requestAnimationFrame(reveal));
    setTimeout(reveal, 350);
    setTimeout(() => document.body.classList.remove('intro'), 1800);
    if (!store.settings.online_art_asked) this.askAboutArtwork();
    onGamePassFound(() => this.askAboutGamePass());
    if (store.askGamePass) this.askAboutGamePass();
  }

  onSessionEnd(done) {
    this.endLaunch();
    this.showSession(null);
    invoke('take_last_session');
    if (done.detected && done.seconds >= 60) toast(`Played ${done.title}`, fmtPlaytime(Math.round(done.seconds / 60)), icons.play);
    else if (!done.detected) toast(`${done.title} didn’t appear to start`, 'It may still be opening in its store.');
    scheduleRefresh();
  }
}

new App().start().catch((e) => {
  console.error(e);
  invoke('ui_ready');
});
