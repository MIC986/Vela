// Drives a running Vela through the DevTools protocol for interface tests.
// Start Vela with VELA_DEBUG_PORT=9333, then: node tools/cdp.mjs <script.mjs>
// The script default-exports async ({ eval, key, shot, wait, mouse }) => {}.

const port = process.env.VELA_DEBUG_PORT ?? '9333';
const outDir = process.env.VELA_SHOTS ?? '.';

async function target() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('no debug target');
}

const ws = new WebSocket(await target());
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let id = 0;
const pending = new Map();
const consoleLines = [];
ws.onmessage = (m) => {
  const data = JSON.parse(m.data);
  if (data.id && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) reject(new Error(data.error.message));
    else resolve(data.result);
  } else if (data.method === 'Runtime.exceptionThrown') {
    const d = data.params.exceptionDetails;
    consoleLines.push(`EXCEPTION: ${d.text} ${d.exception?.description ?? ''} @${d.url}:${d.lineNumber}`);
  } else if (data.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(data.params.type)) {
    consoleLines.push(`${data.params.type}: ${data.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  } else if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error' && !/art\.localhost/.test(data.params.entry.url ?? '')) {
    consoleLines.push(`log: ${data.params.entry.text} ${data.params.entry.url ?? ''}`);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  id += 1;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const KEYS = {
  Up: ['ArrowUp', 38], Down: ['ArrowDown', 40], Left: ['ArrowLeft', 37], Right: ['ArrowRight', 39],
  Enter: ['Enter', 13], Esc: ['Escape', 27], Space: [' ', 32], Tab: ['Tab', 9],
  m: ['m', 77], f: ['f', 70], q: ['q', 81], e: ['e', 69], '/': ['/', 191], F11: ['F11', 122], PageDown: ['PageDown', 34], Backspace: ['Backspace', 8],
};

const api = {
  send,
  wait,
  console: consoleLines,
  async eval(expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  },
  async key(name, times = 1, gap = 120) {
    const [key, code] = KEYS[name] ?? [name, name.toUpperCase().charCodeAt(0)];
    for (let i = 0; i < times; i += 1) {
      const text = key.length === 1 ? key : key === 'Enter' ? '\r' : undefined;
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: code });
      if (text) await send('Input.dispatchKeyEvent', { type: 'char', key, text });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
      await wait(gap);
    }
  },
  async type(text) {
    for (const ch of text) {
      await send('Input.insertText', { text: ch });
      await wait(40);
    }
  },
  async mouse(x, y, click = false) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    if (click) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    }
  },
  wheel: (x, y, deltaY) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY }),
  press: (x, y) => send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }),
  drag: (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 }),
  release: (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }),
  async shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 86 });
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(outDir, `${name}.jpg`), Buffer.from(r.data, 'base64'));
  },
};

const script = await import(new URL(`file:///${process.argv[2].replace(/\\/g, '/')}`).href);
try {
  await script.default(api);
} finally {
  if (consoleLines.length) console.log('--- console problems\n' + [...new Set(consoleLines)].join('\n'));
  ws.close();
}
