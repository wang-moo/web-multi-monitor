import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createLayoutSync } from './layout-sync.js';

const calls = [];
let release;
const sync = createLayoutSync(async (layout) => {
  calls.push(layout);
  if (calls.length === 1) await new Promise((resolve) => { release = resolve; });
}, (error) => { throw new Error(error); });
const first = [{ label: 'instance-1', width: 100 }];
const latest = [{ label: 'instance-1', width: 300 }];
const running = sync(first);
await sync([{ label: 'instance-1', width: 200 }]);
await sync(latest);
release();
await running;
await sync(latest);
assert.deepEqual(calls, [first[0], latest[0]], 'coalesce resize bursts and skip unchanged layouts');
await sync([]);
await sync(latest);
assert.equal(calls.length, 3, 'forget removed instances');

let attempts = 0;
const errors = [];
const retry = createLayoutSync(async () => { if (++attempts === 1) throw new Error('closed'); }, (error) => errors.push(error));
await retry(first);
await retry(first);
assert.equal(attempts, 2);
assert.equal(errors.length, 1);

const script = readFileSync(new URL('../src-tauri/src/quiet-console.js', import.meta.url), 'utf8');
for (const hostname of ['dev-h5-hall-sz.gameh5pro.com', 'example.com']) {
  const logged = [];
  const console = Object.fromEntries(['log', 'debug', 'info', 'warn', 'error'].map((name) => [name, () => logged.push(name)]));
  runInNewContext(script, { location: { hostname }, console });
  for (const method of Object.values(console)) method({ largeGameObject: true });
  assert.deepEqual(logged, hostname === 'example.com' ? ['log', 'debug', 'info', 'warn', 'error'] : ['warn', 'error']);
}

const rust = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const speedScript = rust.split('fn speed_script(')[1].match(/r#"([\s\S]*?)"#/)[1]
  .replaceAll('{speed}', '3.5').replaceAll('{{', '{').replaceAll('}}', '}');
let scale = 1;
let sets = 0;
let listener;
const timers = new Map();
let timerId = 0;
const messages = [];
const scheduler = { getTimeScale: () => scale, setTimeScale: (value) => { scale = value; sets++; } };
const frame = { contentWindow: { postMessage: (message) => messages.push(message.__isolatedMonitorSpeed) } };
const page = { cc: { director: { getScheduler: () => scheduler } } };
page.parent = page.top = page;
const context = {
  window: page,
  document: { querySelectorAll: () => [frame] },
  addEventListener: (_, handler) => { assert.equal(listener, undefined); listener = handler; },
  setInterval: (tick) => { timers.set(++timerId, tick); return timerId; },
  clearInterval: (id) => timers.delete(id),
};
runInNewContext(speedScript, context);
runInNewContext(speedScript, context);
assert.equal(timers.size, 1, 'reinjection keeps only one speed timer');
assert.equal(sets, 1, 'unchanged scheduler speed is not written again');
scale = 1;
[...timers.values()][0]();
assert.equal(scale, 3.5, 'recover speed after game resets scheduler');
listener({ source: page, data: { __isolatedMonitorSpeed: 7 } });
assert.equal(scale, 7);
assert.ok(messages.includes(3.5), 'continue propagating speed to delayed child frames');
console.log('Performance regression checks passed.');
