import { resolvePlatform } from './browserPlatform';
import type { Platform } from '../platform/types';
import { ProjectSession, presetEntry } from '../app/session';
import type { RunState } from '../run/types';
import { renderPlanMarkdown, updatePlanStep, removePlanStep, type PlanDraft } from '../run/plan';
import type { RunStepName } from '../run/types';
import { PROVIDER_PRESETS } from '../llm/providers';
import type { ApprovalMode } from '../agent/approval';
import { scanText } from '../security/scanner';
import { toTimeline } from '../events/store';
import type { ForgeEvent } from '../events/types';
import { GitHubDeviceFlow } from '../github/oauth';
import { GitHubClient } from '../github/client';
import { SkillLibrary } from '../skills/loader';
import { renderHighlighted } from './highlight';
import { diffLines } from './diff';

/**
 * ForgeX UI shell.
 *
 * Deliberately dependency-free (no framework) so the bundle stays small on a
 * low-end phone and the whole app is one file the Kotlin shell can load.
 */

interface Settings {
  presetId: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  approvalMode: ApprovalMode;
  githubOwner: string;
  githubRepo: string;
}

interface ProjectRecord {
  id: string;
  name: string;
  request: string;
  updatedAt: number;
  status: string;
}

interface AppState {
  platform: Platform;
  mode: 'android' | 'browser-preview';
  note: string;
  screen: 'home' | 'build' | 'workspace' | 'ship' | 'settings';
  settings: Settings;
  projects: ProjectRecord[];
  activeProjectId: string | null;
  request: string;
  session: ProjectSession | null;
  runState: RunState | null;
  events: ForgeEvent[];
  busy: false | 'planning' | 'running' | 'paused';
  abort: AbortController | null;
  pendingApproval: { toolName: string; description: string; args: Record<string, unknown> } | null;
  logs: string[];
  workspaceTab: 'files' | 'code' | 'diff' | 'log';
  openFile: string | null;
  previousFile: string | null;
  toast: string | null;
  confirm: { title: string; body: string; onConfirm: () => void } | null;
  skills: { name: string; path: string }[];
  githubUser: string | null;
  deviceFlow: { userCode: string; verificationUri: string } | null;
  fileTree: { name: string; type: string; path: string }[];
  openFileContent: string;
}

const SETTINGS_KEY = 'forgex/settings';
const PROJECTS_KEY = 'forgex/projects';

const state: AppState = {
  platform: null as unknown as Platform,
  mode: 'browser-preview',
  note: '',
  screen: 'home',
  settings: {
    presetId: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'qwen/qwen3-coder:free',
    apiKey: '',
    approvalMode: 'ASK',
    githubOwner: '',
    githubRepo: '',
  },
  projects: [],
  activeProjectId: null,
  request: '',
  session: null,
  runState: null,
  events: [],
  busy: false,
  abort: null,
  pendingApproval: null,
  logs: [],
  workspaceTab: 'files',
  openFile: null,
  previousFile: null,
  toast: null,
  confirm: null,
  skills: [],
  githubUser: null,
  deviceFlow: null,
  fileTree: [],
  openFileContent: '',
};

const el = (id: string) => document.getElementById(id);
const esc = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

async function boot(): Promise<void> {
  const choice = resolvePlatform();
  state.platform = choice.platform;
  state.mode = choice.mode;
  state.note = choice.note;
  const savedSettings = await choice.platform.kv.get(SETTINGS_KEY);
  if (savedSettings) state.settings = { ...state.settings, ...(JSON.parse(savedSettings) as Settings) };
  const savedProjects = await choice.platform.kv.get(PROJECTS_KEY);
  if (savedProjects) state.projects = JSON.parse(savedProjects) as ProjectRecord[];
  await refreshSkills();
  render();
}

function toast(message: string): void {
  state.toast = message;
  render();
  setTimeout(() => {
    if (state.toast === message) {
      state.toast = null;
      render();
    }
  }, 3200);
}

async function saveSettings(): Promise<void> {
  await state.platform.kv.set(SETTINGS_KEY, JSON.stringify(state.settings));
}

async function saveProjects(): Promise<void> {
  await state.platform.kv.set(PROJECTS_KEY, JSON.stringify(state.projects));
}

async function refreshSkills(): Promise<void> {
  const library = new SkillLibrary(state.platform, '/workspace/demo/.forgex/skills');
  state.skills = (await library.list()).map((skill) => ({ name: skill.name, path: skill.path }));
}

function workspaceRoot(): string {
  return `/workspace/${state.activeProjectId ?? 'demo'}`;
}

function buildSession(): ProjectSession {
  const providers = state.settings.apiKey
    ? [presetEntry(state.settings.presetId, state.settings.apiKey) ?? {
        config: {
          id: 'custom',
          label: 'Custom',
          baseUrl: state.settings.baseUrl,
          defaultModel: state.settings.model,
        },
        apiKey: state.settings.apiKey,
        models: [state.settings.model],
      }]
    : [];
  const session = new ProjectSession({
    platform: state.platform,
    projectId: state.activeProjectId ?? 'demo',
    workspaceRoot: workspaceRoot(),
    skillsRoot: '/workspace/demo/.forgex/skills',
    providers,
    approvalMode: state.settings.approvalMode,
    approvalHandler: async (request) => {
      state.pendingApproval = { toolName: request.toolName, description: request.description, args: request.args };
      render();
      return new Promise((resolve) => {
        (window as unknown as { __approve: (allow: boolean) => void }).__approve = (allow: boolean) => {
          state.pendingApproval = null;
          render();
          resolve({ approved: allow, remember: false });
        };
      });
    },
  });
  return session;
}

/**
 * The GitHub token lives in the Keystore, which is async, so it is attached to
 * the session after construction instead of being read inside it.
 */
async function syncGithubToken(session: ProjectSession): Promise<void> {
  if (!state.settings.githubOwner || !state.settings.githubRepo) return;
  const token = await state.platform.secrets.get('github/token');
  if (!token) return;
  session.setGitHub({ token, owner: state.settings.githubOwner, repo: state.settings.githubRepo });
}

async function refreshEvents(): Promise<void> {
  if (!state.session) return;
  state.events = await state.session.events.all();
  state.runState = await state.session.loadState();
}

async function startRun(): Promise<void> {
  if (!state.request.trim()) {
    toast('Describe the app you want first.');
    return;
  }
  if (!state.settings.apiKey && state.mode === 'android') {
    toast('Add a model provider key in Settings first.');
    state.screen = 'settings';
    render();
    return;
  }
  const id = state.activeProjectId ?? `p${Date.now().toString(36)}`;
  state.activeProjectId = id;
  const project: ProjectRecord = {
    id,
    name: state.request.slice(0, 42) || 'Untitled build',
    request: state.request,
    updatedAt: Date.now(),
    status: 'running',
  };
  state.projects = [project, ...state.projects.filter((p) => p.id !== id)];
  await saveProjects();
  state.session = buildSession();
  await syncGithubToken(state.session);
  state.abort = new AbortController();
  state.busy = 'planning';
  state.logs = [];
  state.screen = 'build';
  render();
  try {
    const result = await state.session.run(state.request, { signal: state.abort.signal });
    state.runState = result;
    project.status = result.status;
    await saveProjects();
    await refreshEvents();
    toast(result.status === 'done' ? 'Run finished' : `Run ${result.status}`);
  } catch (error) {
    toast(`Run failed: ${(error as Error).message}`);
  } finally {
    state.busy = false;
    await refreshEvents();
    render();
  }
}

function render(): void {
  const app = el('app');
  if (!app) return;
  app.innerHTML = `
    ${renderTopbar()}
    <main>${renderScreen()}</main>
    ${renderTabs()}
    ${state.toast ? `<div class="toast">${esc(state.toast)}</div>` : ''}
    ${renderApproval()}
    ${renderConfirm()}
    ${renderDeviceFlow()}
  `;
  bind();
}

function renderTopbar(): string {
  const status = state.runState?.status;
  const badgeClass = status === 'done' ? 'ok' : status === 'failed' ? 'bad' : status ? 'warn' : '';
  return `
    <header class="topbar">
      <div class="logo">F</div>
      <h1>ForgeX</h1>
      <div class="spacer"></div>
      ${status ? `<span class="badge ${badgeClass}">${esc(status.replace('_', ' '))}</span>` : ''}
      <span class="badge ${state.mode === 'android' ? 'ok' : 'warn'}" title="${esc(state.note)}">
        ${state.mode === 'android' ? 'device' : 'preview'}
      </span>
    </header>`;
}

function renderScreen(): string {
  switch (state.screen) {
    case 'build': return renderBuild();
    case 'workspace': return renderWorkspace();
    case 'ship': return renderShip();
    case 'settings': return renderSettings();
    default: return renderHome();
  }
}

function renderTabs(): string {
  const tabs: { id: AppState['screen']; icon: string; label: string }[] = [
    { id: 'home', icon: '⌂', label: 'Home' },
    { id: 'build', icon: '⚡', label: 'Build' },
    { id: 'workspace', icon: '⌸', label: 'Files' },
    { id: 'ship', icon: '↑', label: 'Ship' },
    { id: 'settings', icon: '⚙', label: 'Settings' },
  ];
  return `<nav class="tabs"><div>${tabs
    .map((tab) => `<button data-nav="${tab.id}" class="${state.screen === tab.id ? 'active' : ''}">
      <span class="icon">${tab.icon}</span><span>${tab.label}</span></button>`)
    .join('')}</div></nav>`;
}

function renderHome(): string {
  return `
    <div class="card">
      <h3>What should ForgeX build?</h3>
      <p class="muted small">Describe an Android app in plain language. The agents plan it, write it, test it, review it, then push to GitHub and build a real APK in CI.</p>
      <textarea id="request" placeholder="e.g. A habit tracker with daily streaks, local storage and a dark theme">${esc(state.request)}</textarea>
      <div style="height:10px"></div>
      <button class="primary" id="start">New build</button>
      <p class="muted small" style="margin-bottom:0">${esc(state.note)}</p>
    </div>
    <div class="section-title">Projects</div>
    ${state.projects.length === 0
      ? `<div class="card muted small">No projects yet. Your first build will appear here and stay browsable offline.</div>`
      : state.projects
          .map(
            (project) => `<div class="project" data-project="${esc(project.id)}">
              <div>
                <div class="name">${esc(project.name)}</div>
                <div class="muted small">${new Date(project.updatedAt).toLocaleString()} · ${esc(project.status)}</div>
              </div>
              <span class="chip">open</span>
            </div>`,
          )
          .join('')}`;
}

function activeMarkers(): { plan: string; code: string; test: string; review: string; ship: string } {
  const completed = new Set(state.runState?.completedSteps ?? []);
  const events = state.events;
  const lastStarted = [...events].reverse().find((event) => event.kind === 'step_started') as
    | (ForgeEvent & { stepName?: string })
    | undefined;
  const active = lastStarted?.stepName;
  const marker = (name: RunStepName) => {
    const failed = events.some((event) => event.kind === 'step_finished' && (event as { ok?: boolean }).ok === false && (event as { stepName?: string }).stepName === name);
    if (failed) return 'bad';
    if (completed.has(name)) return 'ok';
    if (active === name) return 'active';
    return '';
  };
  return { plan: marker('plan'), code: marker('code'), test: marker('test'), review: marker('review'), ship: marker('ship') };
}

function renderTimelineRow(title: string, detail: string, marker: string, stepName: RunStepName): string {
  return `<div class="tl-item">
    <div class="tl-rail"><div class="tl-dot ${marker}"></div><div class="tl-line"></div></div>
    <div class="tl-body">
      <div class="tl-title">${esc(title)}</div>
      <div class="tl-detail">${esc(detail)}</div>
      ${marker === 'ok' ? `<button class="ghost small" data-rollback="${stepName}" style="margin-top:6px;padding:4px 9px;font-size:11px">Rollback to before this step</button>` : ''}
    </div>
  </div>`;
}

function renderBuild(): string {
  const markers = activeMarkers();
  const plan = state.runState?.plan;
  const lastMessages = state.events.filter((event) => event.kind === 'assistant_message').slice(-2) as (ForgeEvent & { content?: string })[];
  const agents = state.events.filter((event) => event.kind === 'agent_spawned').slice(-4) as (ForgeEvent & { summary?: string })[];
  return `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h3 style="margin:0">Run</h3>
        <div class="row">
          ${state.busy ? `<button class="ghost" id="pause">${state.busy === 'paused' ? 'Resume' : 'Pause'}</button>` : ''}
          ${state.busy ? `<button class="ghost danger" id="stop">Stop</button>` : `<button class="ghost" id="rerun">Run again</button>`}
        </div>
      </div>
      <div class="row" style="margin-top:10px;gap:6px;flex-wrap:wrap">
        <span class="chip">run ${esc(state.session?.currentRunId ?? 'none')}</span>
        <span class="chip">approval ${esc(state.settings.approvalMode)}</span>
        ${state.runState?.repairAttempts ? `<span class="chip">repairs ${state.runState.repairAttempts}/5</span>` : ''}
      </div>
      ${state.request ? `<p class="muted small" style="margin:10px 0 0">“${esc(state.request.slice(0, 160))}”</p>` : ''}
    </div>
    <div class="card">
      <h3>Agent timeline</h3>
      <div class="timeline">
        ${renderTimelineRow('Plan', plan ? `${plan.steps.length} steps · ${plan.summary}` : 'waiting for planner', markers.plan, 'plan')}
        ${renderTimelineRow('Code', plan ? plan.steps.map((step) => step.title).join(' · ') : 'editors not started', markers.code, 'code')}
        ${renderTimelineRow('Test', state.runState?.completedSteps.includes('test') ? 'verification recorded' : 'pending', markers.test, 'test')}
        ${renderTimelineRow('Review', 'fresh-context review + security pass', markers.review, 'review')}
        ${renderTimelineRow('Ship', state.runState?.ship ? `CI ${state.runState.ship.ciStatus ?? 'pending'}` : 'not pushed yet', markers.ship, 'ship')}
      </div>
      ${agents.length ? `<div class="section-title">Recent agents</div>${agents.map((agent) => `<div class="muted small">· ${esc(agent.summary ?? 'agent')}</div>`).join('')}` : ''}
      ${lastMessages.length ? `<div class="section-title">Agent said</div>${lastMessages.map((message) => `<div class="muted small" style="margin-bottom:6px">${esc((message.content ?? '').slice(0, 300))}</div>`).join('')}` : ''}
    </div>
    ${plan ? renderPlanCard(plan) : ''}
    <div class="card">
      <div class="row" style="justify-content:space-between"><h3 style="margin:0">Live log</h3><span class="muted small">${state.events.length} events</span></div>
      <div class="log" style="margin-top:8px">${esc(
        toTimeline(state.events.slice(-40)).map((entry) => `${String(entry.seq).padStart(3, ' ')}  ${entry.label}`).join('\n') || 'No events yet.',
      )}</div>
    </div>`;
}

function renderPlanCard(plan: PlanDraft): string {
  const locked = state.busy === 'running';
  return `<div class="card">
    <div class="row" style="justify-content:space-between"><h3 style="margin:0">Plan (editable)</h3><span class="chip">${plan.steps.length} steps</span></div>
    <p class="muted small">${esc(plan.summary)}</p>
    <ol class="steps">
      ${plan.steps
        .map(
          (step) => `<li>
            <div class="row" style="gap:6px">
              <input data-step-input="${step.id}" value="${esc(step.title)}" ${locked ? 'disabled' : ''} style="padding:7px 9px;font-size:13px" />
              ${locked ? '' : `<button class="ghost" data-step-remove="${step.id}" style="padding:6px 9px">×</button>`}
            </div>
            <div class="muted small">${esc(step.files.join(', ') || 'files chosen by the editor')} — done when ${esc(step.doneWhen)}</div>
          </li>`,
        )
        .join('')}
    </ol>
    ${plan.risks.length ? `<div class="small" style="color:var(--warn)">Risks: ${esc(plan.risks.join('; '))}</div>` : ''}
    <div class="small muted">Verify: ${esc(plan.verify.join(' · '))}</div>
    <div style="height:8px"></div>
    <div class="row">
      ${locked ? '' : `<button class="ghost" id="apply-plan">Apply plan edits</button>`}
      <button class="ghost" id="copy-plan">Copy markdown</button>
    </div>
  </div>`;
}

function renderWorkspace(): string {
  return `
    <div class="tab-scroll">
      ${(['files', 'code', 'diff', 'log'] as const)
        .map((tab) => `<button class="ghost ${state.workspaceTab === tab ? 'primary' : ''}" data-wtab="${tab}">${tab}</button>`)
        .join('')}
    </div>
    <div class="card" id="workspace-body">${renderWorkspaceBody()}</div>`;
}

function renderWorkspaceBody(): string {
  if (state.workspaceTab === 'log') {
    return `<h3>Pipeline log</h3><div class="log">${esc(state.logs.slice(-200).join('\n') || 'No log output yet.')}</div>`;
  }
  if (state.workspaceTab === 'code') {
    if (!state.openFile) return `<p class="muted small">Pick a file from the Files tab to view it.</p>`;
    const content = state.openFileContent ?? '';
    return `<div class="row" style="justify-content:space-between"><h3 style="margin:0">${esc(state.openFile)}</h3><span class="chip">${content.split('\n').length} lines</span></div>
      ${renderHighlighted(content, state.openFile)}`;
  }
  if (state.workspaceTab === 'diff') {
    if (!state.openFile || state.previousFile === null) return `<p class="muted small">Open a file after an edit to see its previous and current versions side by side.</p>`;
    return `<h3>Diff · ${esc(state.openFile)}</h3>${diffLines(state.previousFile, state.openFileContent ?? '')}`;
  }
  return `<h3>Workspace</h3>
    <p class="muted small">${esc(workspaceRoot())}</p>
    <div class="tree" id="tree">${state.fileTree.length ? renderTree(state.fileTree) : '<span class="muted small">Loading…</span>'}</div>`;
}

function renderTree(entries: { name: string; type: string; path: string }[]): string {
  return entries
    .map((entry) =>
      entry.type === 'dir'
        ? `<div class="dir">▸ ${esc(entry.name)}</div>`
        : `<span class="file" data-file="${esc(entry.path)}">· ${esc(entry.name)}</span>`,
    )
    .join('\n');
}

function renderShip(): string {
  const ship = state.runState?.ship;
  return `
    <div class="card">
      <h3>Ship</h3>
      ${ship
        ? `<div class="kv"><span>Repo</span><span>${esc(ship.repoFullName)}</span></div>
           <div class="kv"><span>Branch</span><span>${esc(ship.branch)}</span></div>
           <div class="kv"><span>Commit</span><span>${esc(ship.commitSha.slice(0, 12))}</span></div>
           <div class="kv"><span>CI</span><span class="badge ${ship.ciStatus === 'success' ? 'ok' : ship.ciStatus === 'failure' ? 'bad' : 'warn'}">${esc(ship.ciStatus ?? 'unknown')}</span></div>
           ${ship.ciUrl ? `<div class="kv"><span>Run</span><span class="small">${esc(ship.ciUrl)}</span></div>` : ''}
           ${ship.apkArtifactName ? `<div class="kv"><span>Artifact</span><span>${esc(ship.apkArtifactName)}</span></div>` : ''}
           <div class="row" style="margin-top:12px">
             <button class="primary" id="install-apk" ${ship.apkLocalPath ? '' : 'disabled'}>Download & install APK</button>
           </div>
           ${ship.apkLocalPath ? `<p class="muted small">Saved to ${esc(ship.apkLocalPath)}</p>` : `<p class="muted small">The APK is downloaded from the CI artifact when the run finishes.</p>`}`
        : `<p class="muted small">Nothing shipped yet. Finish a build on the Build screen and ForgeX pushes it here.</p>`}
    </div>
    <div class="card">
      <h3>Commit message</h3>
      <textarea id="commit-msg">${esc(state.session?.previewCommitMessage(state.request) ?? `feat: ${state.request.slice(0, 60)}`)}</textarea>
      <div style="height:10px"></div>
      <button class="ghost" id="copy-commit">Copy</button>
    </div>
    <div class="card">
      <h3>GitHub</h3>
      ${state.githubUser
        ? `<div class="kv"><span>Signed in as</span><span>${esc(state.githubUser)}</span></div>`
        : `<p class="muted small">Not signed in. Device-flow login keeps the token in the Android Keystore.</p>
           <button class="ghost" id="github-login">Sign in with GitHub</button>`}
      <div style="height:10px"></div>
      <label class="field"><span>Owner</span><input id="gh-owner" value="${esc(state.settings.githubOwner)}" placeholder="your-username" /></label>
      <label class="field"><span>Repository</span><input id="gh-repo" value="${esc(state.settings.githubRepo)}" placeholder="forgex-app" /></label>
      <button class="ghost" id="save-github">Save repo target</button>
    </div>`;
}

function renderSettings(): string {
  return `
    <div class="card">
      <h3>Model provider</h3>
      <label class="field"><span>Preset</span>
        <select id="preset">
          ${PROVIDER_PRESETS.map((preset) => `<option value="${preset.id}" ${state.settings.presetId === preset.id ? 'selected' : ''}>${esc(preset.label)}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>Base URL</span><input id="base-url" value="${esc(state.settings.baseUrl)}" /></label>
      <label class="field"><span>Model</span><input id="model" value="${esc(state.settings.model)}" /></label>
      <label class="field"><span>API key (stored in Keystore on device)</span><input id="api-key" type="password" value="${esc(state.settings.apiKey)}" placeholder="sk-…" /></label>
      <button class="ghost" id="save-settings">Save</button>
    </div>
    <div class="card">
      <h3>Approval mode</h3>
      ${(['ASK', 'AUTO_EDIT', 'FULL_AUTO'] as const)
        .map(
          (mode) => `<div class="switch"><span>${mode === 'ASK' ? 'Ask before every change' : mode === 'AUTO_EDIT' ? 'Auto-approve file edits' : 'Full auto (commands too)'}</span>
            <input type="radio" name="approval" value="${mode}" ${state.settings.approvalMode === mode ? 'checked' : ''} style="width:auto" /></div>`,
        )
        .join('')}
      <p class="muted small">Destructive commands (force push, deleting branches) always need explicit confirmation, in every mode.</p>
    </div>
    <div class="card">
      <h3>Skills & microagents</h3>
      <p class="muted small">Markdown files in .forgex/skills. Files with triggers load only when the task matches.</p>
      ${state.skills.length ? state.skills.map((skill) => `<div class="kv"><span>${esc(skill.name)}</span><span class="small muted">${esc(skill.path.split('/').pop())}</span></div>`).join('') : '<p class="muted small">No skills yet.</p>'}
      <button class="ghost" id="new-skill">New skill</button>
    </div>
    <div class="card">
      <h3>Secrets</h3>
      <p class="muted small">Keys never enter git. Before every push, ForgeX scans the workspace for credentials and blocks the push if it finds any.</p>
      <button class="ghost" id="scan-now">Scan workspace now</button>
    </div>
    <div class="card">
      <h3>About</h3>
      <div class="kv"><span>Platform</span><span>${esc(state.mode)}</span></div>
      <div class="kv"><span>Approval</span><span>${esc(state.settings.approvalMode)}</span></div>
      <div class="kv"><span>Provider</span><span>${esc(state.settings.presetId)}</span></div>
    </div>`;
}

function renderApproval(): string {
  if (!state.pendingApproval) return '';
  return `<div class="modal-backdrop"><div class="modal">
    <h3>Approve action?</h3>
    <p class="small">${esc(state.pendingApproval.description)}</p>
    <pre class="code" style="max-height:120px">${esc(JSON.stringify(state.pendingApproval.args, null, 2).slice(0, 600))}</pre>
    <div class="row" style="margin-top:12px">
      <button class="primary" id="approve-yes">Allow</button>
      <button class="ghost" id="approve-no">Deny</button>
    </div>
  </div></div>`;
}

function renderConfirm(): string {
  if (!state.confirm) return '';
  return `<div class="modal-backdrop"><div class="modal">
    <h3>${esc(state.confirm.title)}</h3>
    <p class="small">${esc(state.confirm.body)}</p>
    <div class="row" style="margin-top:12px">
      <button class="ghost danger" id="confirm-yes">Yes, continue</button>
      <button class="ghost" id="confirm-no">Cancel</button>
    </div>
  </div></div>`;
}

function renderDeviceFlow(): string {
  if (!state.deviceFlow) return '';
  return `<div class="modal-backdrop"><div class="modal">
    <h3>Sign in to GitHub</h3>
    <p class="small">Open <strong>${esc(state.deviceFlow.verificationUri)}</strong> on any device and enter:</p>
    <p style="font-family:var(--mono);font-size:24px;letter-spacing:3px;text-align:center">${esc(state.deviceFlow.userCode)}</p>
    <p class="muted small">Waiting for authorisation…</p>
    <button class="ghost" id="cancel-device">Cancel</button>
  </div></div>`;
}

function bind(): void {
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach((node) =>
    node.addEventListener('click', () => {
      state.screen = node.dataset.nav as AppState['screen'];
      if (state.screen === 'workspace') void loadWorkspace();
      render();
    }),
  );
  const requestInput = el('request') as HTMLTextAreaElement | null;
  requestInput?.addEventListener('input', () => (state.request = requestInput.value));
  el('start')?.addEventListener('click', () => void startRun());
  el('stop')?.addEventListener('click', () => {
    state.confirm = {
      title: 'Stop this run?',
      body: 'In-progress agent work is discarded. Completed file edits stay in the workspace.',
      onConfirm: () => {
        state.abort?.abort();
        state.confirm = null;
        render();
      },
    };
    render();
  });
  el('pause')?.addEventListener('click', () => {
    state.busy = state.busy === 'paused' ? 'planning' : 'paused';
    toast(state.busy === 'paused' ? 'Paused: approvals are queued until you resume.' : 'Resumed.');
  });
  el('rerun')?.addEventListener('click', () => void startRun());
  el('apply-plan')?.addEventListener('click', () => void applyPlanEdits());
  el('copy-plan')?.addEventListener('click', () => {
    if (state.runState?.plan) void navigator.clipboard?.writeText(renderPlanMarkdown(state.runState.plan));
    toast('Plan copied.');
  });
  document.querySelectorAll<HTMLElement>('[data-step-remove]').forEach((node) =>
    node.addEventListener('click', () => {
      if (!state.runState?.plan) return;
      state.runState.plan = removePlanStep(state.runState.plan, Number(node.dataset.stepRemove));
      render();
    }),
  );
  document.querySelectorAll<HTMLElement>('[data-rollback]').forEach((node) =>
    node.addEventListener('click', () => {
      const stepName = node.dataset.rollback!;
      state.confirm = {
        title: `Rollback before "${stepName}"?`,
        body: 'Marks the plan as unfinished from this step so the next run redoes it. Files are not deleted automatically.',
        onConfirm: async () => {
          if (state.runState) {
            state.runState.completedSteps = state.runState.completedSteps.filter((step) => step !== stepName);
            state.runState.status = 'paused';
            await state.session?.saveState(state.runState);
          }
          state.confirm = null;
          toast('Rolled back.');
          render();
        },
      };
      render();
    }),
  );
  document.querySelectorAll<HTMLElement>('[data-wtab]').forEach((node) =>
    node.addEventListener('click', () => {
      state.workspaceTab = node.dataset.wtab as AppState['workspaceTab'];
      if (state.workspaceTab !== 'log') void loadWorkspace();
      render();
    }),
  );
  document.querySelectorAll<HTMLElement>('[data-file]').forEach((node) =>
    node.addEventListener('click', () => void openFile(node.dataset.file!)),
  );
  document.querySelectorAll<HTMLElement>('[data-project]').forEach((node) =>
    node.addEventListener('click', () => void openProject(node.dataset.project!)),
  );
  el('save-settings')?.addEventListener('click', () => void persistSettings());
  document.querySelectorAll<HTMLInputElement>('input[name="approval"]').forEach((node) =>
    node.addEventListener('change', () => {
      state.settings.approvalMode = node.value as ApprovalMode;
      void saveSettings();
      toast(`Approval mode: ${node.value}`);
    }),
  );
  (el('preset') as HTMLSelectElement | null)?.addEventListener('change', (event) => {
    const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === (event.target as HTMLSelectElement).value);
    if (!preset) return;
    state.settings.presetId = preset.id;
    state.settings.baseUrl = preset.baseUrl;
    state.settings.model = preset.defaultModel;
    render();
  });
  el('new-skill')?.addEventListener('click', () => void createSkill());
  el('scan-now')?.addEventListener('click', () => void scanWorkspace());
  el('save-github')?.addEventListener('click', () => void saveGithubTarget());
  el('github-login')?.addEventListener('click', () => void startDeviceFlow());
  el('cancel-device')?.addEventListener('click', () => {
    state.deviceFlow = null;
    render();
  });
  el('install-apk')?.addEventListener('click', () => void installApk());
  el('copy-commit')?.addEventListener('click', () => {
    const textarea = el('commit-msg') as HTMLTextAreaElement | null;
    if (textarea) void navigator.clipboard?.writeText(textarea.value);
    toast('Commit message copied.');
  });
  el('confirm-yes')?.addEventListener('click', () => state.confirm?.onConfirm());
  el('confirm-no')?.addEventListener('click', () => {
    state.confirm = null;
    render();
  });
  el('approve-yes')?.addEventListener('click', () => (window as unknown as { __approve?: (a: boolean) => void }).__approve?.(true));
  el('approve-no')?.addEventListener('click', () => (window as unknown as { __approve?: (a: boolean) => void }).__approve?.(false));
}

async function applyPlanEdits(): Promise<void> {
  if (!state.runState?.plan || !state.session) return;
  let plan = state.runState.plan;
  document.querySelectorAll<HTMLInputElement>('[data-step-input]').forEach((input) => {
    plan = updatePlanStep(plan, Number(input.dataset.stepInput), input.value);
  });
  state.runState.plan = plan;
  await state.session.saveState(state.runState);
  toast('Plan updated.');
  render();
}

async function persistSettings(): Promise<void> {
  const baseUrl = (el('base-url') as HTMLInputElement | null)?.value ?? state.settings.baseUrl;
  const model = (el('model') as HTMLInputElement | null)?.value ?? state.settings.model;
  const apiKey = (el('api-key') as HTMLInputElement | null)?.value ?? state.settings.apiKey;
  state.settings.baseUrl = baseUrl;
  state.settings.model = model;
  state.settings.apiKey = apiKey;
  // On a device the key belongs in the Keystore, never in the settings blob.
  if (state.mode === 'android') {
    await state.platform.secrets.set('provider/apiKey', apiKey);
  }
  await saveSettings();
  toast('Settings saved.');
  render();
}

async function saveGithubTarget(): Promise<void> {
  state.settings.githubOwner = (el('gh-owner') as HTMLInputElement | null)?.value ?? '';
  state.settings.githubRepo = (el('gh-repo') as HTMLInputElement | null)?.value ?? '';
  await saveSettings();
  toast('Repo target saved.');
}

async function startDeviceFlow(): Promise<void> {
  const clientId = (window as unknown as { FORGEX_GITHUB_CLIENT_ID?: string }).FORGEX_GITHUB_CLIENT_ID;
  if (!clientId) {
    state.confirm = {
      title: 'GitHub client id missing',
      body: 'Device-flow login needs a GitHub OAuth app client id. Set FORGEX_GITHUB_CLIENT_ID in the app build (see docs/SETUP.md), or paste a personal access token in Settings.',
      onConfirm: () => {
        state.confirm = null;
        render();
      },
    };
    render();
    return;
  }
  const flow = new GitHubDeviceFlow(state.platform, clientId);
  const started = await flow.start();
  state.deviceFlow = { userCode: started.userCode, verificationUri: started.verificationUri };
  render();
  const deadline = Date.now() + started.expiresIn * 1000;
  let interval = started.interval * 1000;
  while (Date.now() < deadline && state.deviceFlow) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const poll = await flow.poll(started.deviceCode);
    if (poll.status === 'authorized' && poll.token) {
      await state.platform.secrets.set('github/token', poll.token);
      try {
        state.githubUser = (await new GitHubClient({ platform: state.platform, token: poll.token }).viewer()).login;
      } catch {
        state.githubUser = 'signed-in';
      }
      state.deviceFlow = null;
      toast(`Signed in as ${state.githubUser}`);
      render();
      return;
    }
    if (poll.status === 'slow_down') interval += 5000;
    if (poll.status === 'denied' || poll.status === 'expired') break;
  }
  state.deviceFlow = null;
  toast('GitHub login did not complete.');
  render();
}

async function createSkill(): Promise<void> {
  const name = (window.prompt('Skill name?') ?? '').trim();
  if (!name) return;
  const library = new SkillLibrary(state.platform, '/workspace/demo/.forgex/skills');
  const path = `/workspace/demo/.forgex/skills/${name.replace(/[^a-z0-9_-]/gi, '-')}.md`;
  await library.save(path, SkillLibrary.template(name));
  await refreshSkills();
  toast('Skill created.');
  render();
}

async function scanWorkspace(): Promise<void> {
  const session = state.session ?? buildSession();
  const files = await session.collectFiles();
  const findings = files.flatMap((file) =>
    scanText(file.content, { path: file.path }).map((finding) => `${file.path}:${finding.line} ${finding.rule}`),
  );
  state.logs = findings.length ? findings : ['No secrets found in the workspace.'];
  state.workspaceTab = 'log';
  state.screen = 'workspace';
  render();
}

async function installApk(): Promise<void> {
  const path = state.runState?.ship?.apkLocalPath;
  if (!path) return;
  state.confirm = {
    title: 'Install this APK?',
    body: 'Android will ask you to allow installing apps from ForgeX. The APK was built by your repository\'s CI run.',
    onConfirm: async () => {
      state.confirm = null;
      render();
      try {
        await state.platform.installApk(path);
      } catch (error) {
        toast(`Install unavailable: ${(error as Error).message}`);
      }
    },
  };
  render();
}

async function openProject(id: string): Promise<void> {
  state.activeProjectId = id;
  const project = state.projects.find((candidate) => candidate.id === id);
  state.request = project?.request ?? '';
  state.session = buildSession();
  await syncGithubToken(state.session);
  await refreshEvents();
  state.screen = 'build';
  render();
}

async function loadWorkspace(): Promise<void> {
  const entries = await state.platform.fs.list(workspaceRoot(), { recursive: true, maxEntries: 400 });
  state.fileTree = entries.map((entry) => ({ name: entry.name, type: entry.type, path: entry.path }));
}

async function openFile(path: string): Promise<void> {
  const content = await state.platform.fs.read(path).catch(() => '');
  if (state.openFile !== path) state.previousFile = state.openFileContent;
  state.openFile = path;
  state.openFileContent = content;
  state.workspaceTab = 'code';
  render();
}

void boot();

// Test/automation hook: lets the DOM-shim tests drive navigation and read state
// without a browser. Harmless in production (it only calls the same code the tab
// bar calls).
(window as unknown as { __forgexNavigate?: (screen: string) => void }).__forgexNavigate = (screen: string) => {
  state.screen = screen as AppState['screen'];
  render();
};
