import { describe, expect, it } from 'vitest';
import { GitHubClient, GitHubError } from '../src/github/client';
import { createMemoryPlatform } from '../src/platform/memory';

function makeClient(routes: Record<string, { status: number; body: string; headers?: Record<string, string> }>) {
  const calls: { url: string; method?: string; body?: string }[] = [];
  const platform = createMemoryPlatform({
    httpHandler: (request) => {
      calls.push({ url: request.url, method: request.method, body: request.body });
      for (const [pattern, response] of Object.entries(routes)) {
        if (request.url.includes(pattern)) {
          return { status: response.status, headers: response.headers ?? {}, body: response.body };
        }
      }
      return { status: 404, headers: {}, body: '{"message":"not found"}' };
    },
  });
  return { client: new GitHubClient({ platform, token: 'test-token' }), calls };
}

const repoBody = JSON.stringify({
  full_name: 'me/timer',
  default_branch: 'main',
  private: false,
  html_url: 'https://github.com/me/timer',
  clone_url: 'https://github.com/me/timer.git',
});

describe('github client', () => {
  it('authenticates and reads the viewer', async () => {
    const { client, calls } = makeClient({ '/user': { status: 200, body: '{"login":"me"}' } });
    expect(await client.viewer()).toEqual({ login: 'me' });
    expect(calls[0].url).toBe('https://api.github.com/user');
  });

  it('creates a repo', async () => {
    const { client, calls } = makeClient({ '/user/repos': { status: 201, body: repoBody } });
    const repo = await client.createRepo('timer', { private: true, description: 'd' });
    expect(repo.fullName).toBe('me/timer');
    expect(JSON.parse(calls[0].body!)).toMatchObject({ name: 'timer', private: true, auto_init: true });
  });

  it('raises a typed error on 4xx with the body attached', async () => {
    const { client } = makeClient({ '/repos/me/timer': { status: 403, body: '{"message":"rate limited"}' } });
    await expect(client.getRepo('me/timer')).rejects.toBeInstanceOf(GitHubError);
  });

  it('publishes files as one commit through the git data api', async () => {
    const { client, calls } = makeClient({
      '/repos/me/timer/git/ref/heads/main': { status: 200, body: '{"object":{"sha":"base-sha"}}' },
      '/repos/me/timer/git/commits/base-sha': { status: 200, body: '{"tree":{"sha":"base-tree"}}' },
      '/repos/me/timer/git/trees': { status: 201, body: '{"sha":"new-tree"}' },
      '/repos/me/timer/git/commits': { status: 201, body: '{"sha":"new-commit"}' },
      '/repos/me/timer/git/refs/heads/main': { status: 200, body: '{}' },
      '/repos/me/timer': { status: 200, body: repoBody },
    });
    const result = await client.publishFiles('me/timer', [{ path: 'app/Main.kt', content: 'fun main() {}' }], 'feat: app');
    expect(result.commitSha).toBe('new-commit');
    const treeCall = calls.find((call) => call.url.endsWith('/git/trees'));
    expect(JSON.parse(treeCall!.body!)).toMatchObject({ base_tree: 'base-tree' });
  });

  it('dispatches a workflow and lists runs', async () => {
    const { client, calls } = makeClient({
      '/actions/workflows/build-apk.yml/dispatches': { status: 204, body: '' },
      '/actions/runs': {
        status: 200,
        body: JSON.stringify({
          workflow_runs: [
            { id: 7, name: 'Build APK', status: 'completed', conclusion: 'success', head_branch: 'main', html_url: 'u', created_at: 'now' },
          ],
        }),
      },
    });
    await client.dispatchWorkflow('me/timer', 'build-apk.yml', 'main');
    expect(JSON.parse(calls[0].body!)).toEqual({ ref: 'main', inputs: {} });
    const runs = await client.listWorkflowRuns('me/timer', { branch: 'main' });
    expect(runs[0].conclusion).toBe('success');
  });

  it('lists artifacts and follows the download redirect', async () => {
    const { client } = makeClient({
      '/actions/runs/7/artifacts': {
        status: 200,
        body: JSON.stringify({
          artifacts: [
            { id: 1, name: 'debug-apk', size_in_bytes: 1234, expired: false, archive_download_url: 'https://x' },
          ],
        }),
      },
      '/actions/artifacts/1/zip': { status: 302, body: '', headers: { location: 'https://signed.example/zip' } },
    });
    const artifacts = await client.listArtifacts('me/timer', 7);
    expect(artifacts[0].name).toBe('debug-apk');
    const download = await client.downloadArtifact('me/timer', 1);
    expect(download.location).toBe('https://signed.example/zip');
  });
});
