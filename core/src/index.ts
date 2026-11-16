/**
 * Public surface of the ForgeX core, consumed by the Android WebView.
 *
 * This entry point is deliberately browser-safe: it must bundle without Node
 * builtins. The Node harness (tests, CLI) imports `./node-index` instead, which
 * adds the Node platform.
 */
export * from './platform/types';
export { createMemoryPlatform, MemoryKv, MemoryFs, MemorySecrets } from './platform/memory';
export { createWebViewPlatform, type NativeBridge } from './platform/webview';

export { ToolRegistry } from './tools/registry';
export { ToolError } from './tools/types';
export { splitCommand, isDestructive } from './tools/shell';

export { ApprovalManager, approveAll, denyAll, approveFirstN } from './agent/approval';
export type { ApprovalMode, ApprovalRequest, ApprovalDecision, ApprovalHandler } from './agent/approval';
export { runAgentLoop } from './agent/engine';
export { LoopDetector } from './agent/loopDetection';
export { Orchestrator, parsePlan, parseVerdict, extractJson } from './agent/orchestrator';
export { ALL_AGENTS, getAgent, DEFENSE_BASELINE } from './agent/definitions';
export type { AgentDefinition, AgentRole } from './agent/definitions';

export { EventStore, listRuns, toTimeline } from './events/store';
export type { ForgeEvent, EventKind } from './events/types';
export type { TimelineEntry } from './events/store';
export { condense, estimateTokens } from './context/condenser';

export { scanText, gate, redact } from './security/scanner';
export { runLint, defaultLintStrategy } from './security/lintHook';

export { OpenAiCompatibleClient, classifyStatus } from './llm/openai';
export { ProviderRouter } from './llm/router';
export { PROVIDER_PRESETS, findPreset } from './llm/providers';
export type { ProviderConfig, ChatMessage, ToolCall, LlmClient } from './llm/types';

export { ProjectMemoryStore, deriveNotes } from './memory/project';
export { SkillLibrary, parseSkillFile } from './skills/loader';

export { GitHubClient, GitHubError } from './github/client';
export { GitHubDeviceFlow } from './github/oauth';
export { androidBuildWorkflow, forgexSelfWorkflow } from './ci/workflow';
export { monitorRun, findRunForCommit, trimCiLog } from './ci/monitor';

export { Pipeline, commitMessage } from './run/pipeline';
export { renderPlanMarkdown, updatePlanStep, removePlanStep } from './run/plan';
export type { PlanDraft, PlanStep } from './run/plan';
export type { RunState, RunStatus, ShipResult } from './run/types';

export { ProjectSession, presetEntry, agentModelHint } from './app/session';
