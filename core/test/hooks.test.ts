import { describe, expect, it } from 'vitest';
import { HookRunner, createHookState } from '../src/ecc/runner';
import { DEFAULT_HOOKS, hookCatalogue } from '../src/ecc/registry';
import { EXIT_BLOCK, matchesTool, type HookDefinition, type HookInput } from '../src/ecc/types';
import { configProtectionHook, isProtectedConfig } from '../src/ecc/hooks/configProtection';
import { docFileWarningHook, isSuspiciousDocPath } from '../src/ecc/hooks/docFileWarning';
import { consoleLogHook, findDebugLogging } from '../src/ecc/hooks/consoleLog';
import { gateGuardHook, isCosmeticChange, questionsFor } from '../src/ecc/hooks/gateGuard';
import { claimsSuccess, preCompactHook, sessionStartHook, unverifiedClaimHook } from '../src/ecc/hooks/stopGates';
import { secretScanHook } from '../src/ecc/hooks/secretScan';
import { destructiveCommandHook } from '../src/ecc/hooks/destructiveCommand';
import { executeTool } from '../src/agent/executor';
import { runAgentLoop } from '../src/agent/engine';
import { Orchestrator } from '../src/agent/orchestrator';
import { EventStore } from '../src/events/store';
import { MemoryKv } from '../src/platform/memory';
import { ScriptedLlm } from './helpers';
import { ApprovalManager } from '../src/agent/approval';
import { ToolRegistry } from '../src/tools/registry';
import { createMemoryPlatform } from '../src/platform/memory';

const ROOT = '/workspace/demo';

/** All shipped hooks are synchronous; this keeps the tests honest either way. */
async function run(hook: HookDefinition, hookInput: HookInput) {
  return hook.run(hookInput);
}

function input(overrides: Partial<HookInput>): HookInput {
  return {
    event: 'PreToolUse',
    workspaceRoot: ROOT,
    state: createHookState(),
    now: 0,
    ...overrides,
  };
}

describe('hook engine (ECC contract)', () => {
  it('matches the ECC matcher grammar', async () => {
    expect(matchesTool('*', 'write_file')).toBe(true);
    expect(matchesTool('.*', 'anything')).toBe(true);
    expect(matchesTool('write_file|edit_file', 'edit_file')).toBe(true);
    expect(matchesTool('write_file|edit_file', 'EDIT_FILE')).toBe(true);
    expect(matchesTool('write_file|edit_file', 'read_file')).toBe(false);
    expect(matchesTool('^mcp__', 'mcp__github__search')).toBe(true);
  });

  it('runs hooks in declaration order and stops at the first block', async () => {
    const order: string[] = [];
    const make = (id: string, exitCode: number): HookDefinition => ({
      id,
      event: 'PreToolUse',
      matcher: '*',
      description: id,
      derivedFrom: 'test',
      run() {
        order.push(id);
        return { exitCode, severity: exitCode === 2 ? 'block' : 'info', message: id };
      },
    });
    const runner = new HookRunner({ hooks: [make('a', 0), make('b', 2), make('c', 0)] });
    const outcome = await runner.dispatch('PreToolUse', { workspaceRoot: ROOT, state: createHookState(), now: 0 });
    expect(outcome.blocked).toBe(true);
    expect(outcome.blocked && outcome.by).toBe('b');
    expect(order).toEqual(['a', 'b']);
  });

  it('warns without blocking when a hook only writes a message', async () => {
    const runner = new HookRunner({
      hooks: [
        {
          id: 'warn-only',
          event: 'PreToolUse',
          matcher: '*',
          description: 'warn',
          derivedFrom: 'test',
          run: () => ({ exitCode: 0, severity: 'warn', message: 'careful' }),
        },
      ],
    });
    const outcome = await runner.dispatch('PreToolUse', { workspaceRoot: ROOT, state: createHookState(), now: 0 });
    expect(outcome.blocked).toBe(false);
    expect(outcome.results[0].severity).toBe('warn');
  });

  it('treats a crashing hook as a warning, never a silent allow', async () => {
    const runner = new HookRunner({
      hooks: [
        {
          id: 'boom',
          event: 'PreToolUse',
          matcher: '*',
          description: 'throws',
          derivedFrom: 'test',
          run() {
            throw new Error('kaboom');
          },
        },
      ],
    });
    const outcome = await runner.dispatch('PreToolUse', { workspaceRoot: ROOT, state: createHookState(), now: 0 });
    expect(outcome.blocked).toBe(false);
    expect(outcome.results[0].severity).toBe('warn');
    expect(outcome.results[0].message).toContain('kaboom');
  });

  it('times out a stuck hook and continues', async () => {
    const runner = new HookRunner({
      timeoutMs: 5,
      hooks: [
        {
          id: 'slow',
          event: 'PreToolUse',
          matcher: '*',
          description: 'never resolves',
          derivedFrom: 'test',
          run: () => new Promise(() => undefined) as never,
        },
      ],
    });
    const outcome = await runner.dispatch('PreToolUse', { workspaceRoot: ROOT, state: createHookState(), now: 0 });
    expect(outcome.blocked).toBe(false);
    expect(outcome.results[0].message).toContain('timed out');
  });

  it('filters by event and tool matcher', async () => {
    const runner = new HookRunner({ hooks: DEFAULT_HOOKS });
    expect(runner.forEvent('PreToolUse', 'write_file').map((h) => h.id)).toContain('pre:secret-scan');
    expect(runner.forEvent('PreToolUse', 'list_dir').map((h) => h.id)).not.toContain('pre:secret-scan');
    expect(runner.forEvent('Stop').length).toBeGreaterThan(0);
  });

  it('publishes a catalogue whose blocking flags match the real exit codes', async () => {
    const catalogue = hookCatalogue();
    const blocking = catalogue.filter((entry) => entry.blocking).map((entry) => entry.id);
    expect(blocking).toEqual([
      'pre:edit-write:gateguard-fact-force',
      'pre:config-protection',
      'pre:secret-scan',
      'pre:destructive-command',
      'stop:unverified-claim',
    ]);
    // Everything else must never return exit code 2.
    for (const entry of catalogue) {
      if (entry.blocking) continue;
      const hook = DEFAULT_HOOKS.find((candidate) => candidate.id === entry.id)!;
      const result = hook.run(input({ toolName: 'write_file', targetPath: 'x', toolArgs: { content: 'y' } }));
      if (typeof result === 'object' && 'then' in result) continue;
      expect(result.exitCode).not.toBe(EXIT_BLOCK);
    }
  });
});

describe('ported ECC hooks', () => {
  it('blocks modification of an existing linter config but allows creating one', async () => {
    expect(isProtectedConfig('tsconfig.json')).toBe(true);
    expect(isProtectedConfig('app/node_modules/x/tsconfig.json')).toBe(false);

    const state = createHookState();
    state.set('exists:tsconfig.json', true);
    const blocked = await run(configProtectionHook, input({ toolName: 'write_file', targetPath: 'tsconfig.json', state }));
    expect(blocked.exitCode).toBe(EXIT_BLOCK);
    expect(blocked.message).toContain('Fix the code');

    const creatingState = createHookState();
    creatingState.set('exists:detekt.yml', false);
    const fresh = await run(configProtectionHook, 
      input({ toolName: 'write_file', targetPath: 'detekt.yml', state: creatingState }),
    );
    expect(fresh.exitCode).toBe(0);

    // Unknown existence (probe failed) is treated conservatively as "exists".
    const unknown = await run(configProtectionHook, 
      input({ toolName: 'write_file', targetPath: 'lint.xml', state: createHookState() }),
    );
    expect(unknown.exitCode).toBe(EXIT_BLOCK);
  });

  it('warns about scratch docs but never blocks them', async () => {
    expect(isSuspiciousDocPath('NOTES.md')).toBe(true);
    expect(isSuspiciousDocPath('docs/NOTES.md')).toBe(false);
    expect(isSuspiciousDocPath('TODO.txt')).toBe(true);
    expect(isSuspiciousDocPath('README.md')).toBe(false);
    const result = await run(docFileWarningHook, input({ toolName: 'write_file', targetPath: 'SCRATCH.md' }));
    expect(result.exitCode).toBe(0);
    expect(result.severity).toBe('warn');
  });

  it('finds Kotlin debug logging only in production sources', async () => {
    const body = ['package demo', 'fun main() {', '  println("debug")', '  Log.d("tag", "x")', '}'].join('\n');
    expect(findDebugLogging('app/src/main/Main.kt', body)).toHaveLength(2);
    expect(findDebugLogging('app/src/main/Main.kt', '// println("commented")\nval x = 1')).toHaveLength(0);
    expect(findDebugLogging('app/src/test/MainTest.kt', body)).toHaveLength(0);
    expect(findDebugLogging('web/app.js', 'console.log(1)')).toHaveLength(0);
  });

  it('reports debug logging through the Stop hook', async () => {
    const state = createHookState();
    state.set('kotlinSources', [{ path: 'app/src/main/A.kt', content: 'println("x")' }]);
    const result = await run(consoleLogHook, input({ event: 'Stop', state }));
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('1 debug logging');
  });

  it('GateGuard denies the first write of a sensitive file, then allows after a read', async () => {
    const state = createHookState();
    state.set('exists:.github/workflows/build.yml', true);
    const first = await run(gateGuardHook, 
      input({ toolName: 'write_file', targetPath: '.github/workflows/build.yml', toolArgs: { content: 'on: push' }, state }),
    );
    expect(first.exitCode).toBe(EXIT_BLOCK);
    expect(first.message).toContain('Which job will run this workflow');

    // Second attempt without reading: still allowed, because the gate fired once.
    const second = await run(gateGuardHook, 
      input({ toolName: 'write_file', targetPath: '.github/workflows/build.yml', toolArgs: { content: 'on: push' }, state }),
    );
    expect(second.exitCode).toBe(0);

    const fresh = createHookState();
    fresh.set('exists:AndroidManifest.xml', true);
    fresh.set('readFiles', ['AndroidManifest.xml']);
    const readFirst = await run(gateGuardHook, 
      input({ toolName: 'edit_file', targetPath: 'AndroidManifest.xml', toolArgs: { old_string: 'a', new_string: 'b' }, state: fresh }),
    );
    expect(readFirst.exitCode).toBe(0);
  });

  it('GateGuard questions the right target class', async () => {
    expect(questionsFor('app/build.gradle.kts').targetClass).toBe('build');
    expect(questionsFor('secrets/keys.properties').targetClass).toBe('secrets');
    expect(questionsFor('app/src/main/java/auth/Login.kt').targetClass).toBe('auth');
    expect(questionsFor('app/src/main/AndroidManifest.xml').targetClass).toBe('manifest');
    expect(questionsFor('app/src/main/Main.kt').targetClass).toBe('general');
  });

  it('GateGuard lets cosmetic edits through', async () => {
    expect(isCosmeticChange('val a = 1', 'val  a  =  1 // tidied')).toBe(true);
    expect(isCosmeticChange('val a = 1', 'val a = 2')).toBe(false);
    const state = createHookState();
    state.set('exists:AndroidManifest.xml', true);
    state.set('content:AndroidManifest.xml', '<manifest/>');
    const result = await run(gateGuardHook, 
      input({
        toolName: 'write_file',
        targetPath: 'AndroidManifest.xml',
        toolArgs: { content: '<manifest />' },
        state,
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('comment/whitespace-only');
  });

  it('blocks success claims that were never verified', async () => {
    expect(claimsSuccess('All tests pass and the build succeeded')).toBe(true);
    expect(claimsSuccess('I could not run the build on device')).toBe(false);
    const empty = createHookState();
    empty.set('lastAssistantMessage', 'Build succeeded!');
    const blocked = await run(unverifiedClaimHook, input({ event: 'Stop', state: empty }));
    expect(blocked.exitCode).toBe(EXIT_BLOCK);

    const verified = createHookState();
    verified.set('lastAssistantMessage', 'Build succeeded!');
    verified.set('verificationRan', true);
    expect((await run(unverifiedClaimHook, input({ event: 'Stop', state: verified }))).exitCode).toBe(0);
  });

  it('persists a checkpoint before compaction and injects memory at session start', async () => {
    const state = createHookState();
    state.touchedFiles.push('a.kt', 'b.kt');
    const compact = await run(preCompactHook, input({ event: 'PreCompact', state }));
    expect(compact.severity).toBe('warn');
    expect(state.get<string>('compactionNote')).toContain('a.kt');

    const memory = createHookState();
    memory.set('projectMemory', '# AGENTS.md\nuse Gradle');
    const start = await run(sessionStartHook, input({ event: 'SessionStart', state: memory }));
    expect(start.additionalContext).toContain('use Gradle');
  });

  it('blocks a write that contains a credential', async () => {
    const result = await run(secretScanHook, 
      input({
        toolName: 'write_file',
        targetPath: 'app/src/main/Config.kt',
        toolArgs: { content: 'const val KEY = "ghp_' + 'a'.repeat(40) + '"' },
      }),
    );
    expect(result.exitCode).toBe(EXIT_BLOCK);
    expect(result.message).toContain('credential');
  });

  it('blocks destructive commands and warns on shell metacharacters', async () => {
    const destructive = await run(destructiveCommandHook, 
      input({ toolName: 'run_command', toolArgs: { command: 'git push --force origin main' } }),
    );
    expect(destructive.exitCode).toBe(EXIT_BLOCK);
    const noisy = await run(destructiveCommandHook, 
      input({ toolName: 'run_command', toolArgs: { command: 'echo hi && rm file' } }),
    );
    expect(noisy.exitCode).toBe(0);
    expect(noisy.severity).toBe('warn');
    expect((await run(destructiveCommandHook, input({ toolName: 'run_command', toolArgs: { command: 'gradle test' } }))).exitCode).toBe(0);
  });
});

describe('the Stop gate forces a retry instead of ending the run', () => {
  it('feeds the block back to the model and continues the loop', async () => {
    const platform = createMemoryPlatform();
    const registry = ToolRegistry.standard(platform, ROOT);
    const llm = new ScriptedLlm([{ content: 'All tests pass!' }, { content: 'Tests pass, verified with gradle test' }]);
    let blocks = 0;
    const result = await runAgentLoop({
      llm,
      registry,
      approvals: new ApprovalManager('FULL_AUTO'),
      workspaceRoot: ROOT,
      systemPrompt: 'x',
      beforeComplete: async () => {
        blocks += 1;
        return blocks === 1 ? { blocked: true, message: 'run the tests' } : { blocked: false };
      },
    });
    expect(result.reason).toBe('completed');
    expect(result.rounds).toBe(2);
    expect(llm.requests[1].messages.some((m) => (m.content ?? '').includes('run the tests'))).toBe(true);
  });

  it('gives up after maxStopRetries and still finishes', async () => {
    const platform = createMemoryPlatform();
    const result = await runAgentLoop({
      llm: new ScriptedLlm([{ content: 'Build succeeded' }]),
      registry: ToolRegistry.standard(platform, ROOT),
      approvals: new ApprovalManager('FULL_AUTO'),
      workspaceRoot: ROOT,
      systemPrompt: 'x',
      maxStopRetries: 1,
      beforeComplete: async () => ({ blocked: true, message: 'no verification' }),
    });
    expect(result.reason).toBe('completed');
    expect(result.rounds).toBe(2);
  });

  it('records a gate_blocked event when an agent claims unverified success', async () => {
    const platform = createMemoryPlatform();
    const events = new EventStore(new MemoryKv(), 'run-stop-gate');
    const orchestrator = new Orchestrator({
      platform,
      llm: () => new ScriptedLlm([{ content: 'The build succeeded and all tests pass.' }]),
      registry: ToolRegistry.standard(platform, ROOT),
      approvals: new ApprovalManager('FULL_AUTO'),
      events,
      workspaceRoot: ROOT,
    });
    await orchestrator.ask('editor', 'implement the feature');
    const all = await events.all();
    expect(all.some((event) => event.kind === 'gate_blocked' && JSON.stringify(event).includes('stop:unverified-claim'))).toBe(true);
    expect(all.some((event) => JSON.stringify(event).includes('stop:unverified-claim'))).toBe(true);
  });
});

describe('hooks in the tool choke point', () => {
  it('refuses a secret-bearing write before the tool runs, and reports the hook', async () => {
    const platform = createMemoryPlatform();
    const registry = ToolRegistry.standard(platform, ROOT);
    const runner = new HookRunner({ hooks: DEFAULT_HOOKS });
    const outcome = await executeTool({
      toolName: 'write_file',
      args: { path: 'app/Keys.kt', content: 'val key = "sk-' + 'a'.repeat(40) + '"' },
      registry,
      approvals: new ApprovalManager('FULL_AUTO'),
      workspaceRoot: ROOT,
      hookRunner: runner,
      hookState: createHookState(),
    });
    expect(outcome.blocked).toBe(true);
    expect(outcome.envelope.error?.code).toBe('EHOOK');
    expect(outcome.hooks?.some((hook) => hook.id === 'pre:secret-scan' && hook.exitCode === 2)).toBe(true);
    expect(await platform.fs.exists(`${ROOT}/app/Keys.kt`)).toBe(false);
  });

  it('lets a clean write through and records the touched file', async () => {
    const platform = createMemoryPlatform();
    const registry = ToolRegistry.standard(platform, ROOT);
    const state = createHookState();
    const outcome = await executeTool({
      toolName: 'write_file',
      args: { path: 'app/Main.kt', content: 'fun main() = Unit' },
      registry,
      approvals: new ApprovalManager('FULL_AUTO'),
      workspaceRoot: ROOT,
      hookRunner: new HookRunner({ hooks: DEFAULT_HOOKS }),
      hookState: state,
    });
    expect(outcome.blocked).toBe(false);
    expect(await platform.fs.read(`${ROOT}/app/Main.kt`)).toBe('fun main() = Unit');
    expect(state.touchedFiles).toContain('app/Main.kt');
  });

  it('does not gate a brand-new sensitive file', async () => {
    const platform = createMemoryPlatform();
    const registry = ToolRegistry.standard(platform, ROOT);
    const outcome = await executeTool({
      toolName: 'write_file',
      args: { path: '.github/workflows/build.yml', content: 'on: push' },
      registry,
      approvals: new ApprovalManager('FULL_AUTO'),
      workspaceRoot: ROOT,
      hookRunner: new HookRunner({ hooks: DEFAULT_HOOKS }),
      hookState: createHookState(),
    });
    expect(outcome.blocked).toBe(false);
  });

  it('blocks mutating an existing protected config through the graph', async () => {
    const platform = createMemoryPlatform();
    await platform.fs.write(`${ROOT}/tsconfig.json`, '{}');
    const registry = ToolRegistry.standard(platform, ROOT);
    const outcome = await executeTool({
      toolName: 'write_file',
      args: { path: 'tsconfig.json', content: '{"strict": false}' },
      registry,
      approvals: new ApprovalManager('FULL_AUTO'),
      workspaceRoot: ROOT,
      hookRunner: new HookRunner({ hooks: DEFAULT_HOOKS }),
      hookState: createHookState(),
    });
    expect(outcome.blocked).toBe(true);
    expect(outcome.blockedReason).toContain('config');
  });

  it('keeps the secret gate even when the caller supplies no hook runner', async () => {
    const platform = createMemoryPlatform();
    const registry = ToolRegistry.standard(platform, ROOT);
    const outcome = await executeTool({
      toolName: 'write_file',
      args: { path: 'app/K.kt', content: '-----BEGIN RSA PRIVATE KEY-----' },
      registry,
      approvals: new ApprovalManager('FULL_AUTO'),
      workspaceRoot: ROOT,
    });
    expect(outcome.blocked).toBe(true);
    expect(outcome.envelope.error?.code).toBe('ESECRET');
  });
});
