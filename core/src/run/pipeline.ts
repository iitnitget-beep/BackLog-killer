import type { Platform } from '../platform/types';
import type { Orchestrator, VerifyResult } from '../agent/orchestrator';
import type { EventStore } from '../events/store';
import type { ProjectMemoryStore } from '../memory/project';
import { deriveNotes } from '../memory/project';
import type { SkillLibrary } from '../skills/loader';
import { androidBuildWorkflow } from '../ci/workflow';
import { renderPlanMarkdown, type PlanDraft } from './plan';
import type { RunState, RunStatus, ShipResult } from './types';

export interface WorkspaceFile {
  path: string;
  content: string;
}

export interface PipelineDeps {
  platform: Platform;
  orchestrator: Orchestrator;
  events: EventStore;
  memory: ProjectMemoryStore;
  skills: SkillLibrary;
  workspaceRoot: string;
  /** Collects the files the agent wrote, for the commit payload. */
  collectFiles: () => Promise<WorkspaceFile[]>;
  /** Verifies the workspace locally (Node harness) - optional on device. */
  localVerify?: () => Promise<VerifyResult>;
  /** Ship the workspace to GitHub and return the CI outcome. */
  ship: (files: WorkspaceFile[], commitMessage: string) => Promise<ShipResult>;
  /** Called after CI fails so the agent can repair from logs. */
  repairFromLogs?: (logs: string, attempt: number) => Promise<void>;
  saveState: (state: RunState) => Promise<void>;
}

export interface PipelineResult {
  state: RunState;
  plan: PlanDraft;
  ship?: ShipResult;
}

const MAX_REPAIR_ATTEMPTS = 5;

/**
 * The ForgeX pipeline: Plan -> Build -> Test -> Review -> Ship.
 *
 * Each step appends to the event stream (the Agent Timeline), saves resumable
 * state, and can be paused or aborted. The CI self-repair loop is bounded at 5
 * iterations, after which the run stops and asks the user (spec §4).
 */
export class Pipeline {
  constructor(private readonly deps: PipelineDeps) {}

  async run(state: RunState, options: { signal?: AbortSignal; onStatus?: (status: RunStatus, detail?: string) => void } = {}): Promise<PipelineResult> {
    const { platform, events, orchestrator } = this.deps;
    const onStatus = options.onStatus ?? (() => undefined);
    const update = async (patch: Partial<RunState>) => {
      Object.assign(state, patch, { updatedAt: platform.now() });
      await this.deps.saveState(state);
    };
    const step = async (name: RunState['currentStep'] & string) => {
      await events.append({ kind: 'step_started', stepName: name });
      onStatus(name as RunStatus, name);
    };
    const finishStep = async (name: RunState['currentStep'] & string, ok: boolean, detail?: string) => {
      await events.append({ kind: 'step_finished', stepName: name, ok, detail });
      state.completedSteps = [...new Set([...state.completedSteps, name])];
      await update({});
    };

    await events.append({ kind: 'run_started', detail: state.request.slice(0, 500) });
    await events.append({ kind: 'user_message', content: state.request });
    await update({ status: 'planning' });
    onStatus('planning');

    // ---- Step 1: plan -------------------------------------------------------
    let plan = state.plan;
    if (!plan) {
      await step('plan');
      const planned = await orchestrator.plan(state.request, options.signal);
      plan = planned.draft;
      await events.append({ kind: 'assistant_message', content: planned.raw.slice(0, 4000) });
      await events.append({ kind: 'plan_updated', detail: renderPlanMarkdown(plan), data: plan });
      await update({ plan });
      await finishStep('plan', true, `${plan.steps.length} steps`);
    }

    // ---- Step 2: context (file-picker + memory + skills) --------------------
    await step('context');
    const skillContext = await this.deps.skills.contextFor(state.request);
    const memoryContext = await this.deps.memory.context();
    if (skillContext) await events.append({ kind: 'note', detail: `loaded skills: ${skillContext.length} chars` });
    await finishStep('context', true);

    // ---- Step 3: build (editor per plan step) -------------------------------
    await update({ status: 'building' });
    onStatus('building');
    await step('code');
    for (const planStep of plan.steps) {
      if (options.signal?.aborted) return this.abort(state, plan, onStatus);
      if (state.completedSteps.includes('code') && state.plan?.steps.some((s) => s.id === planStep.id) === false) continue;
      await orchestrator.spawn({
        agent: 'editor',
        task: [
          `Implement plan step ${planStep.id}: ${planStep.title}`,
          `Files: ${planStep.files.join(', ') || 'choose as needed'}`,
          `Done when: ${planStep.doneWhen}`,
        ].join('\n'),
        context: [renderPlanMarkdown(plan), memoryContext, skillContext].filter(Boolean).join('\n\n'),
        signal: options.signal,
      });
    }
    // Every Android target gets a CI workflow so the APK build is reproducible.
    await this.ensureWorkflow();
    await finishStep('code', true, `${plan.steps.length} plan steps`);

    // ---- Step 4: test -------------------------------------------------------
    await update({ status: 'testing' });
    onStatus('testing');
    await step('test');
    let verifyResult: VerifyResult = { ok: true, summary: 'local verification not configured', output: '' };
    const verifyAttempts: { iteration: number; verify: VerifyResult; fix?: string }[] = [];
    if (this.deps.localVerify) {
      verifyResult = await this.deps.localVerify();
      verifyAttempts.push({ iteration: 1, verify: verifyResult });
    }
    await finishStep('test', verifyResult.ok, verifyResult.summary.slice(0, 500));
    if (!verifyResult.ok && this.deps.localVerify) {
      const loop = await orchestrator.verifyLoop({
        initialTask: state.request,
        verify: this.deps.localVerify,
        maxIterations: MAX_REPAIR_ATTEMPTS,
        signal: options.signal,
      });
      verifyResult = loop.history.at(-1)?.verify ?? verifyResult;
      loop.history.forEach((attempt, index) =>
        verifyAttempts.push({ iteration: index + 1, verify: attempt.verify, fix: attempt.fix }),
      );
      if (loop.status !== 'passed') {
        await update({ status: 'failed', error: 'verification failed after 5 repair rounds' });
        await events.append({ kind: 'run_failed', detail: 'verification exhausted' });
        onStatus('failed');
        return { state, plan };
      }
    }

    // ---- Step 5: review (fresh context) ------------------------------------
    await update({ status: 'reviewing' });
    onStatus('reviewing');
    await step('review');
    const files = await this.deps.collectFiles();
    const fileList = files.map((file) => file.path).join('\n');
    const review = await orchestrator.ask(
      'reviewer',
      `Review this generated Android project before shipping.\n\nPlan:\n${renderPlanMarkdown(plan)}\n\nFiles:\n${fileList.slice(0, 4000)}`,
      `Workspace: ${this.deps.workspaceRoot}`,
      options.signal,
    );
    const reviewVerdict = /"verdict"\s*:\s*"pass"/i.test(review) ? 'pass' : /"verdict"\s*:\s*"fail"/i.test(review) ? 'fail' : 'unknown';
    await events.append({ kind: 'assistant_message', content: review.slice(0, 3000) });
    if (reviewVerdict === 'fail') {
      await orchestrator.ask(
        'test-fixer',
        `A reviewer rejected this project. Fix the critical/high findings.\n\n${review}`,
        undefined,
        options.signal,
      );
    }
    await finishStep('review', reviewVerdict !== 'fail', reviewVerdict);
    const security = await orchestrator.ask(
      'security-reviewer',
      `Security review the files listed.\n${fileList.slice(0, 3000)}`,
      undefined,
      options.signal,
    );
    await events.append({ kind: 'note', detail: `security review: ${security.slice(0, 500)}` });

    // ---- Secret gate before push -------------------------------------------
    const gateResult = await orchestrator.prePushScan(await this.deps.collectFiles());
    if (!gateResult.ok) {
      await update({ status: 'failed', error: gateResult.blockers.join('; ').slice(0, 500) });
      onStatus('failed', 'secret gate blocked the push');
      return { state, plan };
    }

    // ---- Step 6: ship -------------------------------------------------------
    await update({ status: 'shipping' });
    onStatus('shipping');
    await step('ship');
    let ship: ShipResult;
    try {
      ship = await this.deps.ship(await this.deps.collectFiles(), commitMessage(state.request, plan));
    } catch (error) {
      const message = (error as Error).message;
      await update({ status: 'failed', error: message });
      await events.append({ kind: 'run_failed', detail: message.slice(0, 800) });
      onStatus('failed', message);
      return { state, plan };
    }
    await update({ ship });
    await finishStep('ship', true, ship.ciStatus ?? 'pushed');

    // ---- CI self-repair loop (max 5) ---------------------------------------
    let repairAttempts = state.repairAttempts;
    while (ship.ciStatus === 'failure' && this.deps.repairFromLogs && repairAttempts < MAX_REPAIR_ATTEMPTS) {
      repairAttempts += 1;
      await events.append({ kind: 'note', detail: `CI failed; repair attempt ${repairAttempts}/${MAX_REPAIR_ATTEMPTS}` });
      await this.deps.repairFromLogs(ship.ciUrl ?? '', repairAttempts);
      try {
        ship = await this.deps.ship(await this.deps.collectFiles(), `fix: CI repair ${repairAttempts} for ForgeX run ${state.runId}`);
      } catch (error) {
        await update({ status: 'failed', error: (error as Error).message, repairAttempts });
        break;
      }
      await update({ ship, repairAttempts });
    }
    if (ship.ciStatus === 'failure' && repairAttempts >= MAX_REPAIR_ATTEMPTS) {
      await update({ status: 'failed', error: 'CI still failing after 5 repair attempts - needs a human', repairAttempts });
      await events.append({ kind: 'gate_blocked', detail: 'CI repair loop exhausted (5 attempts)' });
      onStatus('failed');
      return { state, plan };
    }

    const finalStatus: RunStatus = ship.ciStatus === 'failure' ? 'failed' : 'done';
    await update({ status: finalStatus });

    // ---- Learn from the run ------------------------------------------------
    const notes = deriveNotes({
      runId: state.runId,
      timestamp: platform.now(),
      planVerify: plan.verify,
      attempts: verifyAttempts.length ? verifyAttempts : [{ iteration: 1, verify: verifyResult }],
      finalOk: finalStatus === 'done',
    });
    for (const note of notes) await this.deps.memory.addNote(note);
    await events.append({ kind: 'run_finished', detail: `${finalStatus}; ${notes.length} notes learned` });
    await platform.notify(
      finalStatus === 'done' ? 'ForgeX build finished' : 'ForgeX build failed',
      finalStatus === 'done' ? `${ship.repoFullName} @ ${ship.commitSha.slice(0, 7)}` : state.error ?? 'see the run log',
    );
    onStatus(finalStatus);
    return { state, plan, ship };
  }

  private async ensureWorkflow(): Promise<void> {
    const path = `${this.deps.workspaceRoot}/.github/workflows/build-apk.yml`;
    if (!(await this.deps.platform.fs.exists(path))) {
      await this.deps.platform.fs.write(path, androidBuildWorkflow());
    }
  }

  private abort(state: RunState, plan: PlanDraft, onStatus: (s: RunStatus) => void): PipelineResult {
    state.status = 'cancelled';
    onStatus('cancelled');
    return { state, plan };
  }
}

export function commitMessage(request: string, plan: PlanDraft): string {
  const title = plan.summary || request;
  return `feat: ${title.slice(0, 60)}\n\nGenerated by ForgeX.\n\n${plan.steps.map((step) => `- ${step.title}`).join('\n')}`;
}
