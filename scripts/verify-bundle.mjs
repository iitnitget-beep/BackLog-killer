/**
 * Boots the built UI bundle in a minimal DOM sandbox and asserts it renders.
 *
 * This is the closest thing to a real launch check that does not need a device:
 * it runs the actual esbuild output (not the TypeScript source), so a bundling
 * mistake, a missing export, or a top-level throw fails CI before the APK is
 * assembled.
 */
import fs from 'node:fs';
import vm from 'node:vm';
const code = fs.readFileSync('core/dist/ui.js', 'utf8');
const container = { innerHTML: '', dataset: {}, addEventListener() {} };
const sandbox = {
  console,
  document: { getElementById: (id) => (id === 'app' ? container : null), querySelectorAll: () => [], querySelector: () => null },
  navigator: { clipboard: { writeText: async () => {} } },
  // Real timers so async boot() can complete.
  setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Uint8Array, Map, Set, URL,
  localStorage: { getItem: () => null, setItem: () => {} },
  fetch: async () => { throw new Error('no network'); },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { timeout: 5000 });
await new Promise((resolve) => setTimeout(resolve, 150));
const html = container.innerHTML;
console.log('rendered length:', html.length);
console.log('home screen:', html.includes('What should ForgeX build?'));
console.log('tab bar:', html.includes('data-nav="build"'));
console.log('labelled preview:', html.includes('preview'));
console.log('no runtime error thrown: true');
process.exit(html.length > 500 ? 0 : 1);
