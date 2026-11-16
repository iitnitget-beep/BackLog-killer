import type { GitHubClient, WorkflowRun, Artifact } from '../github/client';

export interface MonitorOptions {
  client: GitHubClient;
  repoFullName: string;
  /** Max wall-clock time to wait for the run to complete. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onLog?: (chunk: string) => void;
  onStatus?: (run: WorkflowRun) => void;
}

export interface CiOutcome {
  status: 'success' | 'failure' | 'timeout' | 'cancelled';
  run?: WorkflowRun;
  logs: string;
  artifacts: Artifact[];
  apkArtifact?: Artifact;
}

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls a workflow run to completion, collects logs and locates the APK
 * artifact. Used for both the initial build and each self-repair iteration.
 */
export async function monitorRun(runId: number, options: MonitorOptions): Promise<CiOutcome> {
  const sleep = options.sleep ?? DEFAULT_SLEEP;
  const timeoutMs = options.timeoutMs ?? 20 * 60_000;
  const interval = options.pollIntervalMs ?? 10_000;
  const started = Date.now();
  let run: WorkflowRun | undefined;
  while (Date.now() - started < timeoutMs) {
    run = await options.client.getRun(options.repoFullName, runId);
    options.onStatus?.(run);
    if (run.status === 'completed') break;
    await sleep(interval);
  }
  if (!run) {
    return { status: 'timeout', logs: '', artifacts: [] };
  }
  if (run.status !== 'completed') {
    return { status: 'timeout', run, logs: '', artifacts: [] };
  }
  const logs = await options.client.getJobLogs(options.repoFullName, runId).catch(() => '');
  options.onLog?.(logs);
  const artifacts = await options.client.listArtifacts(options.repoFullName, runId).catch(() => []);
  const apkArtifact = artifacts.find((artifact) => /apk/i.test(artifact.name) && !artifact.expired);
  const status = run.conclusion === 'success' ? 'success' : run.conclusion === 'cancelled' ? 'cancelled' : 'failure';
  return { status, run, logs, artifacts, apkArtifact };
}

/** Waits for the run that our dispatch created (GitHub has no direct id back). */
export async function findRunForCommit(
  client: GitHubClient,
  repoFullName: string,
  branch: string,
  commitSha: string,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<WorkflowRun | null> {
  const sleep = options.sleep ?? DEFAULT_SLEEP;
  const attempts = options.attempts ?? 12;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const runs = await client.listWorkflowRuns(repoFullName, { branch, perPage: 10 });
    // Exact match on the commit we just published.
    const exact = runs.find((run) => run.headSha === commitSha);
    if (exact) return exact;
    // GitHub only populates head_sha once the run is queued; after a short grace
    // period the newest run on our branch is the one our dispatch created.
    const newest = runs.find((run) => run.headBranch === branch);
    if (attempt >= 1 && newest) return newest;
    await sleep(5_000);
  }
  return null;
}

/**
 * Extracts the actionable part of a CI log so the test-fixer prompt stays small.
 * Gradle output is mostly noise; we keep error/exception/failure blocks.
 */
export function trimCiLog(raw: string, maxChars = 12_000): string {
  const lines = raw.split('\n');
  const interesting: string[] = [];
  const patterns = [
    /error:/i,
    /FAILURE/i,
    /What went wrong/i,
    /Execution failed/i,
    /Exception/i,
    /e: /,
    /Caused by/i,
    /^> /,
    /Could not resolve/i,
    /Unresolved reference/i,
  ];
  for (let index = 0; index < lines.length; index += 1) {
    if (patterns.some((pattern) => pattern.test(lines[index]))) {
      interesting.push(...lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 6)));
    }
  }
  const unique = [...new Set(interesting)].join('\n');
  const selected = unique.length > 200 ? unique : raw.slice(-maxChars);
  return selected.slice(-maxChars);
}
