import * as esbuild from 'esbuild';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const outdir = new URL('../dist/', import.meta.url).pathname;
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// The agent core bundle consumed by the Android WebView.
await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'ForgeXCore',
  target: ['es2020'],
  outfile: `${outdir}core.js`,
  sourcemap: true,
  logLevel: 'info',
  // The vendored ECC skills are Markdown; they ship as strings inside the bundle.
  loader: { '.md': 'text' },
});

// The UI bundle: the same browser-safe core plus the DOM shell.
await esbuild.build({
  entryPoints: ['src/ui/main.ts'],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  outfile: `${outdir}ui.js`,
  sourcemap: true,
  logLevel: 'info',
  // The vendored ECC skills are Markdown; they ship as strings inside the bundle.
  loader: { '.md': 'text' },
});

for (const file of await readdir('src/ui')) {
  if (file.endsWith('.css') || file.endsWith('.html')) {
    await cp(`src/ui/${file}`, `${outdir}${file}`);
  }
}
console.log('bundle written to', outdir);
if (!existsSync(`${outdir}index.html`)) {
  console.warn('warning: no index.html copied from src/ui');
}
