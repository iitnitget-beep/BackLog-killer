import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createNodePlatform } from '../src/node-index';

/**
 * The Node platform is what the CLI and the desktop preview use, and it is the
 * reference implementation for the Android sandbox. These tests pin down the
 * path rules, because getting them wrong is a sandbox escape rather than a
 * cosmetic bug (a relative root used to make list() return nothing while making
 * relative reads look successful).
 */
const base = path.join(os.tmpdir(), `forgex-node-test-${process.pid}`);

async function freshWorkspace(): Promise<string> {
  const root = path.join(base, 'ws');
  await fs.rm(base, { recursive: true, force: true });
  await fs.mkdir(path.join(root, 'sub'), { recursive: true });
  await fs.writeFile(path.join(root, 'Main.kt'), 'fun main() {}');
  await fs.writeFile(path.join(root, 'sub', 'a.txt'), 'hi');
  return root;
}

beforeEach(async () => {
  await freshWorkspace();
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe.each([
  ['absolute root', (root: string) => root],
  ['relative root', (root: string) => path.relative(process.cwd(), root)],
])('node platform with %s', (_label, spell) => {
  it('lists through the root however it was spelled', async () => {
    const root = await freshWorkspace();
    const platform = createNodePlatform({ workspaceRoot: spell(root), dataDir: path.join(base, 'data') });
    const entries = await platform.fs.list(spell(root), { recursive: true, includeDirs: false });
    expect(entries.map((entry) => entry.name).sort()).toEqual(['Main.kt', 'sub/a.txt']);
  });

  it('reads by absolute path from list() and by relative path', async () => {
    const root = await freshWorkspace();
    const platform = createNodePlatform({ workspaceRoot: spell(root), dataDir: path.join(base, 'data') });
    const entries = await platform.fs.list(spell(root), { recursive: true, includeDirs: false });
    const absolute = entries.find((entry) => entry.name === 'Main.kt')!;
    expect(await platform.fs.read(absolute.path)).toBe('fun main() {}');
    expect(await platform.fs.read('Main.kt')).toBe('fun main() {}');
    expect(await platform.fs.read('sub/a.txt')).toBe('hi');
  });

  it('writes into subdirectories and creates them', async () => {
    const root = await freshWorkspace();
    const platform = createNodePlatform({ workspaceRoot: spell(root), dataDir: path.join(base, 'data') });
    await platform.fs.write('deep/nested/file.txt', 'x');
    expect(await fs.readFile(path.join(root, 'deep/nested/file.txt'), 'utf8')).toBe('x');
  });

  it('blocks traversal and absolute paths outside the root', async () => {
    const root = await freshWorkspace();
    const platform = createNodePlatform({ workspaceRoot: spell(root), dataDir: path.join(base, 'data') });
    await expect(platform.fs.read('../escape.txt')).rejects.toThrow(/escapes root/);
    await expect(platform.fs.read('/etc/passwd')).rejects.toThrow(/escapes root/);
    await expect(platform.fs.write('../escape.txt', 'x')).rejects.toThrow(/escapes root/);
  });

  it('reports stat and existence correctly', async () => {
    const root = await freshWorkspace();
    const platform = createNodePlatform({ workspaceRoot: spell(root), dataDir: path.join(base, 'data') });
    expect(await platform.fs.exists('Main.kt')).toBe(true);
    expect(await platform.fs.exists('nope.kt')).toBe(false);
    const stat = await platform.fs.stat('Main.kt');
    expect(stat?.type).toBe('file');
    expect(stat?.size).toBeGreaterThan(0);
    expect((await platform.fs.stat('sub'))?.type).toBe('dir');
    expect(await platform.fs.stat('missing')).toBeNull();
  });

  it('filters by suffix', async () => {
    const root = await freshWorkspace();
    const platform = createNodePlatform({ workspaceRoot: spell(root), dataDir: path.join(base, 'data') });
    const kotlin = await platform.fs.list(spell(root), { recursive: true, suffix: '.kt' });
    expect(kotlin.map((entry) => entry.name)).toEqual(['Main.kt']);
  });
});

describe('node platform guards', () => {
  it('refuses commands outside the allowlist', async () => {
    const root = await freshWorkspace();
    const platform = createNodePlatform({ workspaceRoot: root, dataDir: path.join(base, 'data') });
    await expect(platform.exec(['curl', 'http://example.com'])).rejects.toThrow(/not allowed/);
  });

  it('runs an allowlisted command with a timeout budget', async () => {
    const root = await freshWorkspace();
    const platform = createNodePlatform({ workspaceRoot: root, dataDir: path.join(base, 'data') });
    const result = await platform.exec(['echo', 'hello']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('persists secrets outside the workspace with 0600 permissions', async () => {
    const root = await freshWorkspace();
    const dataDir = path.join(base, 'data');
    const platform = createNodePlatform({ workspaceRoot: root, dataDir });
    await platform.secrets.set('provider/apiKey', 'sk-test');
    expect(await platform.secrets.get('provider/apiKey')).toBe('sk-test');
    const file = path.join(dataDir, 'secrets.json');
    const mode = (await fs.stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
    // The secret must not be inside the publishable workspace.
    const entries = await platform.fs.list(root, { recursive: true, includeDirs: false });
    expect(entries.map((entry) => entry.name)).not.toContain('secrets.json');
  });

  it('persists key/value data with prefix listing', async () => {
    const root = await freshWorkspace();
    const platform = createNodePlatform({ workspaceRoot: root, dataDir: path.join(base, 'data') });
    await platform.kv.set('runs/a/events', '[]');
    await platform.kv.set('runs/b/events', '[]');
    expect(await platform.kv.keys('runs/')).toEqual(['runs/a/events', 'runs/b/events']);
    await platform.kv.delete('runs/a/events');
    expect(await platform.kv.get('runs/a/events')).toBeNull();
  });
});
