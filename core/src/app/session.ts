import type { Platform } from '../platform/types';
import type { ProviderEntry } from '../llm/router';
import { ProviderRouter } from '../llm/router';
import { OpenAiCompatibleClient } from '../llm/openai';
import { findPreset } from '../llm/providers';
import { ApprovalManager, type ApprovalHandler, type ApprovalMode } from '../agent/approval';
import { Orchestrator } from '../agent/orchestrator';
import { EventStore } from '../events/store';
import { ToolRegistry } from '../tools/registry';
import { ProjectMemoryStore } from '../memory/project';
import { SkillLibrary } from '../skills/loader';
import type { SkillSelection } from '../ecc/skills/loader';
import { hookCatalogue } from '../ecc/registry';
import { BUILT_IN_SKILLS } from '../ecc/skills/bundle';
import { Pipeline, commitMessage, type WorkspaceFile } from '../run/pipeline';
import type { RunState, ShipResult } from '../run/types';
import type { VerifyResult } from '../agent/orchestrator';
import type { AgentRole } from '../agent/definitions';
import { getAgent } from '../agent/definitions';
import { GitHubClient } from '../github/client';
import { monitorRun, findRunForCommit, trimCiLog } from '../ci/monitor';

/**
 * Wires the whole system for one project. Kept out of the UI layer so it stays
 * testable, and so screens talk to a small typed surface.
 */
export interface SessionConfig {
  platform: Platform;
  projectId: string;
  workspaceRoot: string;
  skillsRoot: string;
  providers: ProviderEntry[];
  approvalMode: ApprovalMode;
  approvalHandler?: ApprovalHandler;
  maxRoundsPerAgent?: number;
  github?: { token: string; owner: string; repo: string; branch?: string };
  pollIntervalMs?: number;
  /** Seed an empty workspace with the known-good Android skeleton. Default true. */
  seedScaffold?: boolean;
}

export class ProjectSession {
  readonly platform: Platform;
  readonly events: EventStore;
  readonly memory: ProjectMemoryStore;
  readonly skills: SkillLibrary;
  readonly approvals: ApprovalManager;
  readonly orchestrator: Orchestrator;
  readonly router: ProviderRouter;
  private readonly config: SessionConfig;
  private readonly runId: string;
  private readonly pipeline: Pipeline;
  /** Hooks available to this run, for the Settings screen. */
  static hooks() {
    return hookCatalogue();
  }

  /** Built-in ECC skills, for the Settings "Skills" manager. */
  static builtInSkills() {
    return BUILT_IN_SKILLS.map(({ name, summary, triggers, agents, licence }) => ({
      name,
      summary,
      triggers,
      agents,
      licence,
    }));
  }

  private currentState: RunState | null = null;
  /** Most recent skill selection, for the Build screen ("skills used"). */
  lastSkillSelection: SkillSelection | null = null;
  lastSkillAgent: string | null = null;
  /** Hooks that fired in this run, newest last. */
  readonly lastHooks: { id: string; exitCode: number; message?: string }[] = [];
  readonly blockedHooks: { id: string; exitCode: number; message?: string }[] = [];

  constructor(config: SessionConfig, runId = `run-${Date.now().toString(36)}`) {
    this.config = config;
    this.runId = runId;
    this.platform = config.platform;
    this.events = new EventStore(config.platform.kv, runId);
    this.memory = new ProjectMemoryStore(config.platform, config.workspaceRoot, config.projectId);
    this.skills = new SkillLibrary(config.platform, config.skillsRoot);
    this.approvals = new ApprovalManager(config.approvalMode, config.approvalHandler);
    this.router = new ProviderRouter({
      entries: config.providers,
      factory: (entry, model) =>
        new OpenAiCompatibleClient({
          platform: config.platform,
          config: entry.config,
          apiKey: entry.apiKey,
          model,
        }),
    });
    this.orchestrator = new Orchestrator({
      platform: config.platform,
      // The router is a drop-in LlmClient: it satisfies the interface
      // structurally, but providerId/model change per attempt, so we expose
      // read-only accessors instead of fixed strings.
      llm: () => ({
        providerId: this.router.activeProvider ?? 'unknown',
        model: 'auto',
        complete: (request) => this.router.complete(request),
      }),
      registry: ToolRegistry.standard(config.platform, config.workspaceRoot),
      approvals: this.approvals,
      events: this.events,
      workspaceRoot: config.workspaceRoot,
      maxRoundsPerAgent: config.maxRoundsPerAgent,
      extraContext: async () => this.memory.context(),
      // Per-task skill selection (ECC built-ins + the project's own skills) is
      // handled inside the orchestrator, so it can pick by trigger and agent.
      userSkills: () => this.skills.list(),
      onSkillsSelected: (agent, selection) => {
        this.lastSkillSelection = selection;
        this.lastSkillAgent = agent;
      },
      onHook: (applied) => {
        this.lastHooks.push(applied);
        if (applied.exitCode === 2) this.blockedHooks.push(applied);
      },
    });
    this.pipeline = new Pipeline({
      platform: config.platform,
      orchestrator: this.orchestrator,
      events: this.events,
      memory: this.memory,
      skills: this.skills,
      workspaceRoot: config.workspaceRoot,
      collectFiles: () => this.collectFiles(),
      localVerify: () => this.verifyLocally(),
      ship: (files, message) => this.ship(files, message),
      repairFromLogs: async (logs, attempt) => {
        await this.orchestrator.ask(
          'test-fixer',
          `CI failed (repair attempt ${attempt}/5). Fix the cause.\n\n${trimCiLog(logs)}`,
        );
      },
      saveState: (state) => this.saveState(state),
      seedScaffold: config.seedScaffold ?? true,
    });
  }

  get currentRunId(): string {
    return this.runId;
  }

  async collectFiles(): Promise<WorkspaceFile[]> {
    const root = this.config.workspaceRoot;
    const entries = await this.platform.fs.list(root, { recursive: true, includeDirs: false, maxEntries: 4000 });
    const files: WorkspaceFile[] = [];
    for (const entry of entries) {
      if (entry.size > 400_000) continue;
      if (/\.(png|jpg|jpeg|webp|apk|jar|zip|so|dex|class)$/i.test(entry.name)) continue;
      try {
        files.push({ path: entry.path.slice(root.length + 1), content: await this.platform.fs.read(entry.path) });
      } catch {
        continue;
      }
    }
    return files;
  }

  /**
   * Local verification. A phone has no JDK, so this checks the things that are
   * honestly checkable offline (project skeleton + CI workflow). Real
   * compilation happens in GitHub Actions - we never pretend otherwise.
   */
  async verifyLocally(): Promise<VerifyResult> {
    const entries = await this.platform.fs.list(this.config.workspaceRoot, { recursive: true, includeDirs: false });
    const paths = entries.map((entry) => entry.name);
    const hasSettings = paths.some((p) => /settings\.gradle(\.kts)?$/.test(p));
    const hasBuild = paths.some((p) => /(^|\/)build\.gradle(\.kts)?$/.test(p));
    const hasWorkflow = paths.some((p) => p.includes('.github/workflows/'));
    const missing = [
      !hasSettings ? 'settings.gradle.kts' : null,
      !hasBuild ? 'app/build.gradle.kts' : null,
      !hasWorkflow ? '.github/workflows/build-apk.yml' : null,
    ].filter(Boolean);
    if (missing.length) {
      return {
        ok: false,
        summary: `missing required project files: ${missing.join(', ')}`,
        output: `Files present:\n${paths.slice(0, 40).join('\n')}`,
      };
    }
    return { ok: true, summary: `project structure complete (${paths.length} files); compilation runs in CI`, output: '' };
  }

  private async ship(files: WorkspaceFile[], message: string): Promise<ShipResult> {
    const github = this.config.github;
    if (!github) {
      throw new Error('GitHub is not connected. Open Settings and sign in before shipping.');
    }
    const client = new GitHubClient({ platform: this.platform, token: github.token });
    const fullName = `${github.owner}/${github.repo}`;
    const published = await client.publishFiles(fullName, files, message, { branch: github.branch });
    const run = await findRunForCommit(client, fullName, published.branch, published.commitSha, {
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    if (!run) {
      return {
        repoFullName: fullName,
        branch: published.branch,
        commitSha: published.commitSha,
        commitMessage: message,
        ciStatus: 'not_started',
      };
    }
    const outcome = await monitorRun(run.id, {
      client,
      repoFullName: fullName,
      pollIntervalMs: this.config.pollIntervalMs ?? 10_000,
      onLog: (chunk) => {
        void this.events.append({ kind: 'log', detail: chunk.slice(-2000) });
      },
    });
    let apkLocalPath: string | undefined;
    if (outcome.apkArtifact) {
      const download = await client.downloadArtifact(fullName, outcome.apkArtifact.id);
      if (download.location) {
        apkLocalPath = await this.downloadToWorkspace(download.location, outcome.apkArtifact.name);
      }
    }
    return {
      repoFullName: fullName,
      branch: published.branch,
      commitSha: published.commitSha,
      commitMessage: message,
      ciRunId: run.id,
      ciStatus: outcome.status,
      ciUrl: run.htmlUrl,
      apkArtifactName: outcome.apkArtifact?.name,
      apkArtifactId: outcome.apkArtifact?.id,
      apkLocalPath,
    };
  }

  private async downloadToWorkspace(signedUrl: string, name: string): Promise<string> {
    const response = await this.platform.http({ url: signedUrl, method: 'GET', timeoutMs: 180_000 });
    if (response.status >= 400) throw new Error(`artifact download failed: ${response.status}`);
    const safeName = name.replace(/[^a-z0-9_-]/gi, '_');
    const target = `${this.config.workspaceRoot}/forgex-artifacts/${safeName}-${Date.now()}.zip`;
    await this.platform.fs.write(target, response.body);
    return target;
  }

  async run(request: string, options: { signal?: AbortSignal } = {}): Promise<RunState> {
    const existing = await this.loadState();
    const state: RunState = existing ?? {
      runId: this.runId,
      projectId: this.config.projectId,
      request,
      status: 'idle',
      completedSteps: [],
      repairAttempts: 0,
      createdAt: this.platform.now(),
      updatedAt: this.platform.now(),
    };
    state.request = request;
    const result = await this.pipeline.run(state, options);
    return result.state;
  }

  previewCommitMessage(request: string): string {
    const plan = this.currentState?.plan;
    if (!plan) return `feat: ${request.slice(0, 60)}`;
    return commitMessage(request, plan);
  }

  async saveState(state: RunState): Promise<void> {
    this.currentState = state;
    await this.platform.kv.set(`run/${state.runId}/state`, JSON.stringify(state));
  }

  async loadState(): Promise<RunState | null> {
    const raw = await this.platform.kv.get(`run/${this.runId}/state`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RunState;
    this.currentState = parsed;
    return parsed;
  }

  /** Resume after the app was killed: reloads state and continues the pipeline. */
  async resume(): Promise<RunState | null> {
    const state = await this.loadState();
    if (!state || ['done', 'failed', 'cancelled'].includes(state.status)) return state;
    const result = await this.pipeline.run(state, {});
    return result.state;
  }
}

export function presetEntry(presetId: string, apiKey: string, models?: string[]): ProviderEntry | null {
  const preset = findPreset(presetId);
  if (!preset) return null;
  return { config: preset, apiKey, models };
}

export function agentModelHint(role: AgentRole): 'fast' | 'strong' {
  return getAgent(role).modelHint;
}

/**
 * GitHub credentials arrive after construction (see UI: they are read from the
 * Keystore, which is async), so the session exposes an explicit setter.
 */
declare module './session' {
  interface ProjectSession {
    setGitHub(github: { token: string; owner: string; repo: string; branch?: string }): void;
  }
}

ProjectSession.prototype.setGitHub = function setGitHub(github) {
  (this as unknown as { config: SessionConfig }).config.github = github;
};
