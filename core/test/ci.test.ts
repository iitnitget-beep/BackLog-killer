import { describe, expect, it } from 'vitest';
import { androidBuildWorkflow, forgexSelfWorkflow } from '../src/ci/workflow';
import { monitorRun, trimCiLog, findRunForCommit } from '../src/ci/monitor';
import type { GitHubClient, WorkflowRun } from '../src/github/client';

function fakeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 7,
    name: 'Build APK',
    status: 'in_progress',
    conclusion: null,
    headBranch: 'main',
    headSha: 'sha',
    htmlUrl: 'https://github.com/me/t/app/actions/runs/7',
    createdAt: 'now',
    ...overrides,
  };
}

describe('workflow generation', () => {
  it('generates a buildable android workflow', () => {
    const yaml = androidBuildWorkflow();
    expect(yaml).toContain('actions/setup-java@v4');
    expect(yaml).toContain('android-actions/setup-android@v3');
    expect(yaml).toContain('./gradlew assembleDebug');
    expect(yaml).toContain('actions/upload-artifact@v4');
    expect(yaml).toContain('if-no-files-found: error');
  });

  it('honours options', () => {
    const yaml = androidBuildWorkflow({ gradleTask: 'assembleRelease', javaVersion: 21, extraSteps: ['npm ci'] });
    expect(yaml).toContain('assembleRelease');
    expect(yaml).toContain("java-version: '21'");
    expect(yaml).toContain('run: npm ci');
  });

  it('includes the ForgeX self workflow with tests before the APK build', () => {
    const yaml = forgexSelfWorkflow();
    expect(yaml).toContain('test-core');
    expect(yaml).toContain('needs: test-core');
    expect(yaml).toContain('softprops/action-gh-release@v2');
  });
});

describe('ci monitor', () => {
  const noSleep = async () => undefined;

  function clientWith(states: WorkflowRun[]): GitHubClient {
    let index = 0;
    return {
      getRun: async () => states[Math.min(index++, states.length - 1)],
      getJobLogs: async () => 'FAILURE: build failed\nWhat went wrong:\n> error: unresolved reference: foo',
      listArtifacts: async () => [
        { id: 3, name: 'debug-apk', sizeInBytes: 100, expired: false, archiveDownloadUrl: 'u' },
        { id: 4, name: 'logs', sizeInBytes: 10, expired: false, archiveDownloadUrl: 'u2' },
      ],
    } as unknown as GitHubClient;
  }

  it('polls until completion and finds the apk artifact', async () => {
    const client = clientWith([
      fakeRun({ status: 'queued' }),
      fakeRun({ status: 'in_progress' }),
      fakeRun({ status: 'completed', conclusion: 'success' }),
    ]);
    const outcome = await monitorRun(7, { client, repoFullName: 'me/t', sleep: noSleep });
    expect(outcome.status).toBe('success');
    expect(outcome.apkArtifact?.name).toBe('debug-apk');
    expect(outcome.logs).toContain('unresolved reference');
  });

  it('reports failure with logs for the repair loop', async () => {
    const client = clientWith([fakeRun({ status: 'completed', conclusion: 'failure' })]);
    const outcome = await monitorRun(7, { client, repoFullName: 'me/t', sleep: noSleep });
    expect(outcome.status).toBe('failure');
    expect(outcome.logs).toContain('What went wrong');
  });

  it('times out cleanly', async () => {
    const client = clientWith([fakeRun({ status: 'in_progress' })]);
    const outcome = await monitorRun(7, { client, repoFullName: 'me/t', sleep: noSleep, timeoutMs: 0 });
    expect(outcome.status).toBe('timeout');
  });

  it('matches the run by head sha', async () => {
    const client = {
      listWorkflowRuns: async () => [fakeRun({ status: 'queued', headSha: 'abc123' })],
    } as unknown as GitHubClient;
    const run = await findRunForCommit(client, 'me/t', 'main', 'abc123', { sleep: noSleep, attempts: 2 });
    expect(run?.id).toBe(7);
  });

  it('falls back to the newest run on the branch before head_sha is populated', async () => {
    const client = {
      listWorkflowRuns: async () => [fakeRun({ status: 'queued', headSha: '' })],
    } as unknown as GitHubClient;
    const run = await findRunForCommit(client, 'me/t', 'main', 'unknown-sha', { sleep: noSleep, attempts: 3 });
    expect(run?.id).toBe(7);
  });
});

describe('log trimming', () => {
  it('keeps errors and drops gradle noise', () => {
    const raw = [
      'Welcome to Gradle 8.7',
      '> Task :app:compileDebugKotlin',
      'e: file:///app/MainActivity.kt:12:5 Unresolved reference: setContent',
      '> Task :app:compileDebugKotlin FAILED',
      'BUILD FAILED in 30s',
    ].join('\n');
    const trimmed = trimCiLog(raw);
    expect(trimmed).toContain('Unresolved reference');
    expect(trimmed).toContain('BUILD FAILED');
  });
});
