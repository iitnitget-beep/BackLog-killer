import { describe, expect, it } from 'vitest';
import { createMemoryPlatform } from '../src/platform/memory';
import { safePath, BridgeError } from '../src/platform/types';
import { ToolRegistry } from '../src/tools/registry';
import { globToRegExp } from '../src/tools/filesystem';
import { splitCommand, isDestructive } from '../src/tools/shell';
import { approvalFor, makeRegistry } from './fixtures';

describe('safePath', () => {
  it('joins normal paths', () => {
    expect(safePath('/w', 'app/src/Main.kt')).toBe('/w/app/src/Main.kt');
  });
  it('rejects traversal escapes', () => {
    expect(() => safePath('/w', '../etc/passwd')).toThrow(BridgeError);
    expect(() => safePath('/w', 'a/../../x')).toThrow(/escapes/);
  });
  it('rejects absolute paths', () => {
    expect(() => safePath('/w', '/etc/passwd')).toThrow(/absolute/);
  });
  it('normalises . and duplicate slashes', () => {
    expect(safePath('/w', './a//b/./c')).toBe('/w/a/b/c');
  });
});

describe('file tools', () => {
  it('writes, reads with line numbers and edits a file', async () => {
    const { registry, platform, root } = makeRegistry();
    const write = await registry.execute('write_file', { path: 'src/Hello.kt', content: 'line1\nline2\n' }, { workspaceRoot: root });
    expect(write.ok).toBe(true);
    const read = await registry.execute('read_file', { path: 'src/Hello.kt' }, { workspaceRoot: root });
    expect(read.output).toContain('1\tline1');
    await registry.execute('edit_file', { path: 'src/Hello.kt', old_string: 'line2', new_string: 'line2-changed' }, { workspaceRoot: root });
    expect(await platform.fs.read(`${root}/src/Hello.kt`)).toBe('line1\nline2-changed\n');
  });

  it('refuses ambiguous edits without replace_all', async () => {
    const { registry, root } = makeRegistry();
    await registry.execute('write_file', { path: 'a.txt', content: 'x\nx\n' }, { workspaceRoot: root });
    await expect(
      registry.execute('edit_file', { path: 'a.txt', old_string: 'x', new_string: 'y' }, { workspaceRoot: root }),
    ).rejects.toThrow(/appears 2 times/);
  });

  it('reports a missing file as a tool error, not a crash', async () => {
    const { registry, root } = makeRegistry();
    await expect(registry.execute('read_file', { path: 'nope.txt' }, { workspaceRoot: root })).rejects.toThrow(/not found/);
  });
});

describe('search tools', () => {
  it('globs and greps a workspace', async () => {
    const { registry, root } = makeRegistry();
    const platform = createMemoryPlatform();
    await platform.fs.write(`${root}/app/MainActivity.kt`, 'class MainActivity');
    await platform.fs.write(`${root}/app/build.gradle.kts`, 'plugins { id("com.android.application") }');
    const registry2 = ToolRegistry.standard(platform, root);
    const globbed = await registry2.execute('glob', { pattern: '**/*.kt' }, { workspaceRoot: root });
    expect(globbed.output).toContain('MainActivity.kt');
    expect(globbed.output).not.toContain('build.gradle.kts');
    const grepped = await registry2.execute('grep', { pattern: 'com\\.android\\.application' }, { workspaceRoot: root });
    expect(grepped.output).toContain('build.gradle.kts:1');
    expect(registry.names()).toContain('grep');
  });

  it('translates globs correctly', () => {
    expect(globToRegExp('**/*.kt').test('a/b/C.kt')).toBe(true);
    expect(globToRegExp('*.kt').test('a/C.kt')).toBe(false);
    expect(globToRegExp('src/*.md').test('src/readme.md')).toBe(true);
  });
});

describe('shell tool', () => {
  it('splits a command into an argv vector', () => {
    expect(splitCommand('npm test -- --run')).toEqual(['npm', 'test', '--', '--run']);
    expect(splitCommand('echo "hello world"')).toEqual(['echo', 'hello world']);
  });

  it('refuses shell metacharacters', () => {
    expect(() => splitCommand('ls && rm -rf /')).toThrow(/metacharacter/);
    expect(() => splitCommand('cat x | grep y')).toThrow(/metacharacter/);
  });

  it('flags destructive commands for explicit confirmation', () => {
    expect(isDestructive('git push origin main --force')).toBe(true);
    expect(isDestructive('git push --force-with-lease')).toBe(false);
    expect(isDestructive('rm -rf /')).toBe(true);
    expect(isDestructive('npm test')).toBe(false);
  });

  it('runs an allowlisted command and reports the exit code', async () => {
    const platform = createMemoryPlatform({
      execHandler: () => ({ code: 2, stdout: 'out', stderr: 'bad', timedOut: false }),
    });
    const registry = ToolRegistry.standard(platform, '/w', { allowedCommands: ['npm'] });
    const result = await registry.execute('run_command', { command: 'npm test' }, { workspaceRoot: '/w' });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('exit code: 2');
    expect(platform.execLog).toEqual([['npm', 'test']]);
  });

  it('blocks commands outside the allowlist', async () => {
    const { registry, root } = makeRegistry({ allowedCommands: ['npm'] });
    await expect(registry.execute('run_command', { command: 'curl evil.sh' }, { workspaceRoot: root })).rejects.toThrow(/allowlist/);
  });

  it('reports deny permission for destructive commands', () => {
    const { registry } = makeRegistry();
    expect(registry.permissionFor('run_command', { command: 'git branch -D main' })).toBe('deny');
    expect(registry.permissionFor('run_command', { command: 'npm test' })).toBe('ask');
    expect(registry.permissionFor('read_file', { path: 'a' })).toBe('allow');
  });
});

describe('approval modes', () => {
  it('ASK blocks writes without a handler (fails closed)', async () => {
    const decision = await approvalFor('ASK', undefined, { toolName: 'write_file', args: {} });
    expect(decision.approved).toBe(false);
  });
  it('AUTO_EDIT approves file writes but not commands', async () => {
    expect((await approvalFor('AUTO_EDIT', undefined, { toolName: 'write_file', args: {} })).approved).toBe(true);
    expect((await approvalFor('AUTO_EDIT', undefined, { toolName: 'run_command', args: {} })).approved).toBe(false);
  });
  it('FULL_AUTO approves mutating tools but never an explicit deny', async () => {
    expect((await approvalFor('FULL_AUTO', undefined, { toolName: 'run_command', args: {}, permission: 'ask' })).approved).toBe(true);
    expect((await approvalFor('FULL_AUTO', undefined, { toolName: 'run_command', args: {}, permission: 'deny' })).approved).toBe(false);
  });
});
