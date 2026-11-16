import type { PlanDraft } from './plan';

export type RunStepName = 'plan' | 'context' | 'code' | 'test' | 'review' | 'ship';

export type RunStatus =
  | 'idle'
  | 'planning'
  | 'awaiting_plan_approval'
  | 'building'
  | 'testing'
  | 'reviewing'
  | 'shipping'
  | 'done'
  | 'failed'
  | 'paused'
  | 'cancelled';

export interface ShipResult {
  repoFullName: string;
  branch: string;
  commitSha: string;
  commitMessage: string;
  ciRunId?: number;
  ciStatus?: string;
  ciUrl?: string;
  apkArtifactName?: string;
  apkArtifactId?: number;
  apkLocalPath?: string;
  repairedIterations?: number;
}

/**
 * Persisted run state. Everything needed to resume after the app is killed:
 * the request, the plan (including human edits), which step we reached, and the
 * shipping outcome.
 */
export interface RunState {
  runId: string;
  projectId: string;
  request: string;
  status: RunStatus;
  plan?: PlanDraft;
  currentStep?: RunStepName;
  completedSteps: RunStepName[];
  ship?: ShipResult;
  error?: string;
  updatedAt: number;
  createdAt: number;
  /** CI repair loop counter (max 5 per spec). */
  repairAttempts: number;
}
