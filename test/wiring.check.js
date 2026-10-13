const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');

const ids = new Set();
for (const match of renderer.matchAll(/getElementById\('([^']+)'\)/g)) {
  ids.add(match[1]);
}
// Ids created dynamically inside renderer.js are also fine.
const dynamic = [...renderer.matchAll(/\.id = '([^']+)'/g)].map((m) => m[1]);
const missing = [...ids].filter((id) => !html.includes(`id="${id}"`) && !dynamic.includes(id));

console.log(`renderer.js references ${ids.size} element ids`);
if (missing.length) {
  console.error('MISSING IN index.html:', missing.join(', '));
  process.exit(1);
}
console.log('all referenced ids exist in index.html');

// Window.rufus API surface must match the preload bridge.
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const exposed = new Set([...preload.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]));
const used = new Set([...renderer.matchAll(/window\.rufus\.(\w+)\(/g)].map((m) => m[1]));
const notExposed = [...used].filter((name) => !exposed.has(name));
if (notExposed.length) {
  console.error('renderer calls window.rufus.' + notExposed.join(', window.rufus.') + ' but preload does not expose them');
  process.exit(1);
}
console.log(`all ${used.size} window.rufus calls are exposed by preload.js`);

// IPC channels: every channel the preload uses must be handled in main.js.
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const channels = new Set([
  ...[...preload.matchAll(/ipcRenderer\.(?:send|invoke)\('([^']+)'/g)].map((m) => m[1]),
  ...[...preload.matchAll(/ipcRenderer\.on\('([^']+)'/g)].map((m) => m[1])
]);
const unhandled = [...channels].filter((c) => !main.includes(`'${c}'`));
if (unhandled.length) {
  console.error('IPC channels with no handler in main.js:', unhandled.join(', '));
  process.exit(1);
}
console.log(`all ${channels.size} IPC channels are handled in main.js`);
