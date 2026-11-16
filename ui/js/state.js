// The app's shared data and small persistent UI memory.

import { invoke } from './core.js';

export const store = {
  games: [],
  byId: new Map(),
  settings: null,
  scanning: false,
  askGamePass: false,
  collections: [],
  session: null,
};

const listeners = new Set();
export const onLibrary = (fn) => listeners.add(fn);

let gamePassFound = null;
export const onGamePassFound = (fn) => { gamePassFound = fn; };

let signature = '';

export async function refreshLibrary() {
  const data = await invoke('get_library');
  store.scanning = data.scanning;
  store.askGamePass = data.ask_gamepass;
  if (data.ask_gamepass) gamePassFound?.();
  const next = JSON.stringify([data.games, data.collections]);
  if (next === signature) return;
  signature = next;
  store.games = data.games;
  store.collections = data.collections;
  store.byId = new Map(data.games.map((g) => [g.id, g]));
  for (const fn of listeners) fn();
}

let timer = 0;
let lastRun = 0;

/** Bursts of catalog updates collapse into at most one refresh per second. */
export function scheduleRefresh() {
  if (timer) return;
  const wait = Math.max(120, 1000 - (performance.now() - lastRun));
  timer = setTimeout(() => {
    timer = 0;
    lastRun = performance.now();
    refreshLibrary();
  }, wait);
}

export async function saveSettings(patch) {
  store.settings = { ...store.settings, ...patch };
  await invoke('set_settings', { settings: store.settings });
}

const UI_KEY = 'vela.ui';

export function loadUi() {
  try {
    return JSON.parse(localStorage.getItem(UI_KEY)) ?? {};
  } catch {
    return {};
  }
}

export function saveUi(patch) {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({ ...loadUi(), ...patch }));
  } catch {
    // Remembering the view is a nicety; a full or blocked store changes nothing.
  }
}

export const recentFirst = (a, b) => (b.last_played ?? 0) - (a.last_played ?? 0) || (b.added ?? 0) - (a.added ?? 0) || a.title.localeCompare(b.title);

const HOME_ORDERS = {
  recent: recentFirst,
  favorites: (a, b) => b.favorite - a.favorite || recentFirst(a, b),
  played: (a, b) => b.playtime - a.playtime || recentFirst(a, b),
  added: (a, b) => (b.added ?? 0) - (a.added ?? 0) || recentFirst(a, b),
  az: (a, b) => a.title.localeCompare(b.title),
};

export function homeGames() {
  const { home_order: order, home_count: count, home_installed_only: installedOnly } = store.settings;
  const installed = store.games.filter((g) => g.installed);
  const pool = installedOnly && installed.length ? installed : store.games;
  return [...pool].sort(HOME_ORDERS[order] ?? recentFirst).slice(0, count);
}
