/**
 * Vendors the ECC skills ForgeX ships with.
 *
 * ECC's skills are MIT-licensed (Copyright (c) 2026 Affaan Mustafa). We copy the
 * files verbatim and prepend an attribution header, so the licence text travels
 * with the content inside the APK. NOTICE.md records the same thing for the
 * repository.
 *
 * Run: node scripts/prepare-ecc-skills.mjs /path/to/refs/ECC
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';

export const SKILLS = [
  'android-clean-architecture',
  'kotlin-patterns',
  'compose-multiplatform-patterns',
  'kotlin-coroutines-flows',
  'kotlin-testing',
  'tdd-workflow',
  'security-review',
];

const source = process.argv[2];
if (!source) {
  console.error('usage: node scripts/prepare-ecc-skills.mjs <path to ECC checkout>');
  process.exit(2);
}
let commit = 'unknown';
try {
  commit = execSync('git rev-parse HEAD', { cwd: source }).toString().trim();
} catch {
  /* keep 'unknown' */
}

const outDir = path.resolve('src/ecc/skills');
await mkdir(outDir, { recursive: true });

for (const name of SKILLS) {
  const raw = await readFile(path.join(source, 'skills', name, 'SKILL.md'), 'utf8');
  const header = `<!--
  Vendored from affaan-m/ECC skills/${name}/SKILL.md
  Source commit: ${commit}
  Licence: MIT, Copyright (c) 2026 Affaan Mustafa
  Full licence text: NOTICE.md at the repository root.
  Do not edit in place: re-run core/scripts/prepare-ecc-skills.mjs.
-->
`;
  await writeFile(path.join(outDir, `${name}.md`), header + raw, 'utf8');
  console.log(`vendored ${name} (${raw.length} bytes)`);
}
console.log(`done -> ${outDir}`);
