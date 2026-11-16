# Status

Last verified: 2026-11-16, against the head of
`arena/48cf1f1b-backlog-killer` / CI run
[43893659614](https://github.com/iitnitget-beep/BackLog-killer/actions/runs/43893659614) (commit
`1b4b26b`, the ECC port) — — **all jobs green**.

| Job | Result |
| --- | --- |
| Core tests (typecheck, 196 tests, CLI smoke, bundle boot check) | success |
| Android unit tests (Robolectric sandbox/keystore/kv) | success |
| Build debug APK | success — `forgex-debug-apk`, 4,406,229 bytes |

Legend: **WORKING** = implemented and verified by an automated test or a real CI
run. **PARTIAL** = implemented but not verified end-to-end, or limited for a
stated reason. **NOT DONE** = not implemented.

---

## Build & verification evidence

| Check | Result |
| --- | --- |
| TypeScript typecheck (`tsc --noEmit`, strict) | **pass** |
| Core unit/integration tests | **196 pass**, 17 files |
| Kotlin unit tests (Robolectric) | **pass** in CI |
| Debug APK built in CI | **pass** — 4.41 MB artifact `forgex-debug-apk` (+232 KB for the vendored skills) |
| APK contains the web bundle | **pass** — CI asserts `assets/app/index.html` and `assets/app/ui.js` |
| Built UI bundle boots and renders | **pass** — `scripts/verify-bundle.mjs` runs the real esbuild output in a DOM sandbox and checks the home screen, tab bar and preview badge |
| UI bundle size (7 vendored skills included) | 297,018 B → 83,807 B gzipped |
| APK installs and launches on a physical device | **NOT DONE** — no device or emulator in this environment; the launch test (`AppLaunchTest`) is an instrumented test that has not been executed, and CI cannot run it. This is the one acceptance criterion from M1/M6 that remains unverified. |

Honest note on that gap: `assembleDebug` succeeding proves the app compiles, the
manifest merges, and the assets are packaged. It does **not** prove the WebView
boots, the bridge is reachable, or that `EncryptedSharedPreferences` initialises
on a real device's Keystore. Until someone side-loads the artifact and runs the
instrumented test, treat "it launches on a phone" as unproven.

---

## Milestones

### M1 — Shell + UI · **WORKING** (device launch unverified)

| Feature | Status | Evidence |
| --- | --- | --- |
| App shell, navigation between 5 screens | WORKING | `test/ui.test.ts` renders every screen through the real render functions via a DOM shim |
| Chat/build input on Home | WORKING | `test/ui.test.ts` |
| Settings: provider preset, base URL, model, key, approval mode | WORKING | render + `publishSettings` path; key goes to Keystore on device |
| Project list, offline browsing of past projects | WORKING | projects persisted via the KV port |
| Instrumented smoke test written | PARTIAL | `AppLaunchTest` exists, cannot run without a device |
| Real-device launch | NOT DONE | no device available here |

### ECC port (hooks + skills) · **WORKING**

| Feature | Status | Evidence |
| --- | --- | --- |
| Hook engine with ECC's exit-code contract (0 allow / 2 block, first block wins, declaration order, 2 s timeout) | WORKING | `test/hooks.test.ts` — 26 tests: ordering, first-block-wins, warn-only, crash → warn, timeout |
| 9 hooks shipped (5 blocking) | WORKING | `test/hooks.test.ts` covers each hook's allow/block/warn branch |
| Hooks run on every tool call, before the tool, via one choke point | WORKING | `test/hooks.test.ts` "hooks in the tool choke point": blocked write leaves no file, clean write lands, new sensitive file not gated, existing config refused |
| Secret gate survives a caller that supplies no hook runner | WORKING | `test/hooks.test.ts` (`ESECRET`) |
| `stop:unverified-claim` forces another round instead of ending the run | WORKING | `test/hooks.test.ts` "the Stop gate forces a retry": block → user turn → 2 rounds; gives up after `maxStopRetries` |
| Stop gate recorded on the event stream | WORKING | `test/hooks.test.ts` asserts a `gate_blocked` event naming `stop:unverified-claim` |
| `session:start` injects project memory; `pre:compact` checkpoints when the condenser fires | WORKING | orchestrator wiring; `pre:compact` fires only on `condensed: true` |
| 7 ECC skills vendored verbatim (MIT, attribution in file + NOTICE §1b) | WORKING | `test/skills.test.ts` asserts names, sizes, attribution header, licence |
| Trigger + agent-role + budget selection | WORKING | `test/skills.test.ts`: security-review only for the security reviewer, budget truncation reported |
| User skill overrides a built-in of the same name | WORKING | `test/skills.test.ts` |
| Skills reach the real system prompt; selection recorded on the event stream | WORKING | `test/skills.test.ts` asserts `<skill …>` in `ScriptedLlm.systemPrompt()` |
| Skills install into `<project>/.forgex/skills` and re-parse with front matter | WORKING | `test/skills.test.ts` install + `SkillLibrary.list()` round trip |
| Vendored files whose attribution comment precedes `---` parse correctly | WORKING | `stripLeadingComments` + test over all 7 files |
| Settings shows the hook catalogue + built-in skills; Home/Build show an "ECC guards" strip | WORKING | `test/ui.test.ts` "UI exposes the ECC layer" |
| "Preview selection" / "Install copy"/"Install all" wired in the UI | PARTIAL | render + handlers exist and are typechecked; the buttons are only exercised through the DOM shim, not clicked on a device |
| Hook execution on a physical device | NOT DONE | no device here; the logic is platform-independent and covered in Node |

### M2 — Single-agent loop · **WORKING**

| Feature | Status | Evidence |
| --- | --- | --- |
| Tools: read/write/edit/grep/glob/list_dir/run_command | WORKING | `test/tools.test.ts` (19 tests) |
| Agent creates, edits and reads a file from a prompt | WORKING | `test/agent.test.ts` "creates, edits and reads a file from a prompt" |
| Approval modes ASK / AUTO_EDIT / FULL_AUTO | WORKING | `test/tools.test.ts`, incl. fail-closed behaviour |
| Loop detection (5 identical calls / 10 identical contents) | WORKING | `test/agent.test.ts` |
| Malformed tool JSON handled without crashing | WORKING | `parseArgs` test |
| Cancellation | WORKING | signal test |
| Destructive-command refusal | WORKING | `isDestructive` + `deny` permission tests |
| Command allowlist enforced natively | WORKING | Robolectric `exec refuses binaries outside the allowlist` |

### M3 — GitHub + CI · **PARTIAL**

| Feature | Status | Evidence |
| --- | --- | --- |
| GitHub client (user, repo, git data API, runs, logs, artifacts) | WORKING | `test/github.test.ts` against a mocked HTTP port |
| Device-flow login | **PARTIAL** | implemented (`github/oauth.ts`); all poll outcomes (pending, slow_down, expired, denied, authorized) are unit-tested, but no OAuth app exists here, so it has never completed a real authorisation |
| Create repo | WORKING | client + test; not wired into the UI (UI targets an existing repo) |
| Commit + push via Git Data API | WORKING | `publishFiles` with test |
| Trigger/monitor CI, stream logs, find APK artifact | WORKING | `test/ci.test.ts` |
| End-to-end "builds a hello-world Android app" | **NOT DONE** | needs a real provider key + GitHub token; deliberately not faked |

The ForgeX repo itself is the proof that the generated-workflow shape works: the
same `assembleDebug` + artifact-upload structure runs green on this repository
(see the evidence table).

### M4 — Multi-agent + verify loop · **WORKING**

| Feature | Status | Evidence |
| --- | --- | --- |
| Definitive agents: file-picker, planner, editor, reviewer, security-reviewer, test-fixer, thinker | WORKING | `agent/definitions.ts`; roles routed in tests |
| Parent spawns helpers, waits, records events | WORKING | `test/orchestrator.test.ts` |
| Verify loop (verify → fresh review → fix), max 5 | WORKING | orchestrator tests: passes first time, passes on 3rd, exhausts |
| A failing build gets auto-fixed (local verify) | WORKING | `test/pipeline.test.ts` "runs the local verify loop" |
| A failing CI run gets auto-fixed from logs | WORKING (simulated) | `test/pipeline.test.ts` with injected logs; not yet exercised against a real failing run |
| Loop stops at 5 and asks the user | WORKING | pipeline test asserts `repairAttempts === 5` and a `gate_blocked` event |
| Event stream persisted + replayable | WORKING | `test/events.test.ts` (reopen after restart keeps seq) |
| Context condenser | WORKING | `test/context.test.ts` (6 tests) |

### M5 — Memory, skills, security, resume · **WORKING** (with limits)

| Feature | Status | Evidence |
| --- | --- | --- |
| Per-project `AGENTS.md` + learned notes | WORKING | `test/pipeline.test.ts` memory tests; notes de-duplicated |
| Skills + microagents loaded by trigger | WORKING | `test/pipeline.test.ts` skills tests |
| Skills manager UI (create) | PARTIAL | creates a file from a template; no in-app editor for existing skills |
| Secret scan before write | WORKING | executor gate test (blocked write leaves no file) |
| Secret scan before push | WORKING | `prePushScan` test |
| Known-good Android scaffold for new projects | WORKING | `test/scaffold.test.ts` (8 tests) + pipeline seeding tests; never overwrites an existing project |
| Resume after app kill | WORKING | pipeline "resumes: a saved plan is not re-planned" |
| Agent Timeline with per-step status | WORKING | `toTimeline` + UI render tests |
| Rollback per step | PARTIAL | marks the step unfinished so the next run redoes it; does **not** revert files (git history is the recovery path) |
| Pause | PARTIAL | pauses approvals; it does not freeze an in-flight model call |

### M6 — Hardening · **PARTIAL**

| Feature | Status | Evidence |
| --- | --- | --- |
| Provider fallback on rate limit / error | WORKING | `test/llm.test.ts`: retry-then-fallback, auth errors not retried, per-provider model lists. Not exercised against a real 429 |
| Error states (provider error, CI failure, missing key) | WORKING | engine returns `error`; UI shows status + toast |
| Empty states | WORKING | per screen |
| Performance on a low-end phone | NOT DONE | no device; bundle is 137 KB JS, which is the only proxy we have |
| Docs | WORKING | README, NOTICE, DECISIONS, ARCHITECTURE, SETUP, this file |

---

## Known limitations (stated plainly)

1. **No device verification.** APK builds; launch on hardware is unproven.
2. **No real end-to-end run.** Everything that needs a paid provider key or a
   GitHub token was tested with scripted providers and a mocked HTTP port.
3. **`verifyLocally` is structural only.** The phone cannot compile Kotlin;
   compilation happens in CI and the UI says so.
4. **Device flow is unproven** and needs the user's own OAuth client id.
5. **Rollback is bookkeeping**, not a file-level revert.
6. **Android unit tests required a fix that CI found** — relative paths resolved
   outside the project workspace. Fixed and covered by a regression test; worth
   noting because it is exactly the class of bug that only shows up when the tests
   actually run.
7. **The generated app must be an Android/Gradle project.** The pipeline injects
   a Gradle workflow; a non-Android target would need a different
   `androidBuildWorkflow` variant.
