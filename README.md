# ForgeX

Describe an Android app on your phone. ForgeX plans it, writes it, tests it,
reviews it, pushes it to GitHub, triggers a CI build and hands you an installable
APK.

It is a free, phone-native take on the "agentic coding tool" idea: no desktop, no
Docker, no subscription. The only thing that leaves your device is what you send
to your own model provider and your own GitHub repository.

> **Status:** working end-to-end for the agent pipeline and the app shell. The
> APK is built by GitHub Actions on every push. See [STATUS.md](STATUS.md) for a
> per-feature WORKING / PARTIAL / NOT DONE list — that file is the honest one.

---

## How it works

```
┌────────────────────────────── Your phone ──────────────────────────────┐
│                                                                        │
│  ┌──────────── Kotlin shell (MainActivity) ────────────┐               │
│  │  WebView (assets/app/index.html)                     │              │
│  │        ↕ @JavascriptInterface  "forgeXBridge"        │              │
│  │  ┌──────────────────────────────────────────────┐    │              │
│  │  │ ForgeXBridge                                  │   │              │
│  │  │  files   → app-private sandbox (path-checked) │   │              │
│  │  │  exec    → argv allowlist, no shell           │   │              │
│  │  │  http    → HttpURLConnection                  │   │              │
│  │  │  secrets → EncryptedSharedPreferences         │   │              │
│  │  │  kv      → SQLite (event log, run state)      │   │              │
│  │  │  install → FileProvider + package installer   │   │              │
│  │  └──────────────────────────────────────────────┘    │              │
│  └──────────────────────────────────────────────────────┘              │
│                                                                        │
│  TypeScript agent core (bundled by esbuild, runs in the WebView)       │
│                                                                        │
│   Orchestrator ──spawns──> file-picker · planner · editor ·            │
│        │                   reviewer · security-reviewer ·              │
│        │                   test-fixer · thinker                        │
│        │                                                               │
│        ├── tool registry (read/write/edit/grep/glob/list/run_command)   │
│        ├── approval manager (ASK · AUTO_EDIT · FULL_AUTO)              │
│        ├── event stream (Action → Observation, persisted, replayable)   │
│        ├── context condenser · project memory · skills/microagents      │
│        └── secret scanner (gate before write and before push)           │
└────────────────────────────────────────────────────────────────────────┘
                                   │
                                   │ publish via GitHub Git Data API
                                   ▼
                    ┌──────────────────────────────┐
                    │ GitHub Actions (your repo)   │
                    │  ./gradlew assembleDebug     │
                    │  → artifact: debug APK       │
                    └──────────────────────────────┘
                                   │ logs + artifact stream back
                                   ▼
                     self-repair loop (max 5) → APK downloaded
```

The pipeline is `Plan → Build → Test → Review → Ship`, with each step visible on
the Agent Timeline and stored so an interrupted run can resume.

---

## Repository layout

| Path | What it is |
| --- | --- |
| `core/src/platform/` | The bridge contract + three implementations: Android (WebView), Node, in-memory. |
| `core/src/tools/` | Agent tools with permission classes and path confinement. |
| `core/src/agent/` | Definitions (prompts), single-agent loop, loop detection, approvals, orchestrator, verify loop. |
| `core/src/llm/` | OpenAI-compatible client, provider presets, fallback router. |
| `core/src/events/` | Action/Observation event store and timeline projection. |
| `core/src/context/` | Context condenser. |
| `core/src/security/` | Secret scanner (the pre-write / pre-push gate) and lint hook. |
| `core/src/memory/`, `skills/` | `AGENTS.md`, learned notes, markdown skills and microagents. |
| `core/src/github/`, `ci/` | GitHub REST client, device-flow login, workflow generation, run monitoring, log trimming. |
| `core/src/run/` | The pipeline and its resumable state. |
| `core/src/ui/` | The app UI (five screens) — no framework. |
| `android/` | Kotlin shell, bridge, Keystore secrets, SQLite KV, Robolectric tests. |
| `.github/workflows/build-apk.yml` | Tests the core, tests the sandbox, builds and verifies the APK. |
| `docs/` | Setup and architecture notes. |

---

## Running it

### The agent core (no Android needed)

```bash
npm install
npm --workspace core run typecheck
npm --workspace core run test      # 96 tests
npm --workspace core run build     # → core/dist/core.js, ui.js, index.html
```

Preview the UI in a browser (in-memory workspace, clearly labelled "preview"):

```bash
node core/scripts/serve.mjs        # http://localhost:8080
```

### The APK

CI is the source of truth; it builds on every push and uploads
`forgex-debug-apk`. To build locally you need JDK 17 + Android SDK:

```bash
npm install && npm --workspace core run build
cd android && gradle wrapper --gradle-version 8.7 && ./gradlew assembleDebug
```

The APK lands in `android/app/build/outputs/apk/debug/`. The Gradle build
*copies* `core/dist` into the APK assets, so a Kotlin-only build fails loudly
with instructions rather than shipping a blank app.

### Using it

1. **Settings** — pick a provider preset (OpenRouter, OpenAI, Gemini, Qwen, Groq,
   Ollama/LM Studio) or any OpenAI-compatible base URL, add your key. Choose an
   approval mode.
2. **Ship → GitHub** — sign in with device flow (needs a client id, see
   [docs/SETUP.md](docs/SETUP.md)) or a personal access token, then set the target
   `owner/repo`.
3. **Home** — describe the app, press **New build**.
4. Watch the timeline, edit the plan, approve or deny writes, then take the APK
   from **Ship**.

---

## How each reference repository was used

Full attribution and licence texts are in [NOTICE.md](NOTICE.md).

| Repo | Licence | Taken | Left behind |
| --- | --- | --- | --- |
| **ECC** (`affaan-m/ECC`) | MIT | Prompt defense baseline; planner/reviewer/security-reviewer/error-resolver prompt structure and output discipline; the plan→implement→verify→fresh-review→fix loop; hook-style checks reimplemented as our own secret scan (pre-write, pre-push) and lint-after-edit. | Claude Code plugin install mechanics, hooks JSON. |
| **qwen-code** (`QwenLM/qwen-code`) | Apache-2.0 | The single-agent loop and its stop-reason vocabulary; `ToolInvocation`-style tool contract with `getDefaultPermission`; loop-detection thresholds (5 identical calls, 10 identical contents); the tool set. | Terminal UI, `@google/genai` types, Node-only APIs. |
| **freebuff / codebuff** (`CodebuffAI/freebuff`) | Apache-2.0 | Declarative agent definitions with per-agent tool lists; parent-spawns-helpers orchestration; batching guidance; bounded refinement loop. | Hosted backend, their free-model access and terms, ads, Docker. |
| **OpenHands** (`OpenHands/OpenHands`) | MIT | Action→Observation event model with a persisted replayable log; context condensation that keeps recent turns and never splits tool pairs; microagents loaded by keyword trigger. | The Python platform, Docker runtime, `enterprise/`. |

All four were cloned read-only into `/home/user/refs` (outside this repo) and
studied; none is installed, vendored or executed.

---

## Design notes worth knowing

- **No shell on the phone.** Commands run as an argv vector against an allowlist;
  `splitCommand` rejects `&&`, `|`, `$(`, backticks in TypeScript and
  `ForgeXBridge.exec` rejects anything not on the native allowlist.
- **Two sandboxes, one contract.** Path traversal is rejected in TypeScript
  (`safePath`) *and* natively (`ForgeXBridge.resolvePath`, canonical-path check),
  and the Robolectric tests attack the native one directly.
- **Secrets fail closed.** Keystore unavailable → the app refuses to start rather
  than fall back to plaintext, and never writes keys into the workspace.
- **Nothing is pretended.** If a capability needs a device, a key, or a JDK that
  is not present, the UI says so. [STATUS.md](STATUS.md) is written the same way.
- **Destructive actions are gated.** Force-push, branch deletion and `rm -rf /`
  are refused by the tool layer, and stopping a run or rolling back a step asks
  for confirmation in the UI.

## Licence

Apache-2.0. See [NOTICE.md](NOTICE.md) for third-party attribution.
