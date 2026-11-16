# Architecture notes

Deeper detail on the parts that are easy to get wrong. Design *choices* (and the
alternatives rejected) are in [DECISIONS.md](../DECISIONS.md).

## The platform contract

Everything device-specific sits behind `core/src/platform/types.ts`:

```ts
interface Platform {
  fs:      FileSystemPort;   // read/write/append/list/stat/remove/mkdir/exists
  secrets: SecretPort;       // get/set/delete  (Keystore on device)
  kv:      KeyValuePort;     // get/set/keys/delete  (SQLite on device)
  exec(command: string[], options?): Promise<ExecResult>;
  http(request: HttpRequest): Promise<HttpResponse>;
  notify(title, body): Promise<void>;
  installApk(absolutePath): Promise<void>;
  now(): number;
}
```

Three implementations, chosen by the host:

| Implementation | Used by | Behaviour |
| --- | --- | --- |
| `createWebViewPlatform(bridge)` | the APK | forwards JSON to `forgeXBridge` |
| `createNodePlatform(...)` | tests, CLI, desktop | real fs/process/fetch with allowlist + timeout |
| `createMemoryPlatform(...)` | unit tests, browser preview | deterministic, no I/O |

Because the agent core only ever sees this interface, the same 96 tests exercise
the logic that runs on the phone. The native side is then small enough to attack
directly with Robolectric (`android/app/src/test/.../PathSandboxTest.kt`).

## The tool choke point

`core/src/agent/executor.ts` is the only path from a model decision to a side
effect. Order is deliberate and each branch returns an envelope instead of
throwing, so the model always receives something it can react to:

1. `permissionFor(tool, args)` — the tool's own class: `allow` (read-only),
   `ask` (mutating), `deny` (destructive).
2. `ApprovalManager.check` — applies the mode (`ASK` / `AUTO_EDIT` /
   `FULL_AUTO`), then the user. `deny` cannot be overridden by any mode, and
   `ASK` with no UI handler denies (fail closed).
3. Secret gate on write payloads — `gate(content, {path})` from the scanner.
4. Execute; convert errors into `{ok:false, output, error:{code}}`.

## The agent loop

`runAgentLoop` (core/src/agent/engine.ts):

```
system(+user) → [condense if over budget] → llm.complete(messages, tools)
   → if no tool calls: done
   → for each tool call: loop-detect → execute → append tool result
   → repeat (max 40 rounds)
```

Stop reasons match qwen-code's vocabulary: `completed`, `max_rounds`,
`cancelled`, `loop_detected`, `error`. Loop detection fingerprints tool calls
with sorted keys, so `{"a":1,"b":2}` and `{"b":2,"a":1}` are the same call, and
fires at 5 identical calls or 10 identical contents.

## Orchestration

Agents are data (`core/src/agent/definitions.ts`): id, title, allowed tools,
which agents they may spawn, a model hint, and instructions. `Orchestrator.spawn`
builds a per-agent registry (`registry.subset(agent.tools)`), composes a system
prompt (instructions + available tools + workspace + AGENTS.md/skills + parent),
sends the task as the opening user message, and records `agent_spawned` /
`assistant_message` / `observation` / `agent_finished` events.

`verifyLoop` is the ECC discipline made executable: run verify → if it passes,
ask a *fresh-context* reviewer → if the reviewer fails it, hand the findings to
the test-fixer and loop; if verify fails, hand the failure text to the
test-fixer. Bounded at 5, then `gate_blocked` and stop.

## Events and resumability

Every meaningful action is an event (`ActionEvent`, `ObservationEvent`,
`StepEvent`, `AgentLifecycleEvent`, …) appended to a durable log keyed by run id.
Two consequences:

- the Agent Timeline is a projection of the log (`toTimeline`), not separate UI
  state — reopening the app shows the same history;
- resuming is just reloading `run/{id}/state` and re-entering the pipeline, which
  skips a plan if one was already saved.

## Context management

`condense` estimates tokens (4 chars/token, counting tool arguments), and when
over budget replaces old turns with a summary while pinning system messages and
keeping the last N turns. It walks the split point backwards so the recent window
never begins with a `tool` message — providers reject a tool result whose
assistant tool-call was dropped.

## Shipping without git on the device

```
publishFiles():
  GET  /repos/{r}                     → default branch
  GET  /git/ref/heads/{branch}        → base commit
  GET  /git/commits/{base}            → base tree
  POST /git/trees   (base_tree + files)
  POST /git/commits (tree, parents)
  PATCH /git/refs/heads/{branch}      → atomically move the branch
```

Then `findRunForCommit` matches the run by `head_sha` (falling back to the newest
run on the branch for the few seconds before GitHub populates it), `monitorRun`
polls to completion, `trimCiLog` keeps the actionable error blocks, and the
self-repair loop feeds them to the test-fixer.

## Security model

- **Path sandbox**: `safePath` in TS and `resolvePath` in Kotlin both reject `..`
  and absolute paths; Kotlin additionally compares canonical paths so a symlink
  cannot escape.
- **No shell**: argv only, allowlist on both sides.
- **Secrets**: Keystore-backed, excluded from backup (`data_extraction_rules`),
  never written to the workspace.
- **Pre-push scan**: every file is scanned (strict mode) before `publishFiles`; a
  finding blocks the push and writes a `gate_blocked` event.
- **WebView**: only `appassets.androidplatform.net` assets load; file access is
  off, cleartext traffic is off, navigation outside the asset host is blocked.
- **No silent install**: the APK goes to the system installer via FileProvider;
  Android's own confirmation is the gate.
