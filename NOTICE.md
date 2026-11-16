# NOTICE

ForgeX is original code. Where a design or prompt was ported from another
project, the source, licence, and the files involved are listed below. All four
reference repositories were read at the commits pinned underneath; none of them
are vendored, installed, or executed at runtime.

No code was copied verbatim from any of these repositories. What was carried over
is *design* (architecture, file layout of prompts, thresholds, contract shapes),
and several prompt documents were adapted and rewritten for this app. Where text
is close to the original, the original copyright notice applies and is reproduced
below as its licence requires.

---

## 1. ECC — https://github.com/affaan-m/ECC

- **Licence:** MIT — Copyright (c) 2026 Affaan Mustafa
- **Used for:** workflow discipline, prompt quality, hook-style checks.
- **Studied:** `LICENSE`, `agents/planner.md`, `agents/code-reviewer.md`,
  `agents/security-reviewer.md`, `agents/build-error-resolver.md`,
  `rules/common/{hooks,git-workflow,development-workflow,testing}.md`,
  `skills/autonomous-loops/SKILL.md`.
- **What ForgeX implements from it:**
  - the "Prompt Defense Baseline" idea, adapted into `DEFENSE_BASELINE` in
    `core/src/agent/definitions.ts`;
  - the planner / code-reviewer / security-reviewer / build-error-resolver
    prompt structure (role, process, checklist, strict output format) —
    rewritten for a phone-sized agent and a JSON output contract;
  - the confidence-based review gate (">80% sure", cite file+line, pre-report
    gate) in the reviewer prompt;
  - the plan → implement → verify → fresh-context review → fix loop, implemented
    as `Orchestrator.verifyLoop` in `core/src/agent/orchestrator.ts`;
  - PreToolUse/PostToolUse style hooks, reimplemented as our own code:
    secret scan before every write and every push
    (`core/src/security/scanner.ts`), lint-after-edit hook
    (`core/src/security/lintHook.ts`).
- **Not used:** Claude Code plugin installation, hooks JSON mechanics, `skills/`
  registry format. Our skills format is our own (`core/src/skills/loader.ts`).

## 2. qwen-code — https://github.com/QwenLM/qwen-code

- **Licence:** Apache License 2.0 (header: `Copyright 2025 Google LLC` /
  `Copyright 2026 Qwen Team`)
- **Used for:** the single-agent tool/loop engine.
- **Studied:** `packages/core/src/tools/tools.ts` (ToolInvocation: params,
  `getDescription`, `getDefaultPermission`), `packages/core/src/core/agent-loop.ts`
  (`AgentLoopStopReason`: completed / cancelled / loop_detected / max_session_turns),
  `packages/core/src/services/loopDetectionService.ts`
  (`TOOL_CALL_LOOP_THRESHOLD = 5`, `CONTENT_LOOP_THRESHOLD = 10`).
- **What ForgeX implements from it:**
  - `ToolDefinition` with `spec`, `permission(args)`, `run(args, ctx)` in
    `core/src/tools/types.ts`;
  - the loop shape (send messages + declarations → execute tool calls → append
    results → repeat) in `core/src/agent/engine.ts`, with the same stop-reason
    vocabulary;
  - identical loop-detection thresholds in
    `core/src/agent/loopDetection.ts`;
  - the tool set: read/write/edit/grep/glob/list-dir/shell.
- **Not used:** the terminal UI, `@google/genai` types, Node-only APIs. Command
  execution is reimplemented as an argv allowlist with no shell
  (`core/src/tools/shell.ts`, `ForgeXBridge.exec`).

## 3. freebuff / codebuff — https://github.com/CodebuffAI/freebuff

- **Licence:** Apache License 2.0
- **Used for:** the multi-agent orchestration pattern.
- **Studied:** `agents/base3.ts`, `agents/base3-fast.ts` (root agent with
  `spawn_agents`, per-agent `toolNames`, withheld tools), `agents/file-picker.ts`,
  `agents/thinker.ts`, `agents/basher.ts`, `agents/types/secret-agent-definition.ts`.
- **What ForgeX implements from it:**
  - declarative `AgentDefinition` (id, title, tools, canSpawn, modelHint,
    instructions) in `core/src/agent/definitions.ts`;
  - the "parent spawns helpers and waits for results" model in
    `Orchestrator.spawn`, with every spawn/finish recorded on the event stream;
  - the batching guidance for tool calls (read/edit/search in one turn),
    rewritten into the orchestrator and editor prompts;
  - an iterative refinement loop (run → fix → retry, max 5).
- **Not used:** the hosted backend, the free-model catalogue and its terms, the
  ad system, Docker setup. ForgeX always uses a provider key the user supplies.

## 4. OpenHands — https://github.com/OpenHands/OpenHands

- **Licence:** MIT — Copyright © 2025 OpenHands contributors
- **Used for:** event-stream architecture and context management ideas.
- **Studied:** `src/types/agent-server/core/events/` (`action-event.ts`,
  `observation-event.ts`, `condensation-event.ts`, `pause-event.ts`).
- **What ForgeX implements from it (reimplemented, not embedded):**
  - the Action → Observation event model with a persisted, replayable log
    (`core/src/events/types.ts`, `core/src/events/store.ts`);
  - context condensation that replaces old turns with a summary while keeping
    recent turns and never splitting a tool-call/tool-result pair
    (`core/src/context/condenser.ts`);
  - the microagent idea: markdown files that load only when their trigger
    keywords appear in the task (`core/src/skills/loader.ts`).
- **Not used:** the Python platform, the Docker runtime, anything under
  `enterprise/`.

---

## Runtime dependencies

ForgeX ships no third-party JavaScript at runtime. `esbuild`, `typescript` and
`vitest` are development-only (MIT). On Android, the app links AndroidX
(AppCompat, Core-KTX, WebKit, Security-Crypto — Apache 2.0), Kotlin
(Apache 2.0) and kotlinx-coroutines (Apache 2.0). Their notices are included in
the APK by the Android Gradle plugin.

## MIT licence text (ECC, OpenHands)

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Apache 2.0 text (qwen-code, freebuff/codebuff)

The full Apache License 2.0 is at <https://www.apache.org/licenses/LICENSE-2.0>.
Where ForgeX adapts Apache-2.0 material, the adaptation is noted in the file
header and this NOTICE.
