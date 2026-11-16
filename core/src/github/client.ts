import type { Platform } from '../platform/types';

/**
 * Minimal GitHub REST client. It is deliberately small: only the calls ForgeX
 * needs, all through the Platform HTTP port so the Android bridge can inject the
 * OAuth token from Keystore rather than the JS layer holding it.
 */
export interface GitHubClientOptions {
  platform: Platform;
  token: string;
  apiBase?: string;
  userAgent?: string;
}

export interface GitHubRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
  cloneUrl: string;
}

export interface WorkflowRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | string;
  conclusion: string | null;
  headBranch: string;
  /** Commit the run was built from - used to match our dispatch to its run. */
  headSha: string;
  htmlUrl: string;
  createdAt: string;
}

export interface Artifact {
  id: number;
  name: string;
  sizeInBytes: number;
  expired: boolean;
  archiveDownloadUrl: string;
}

export class GitHubError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
    this.name = 'GitHubError';
  }
}

export class GitHubClient {
  private readonly apiBase: string;
  constructor(private readonly options: GitHubClientOptions) {
    this.apiBase = options.apiBase ?? 'https://api.github.com';
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; accept?: string } = {},
  ): Promise<T> {
    const response = await this.options.platform.http({
      url: path.startsWith('http') ? path : `${this.apiBase}${path}`,
      method: (init.method as 'GET') ?? 'GET',
      headers: {
        accept: init.accept ?? 'application/vnd.github+json',
        authorization: `Bearer ${this.options.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': this.options.userAgent ?? 'ForgeX',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      timeoutMs: 60_000,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new GitHubError(
        `GitHub ${init.method ?? 'GET'} ${path} failed: ${response.status}`,
        response.status,
        response.body.slice(0, 1000),
      );
    }
    if (!response.body) return {} as T;
    return JSON.parse(response.body) as T;
  }

  async viewer(): Promise<{ login: string }> {
    return this.request<{ login: string }>('/user');
  }

  async createRepo(name: string, options: { private?: boolean; description?: string } = {}): Promise<GitHubRepo> {
    const repo = await this.request<{
      full_name: string;
      default_branch: string;
      private: boolean;
      html_url: string;
      clone_url: string;
    }>('/user/repos', {
      method: 'POST',
      body: { name, private: options.private ?? false, description: options.description, auto_init: true },
    });
    return {
      fullName: repo.full_name,
      defaultBranch: repo.default_branch,
      private: repo.private,
      htmlUrl: repo.html_url,
      cloneUrl: repo.clone_url,
    };
  }

  async getRepo(fullName: string): Promise<GitHubRepo> {
    const repo = await this.request<{
      full_name: string;
      default_branch: string;
      private: boolean;
      html_url: string;
      clone_url: string;
    }>(`/repos/${fullName}`);
    return {
      fullName: repo.full_name,
      defaultBranch: repo.default_branch,
      private: repo.private,
      htmlUrl: repo.html_url,
      cloneUrl: repo.clone_url,
    };
  }

  /**
   * Publishes a set of files as one commit using the Git Data API. This avoids
   * needing a real git binary on the phone: we build a tree, commit it, and move
   * the branch ref.
   */
  async publishFiles(
    fullName: string,
    files: { path: string; content: string }[],
    message: string,
    options: { branch?: string; baseBranch?: string } = {},
  ): Promise<{ commitSha: string; branch: string }> {
    const repo = await this.getRepo(fullName);
    const branch = options.branch ?? repo.defaultBranch;
    const base = options.baseBranch ?? repo.defaultBranch;
    const baseRef = await this.request<{ object: { sha: string } }>(`/repos/${fullName}/git/ref/heads/${base}`);
    const baseCommit = await this.request<{ tree: { sha: string } }>(`/repos/${fullName}/git/commits/${baseRef.object.sha}`);
    const tree = await this.request<{ sha: string }>(`/repos/${fullName}/git/trees`, {
      method: 'POST',
      body: {
        base_tree: baseCommit.tree.sha,
        tree: files.map((file) => ({
          path: file.path,
          mode: '100644',
          type: 'blob',
          content: file.content,
        })),
      },
    });
    const commit = await this.request<{ sha: string }>(`/repos/${fullName}/git/commits`, {
      method: 'POST',
      body: { message, tree: tree.sha, parents: [baseRef.object.sha] },
    });
    if (branch === base) {
      await this.request(`/repos/${fullName}/git/refs/heads/${branch}`, {
        method: 'PATCH',
        body: { sha: commit.sha, force: false },
      });
    } else {
      await this.request(`/repos/${fullName}/git/refs`, {
        method: 'POST',
        body: { ref: `refs/heads/${branch}`, sha: commit.sha },
      });
    }
    return { commitSha: commit.sha, branch };
  }

  async dispatchWorkflow(fullName: string, workflowFile: string, ref: string, inputs: Record<string, string> = {}): Promise<void> {
    await this.request(`/repos/${fullName}/actions/workflows/${workflowFile}/dispatches`, {
      method: 'POST',
      body: { ref, inputs },
    });
  }

  async listWorkflowRuns(fullName: string, options: { branch?: string; perPage?: number } = {}): Promise<WorkflowRun[]> {
    const params = new URLSearchParams();
    if (options.branch) params.set('branch', options.branch);
    params.set('per_page', String(options.perPage ?? 10));
    const data = await this.request<{
      workflow_runs: {
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        head_branch: string;
        head_sha: string;
        html_url: string;
        created_at: string;
      }[];
    }>(`/repos/${fullName}/actions/runs?${params.toString()}`);
    return data.workflow_runs.map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      headBranch: run.head_branch,
      headSha: run.head_sha,
      htmlUrl: run.html_url,
      createdAt: run.created_at,
    }));
  }

  async getRun(fullName: string, runId: number): Promise<WorkflowRun> {
    const run = await this.request<{
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      head_branch: string;
      head_sha: string;
      html_url: string;
      created_at: string;
    }>(`/repos/${fullName}/actions/runs/${runId}`);
    return {
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      headBranch: run.head_branch,
      headSha: run.head_sha,
      htmlUrl: run.html_url,
      createdAt: run.created_at,
    };
  }

  async listArtifacts(fullName: string, runId: number): Promise<Artifact[]> {
    const data = await this.request<{
      artifacts: { id: number; name: string; size_in_bytes: number; expired: boolean; archive_download_url: string }[];
    }>(`/repos/${fullName}/actions/runs/${runId}/artifacts`);
    return data.artifacts.map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      sizeInBytes: artifact.size_in_bytes,
      expired: artifact.expired,
      archiveDownloadUrl: artifact.archive_download_url,
    }));
  }

  /** Downloads an artifact zip. GitHub requires following a redirect. */
  async downloadArtifact(fullName: string, artifactId: number): Promise<{ status: number; location?: string }> {
    const response = await this.options.platform.http({
      url: `${this.apiBase}/repos/${fullName}/actions/artifacts/${artifactId}/zip`,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        accept: 'application/vnd.github+json',
        'user-agent': this.options.userAgent ?? 'ForgeX',
      },
      timeoutMs: 60_000,
    });
    if (response.status !== 302 && (response.status < 200 || response.status >= 400)) {
      throw new GitHubError(`artifact download failed: ${response.status}`, response.status, response.body.slice(0, 400));
    }
    const location = response.headers['location'];
    if (response.status === 302 && !location) {
      throw new GitHubError('artifact redirect had no location header', 302, '');
    }
    return { status: response.status, location };
  }

  async getJobLogs(fullName: string, runId: number): Promise<string> {
    const jobs = await this.request<{
      jobs: { id: number; name: string; conclusion: string | null }[];
    }>(`/repos/${fullName}/actions/runs/${runId}/jobs`);
    const logs: string[] = [];
    for (const job of jobs.jobs) {
      try {
        const response = await this.options.platform.http({
          url: `${this.apiBase}/repos/${fullName}/actions/jobs/${job.id}/logs`,
          headers: {
            authorization: `Bearer ${this.options.token}`,
            accept: 'application/vnd.github+json',
            'user-agent': this.options.userAgent ?? 'ForgeX',
          },
          timeoutMs: 60_000,
        });
        if (response.status < 400) logs.push(`### ${job.name} (${job.conclusion})\n${response.body}`);
      } catch {
        logs.push(`### ${job.name}: log unavailable`);
      }
    }
    return logs.join('\n\n');
  }
}
