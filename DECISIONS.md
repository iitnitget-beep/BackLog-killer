# Decisions

Every significant call made while building ForgeX, with the reasoning and the
alternative that was rejected. Decisions are append-only: if one is later
reversed, a new entry says so.

---

### D1. Correction to Step 0: the backup branch was created without switching

The brief asked to create and push `backup/pre-forgex-YYYYMMDD` "with the full
current state". I created and pushed `backup/pre-forgex-20261116` from the
`arena/48cf1f1b-backlog-killer` branch (the state at `b980739`), then returned to
the session branch. Creating a *new* working branch is not possible in this
session: Arena tracks the session by the current branch, so all work must happen
on `arena/48cf1f1b-backlog-killer`.

**Verified:** `gh api repos/.../branches` lists `backup/pre-forgex-20261116`
before any destructive change was made.

### D2. `/refs` is not writable; references live in `/home/user/refs`

The brief asked for clones in `/refs`. This sandbox denies writes to `/`. The
intent — clones *outside* the project tree so they are never committed — is
preserved by `/home/user/refs`, and `refs/` is also in `.gitignore` in case the
path is ever created inside the repo.

### D3. Android shell in Kotlin + UI and agent core in TypeScript (recommended stack, kept)

The recommended stack worked as designed:
- Kotlin activity + `@JavascriptInterface` bridge,
- the agent core and UI bundled by esbuild into `core/dist`,
- served to the WebView from the APK's own assets through
  `shouldInterceptRequest` on `appassets.androidplatform.net`.

Why it is the right call: the entire agent engine is testable in Node (96 tests
run in ~2 seconds), the UI is one bundle, and the native surface stays small and
auditable (~600 lines of Kotlin). A pure-Kotlin agent core would have meant
rewriting provider clients, tool schemas and prompt handling with no test
headroom; a pure-web app could not reach the Keystore, the installer intent, or a
real private sandbox.

### D4. `Room` was rejected in favour of one SQLite table

Spec §5 allowed "Room or SQLite". The persistence need is a string key/value
store for the event log and run state, plus prefix listing. Room adds an
annotation processor, a schema layer and build time for no query benefit here.
`KeyValueStore.kt` is ~70 lines with a real table and an index on `key`.

### D5. Verification is honest: structure locally, compilation in CI

A phone has no JDK and no Android SDK. Rather than fake a build, `verifyLocally`
(`core/src/app/session.ts`) checks the things that are genuinely checkable
offline (settings file, build file, CI workflow) and the real compile happens in
GitHub Actions, whose logs stream back through the event stream. The UI says
"CI" everywhere a user might otherwise assume a local build.

### D6. Git without a git binary: the GitHub Git Data API

A phone-side `git` is a large, fragile dependency (libgit2/JGit), and the
allowlisted `git` binary does not exist on a stock device. Shipping therefore
uses `POST /git/trees` → `POST /git/commits` → `PATCH /git/refs`, which creates
exactly one commit per ship and needs no local repository. Trade-off: no
interactive rebase/merge, and history is linear — acceptable for generated apps.

### D7. No shell on Android; argv allowlist instead

`ProcessBuilder` with an argument vector and an allowlist
(`echo, ls, cat, node, git`) means there is no shell to inject into. The same
restriction is enforced twice: `splitCommand` rejects metacharacters in
TypeScript, and `ForgeXBridge.exec` rejects non-allowlisted binaries natively.
Gradle builds never run on device.

### D8. Secrets: EncryptedSharedPreferences, and fail closed

Provider keys and the GitHub token go through
`EncryptedSharedPreferences` (master key in the Android Keystore). If the
Keystore cannot be initialised the app refuses to start rather than silently
writing plaintext — a visible `TextView` explains why. The settings blob stored
in SQLite deliberately excludes the key on device.

### D9. Approval modes: fail closed when no UI is attached

`ASK` mode with no approval handler denies rather than allows
(`ApprovalManager.check`). `deny` (destructive commands) is never overridable by
`FULL_AUTO`. Destructive patterns are refused at the tool layer *and* confirmed
in the UI.

### D10. Provider fallback: retry once per provider, then move on

`ProviderRouter` retries a provider once (rate limit or 5xx), then falls through
to the next configured provider and model. Auth errors (401/403) do **not**
retry: a bad key is not fixed by another vendor, and retrying just burns quota.
All attempts are recorded as `RouterEvent`s for the log.

### D11. CI repair loop is bounded at 5 and then stops

Per spec §4, the self-repair loop runs at most 5 times. On exhaustion the run
becomes `failed`, a `gate_blocked` event is written, and the user is asked. This
is tested (`test/pipeline.test.ts` "stops after 5 CI repair attempts").

### D12. One commit per ship, not per agent action

Agents write files freely in the workspace; a commit is created at the Ship step
(and on each CI repair round). This keeps the generated repository readable and
avoids pushing broken intermediate states that would trigger dozens of CI runs.

### D13. UI is framework-free

No React/Preact: the app is ~140 KB of JS including the whole agent core. On a
low-end phone the difference matters, and the UI is small enough to keep as
`innerHTML` rendering plus event delegation. `test/ui.test.ts` runs the real
render functions through a minimal DOM shim so screens are covered without a
browser.

### D14. GitHub device flow, no embedded client secret

Public clients must not embed a client secret. `GitHubDeviceFlow` implements
`/login/device/code` + `/login/oauth/access_token` polling; the client id is a
build-time field (`forgex.githubClientId`), empty by default, so a fork does not
inherit someone else's OAuth app. Without a client id the UI says exactly what is
missing and offers a personal access token instead.

### D15. The browser preview is labelled as such

The same UI runs in a desktop browser for development (in-memory platform,
seeded demo workspace). The header badge reads `preview` instead of `device`, and
the seed data lives only in memory. Nothing in the browser mode claims to have
touched the Keystore, the installer, or a real repository.

### D16. No APK signing key is committed

The debug APK is signed with CI's ephemeral debug key, which is fine for
side-loading a build artifact. A release build needs a real keystore that must
never enter git; the workflow only produces debug APKs, and the release path is
documented in `docs/SETUP.md` as a manual, user-supplied step.

### D17. Event log retention

`EventStore` keeps the last 2000 events per run (pruned with 25% slack to avoid
rewriting on every append). Enough for the timeline and post-mortems on a phone;
bounded so SQLite does not grow without limit.

### D18. ECC's hook *engine* is ported, not simulated in a prompt

The first ECC pass only rewrote prompt text (see NOTICE §1). That is not what
ECC is: its value is the runtime contract — a hook returns **exit 0 to allow** or
**exit 2 to block**, stderr alone only warns, hooks run in declaration order and
the first block stops the chain. ForgeX now implements that contract in
`core/src/ecc/` (`types.ts`, `runner.ts`, `registry.ts`, `hooks/*`), and every
tool call goes through it.

Consequences worth naming:

- **One choke point.** `core/src/agent/executor.ts` is the only way a tool runs:
  PreToolUse hooks → permission class → approval manager → execute → PostToolUse
  hooks. Every branch returns an envelope, so the model always gets an answer.
- **A crashing hook warns and continues; it never silently allows.** A hook that
  throws or exceeds its 2 s timeout is reported as `severity: 'warn'` with the
  error text. Failing *open* silently would make the guards decorative.
- **Errs toward blocking where it matters.** `pre:config-protection` treats an
  unknown "does this file exist" probe as "exists", because letting an agent
  overwrite `tsconfig.json` after a failed liveness check is the exact failure
  the hook exists to prevent.
- **GateGuard keeps ECC's actual insight** — ask for concrete facts, never "are
  you sure?" — and raises once per path per run; a file already read this run, a
  new file, or a comment/whitespace-only change passes without a gate.
- **Stop gates are real gates.** `stop:unverified-claim` returning exit 2 is fed
  back to the model as a user turn and the loop continues (up to 2 retries)
  instead of the run ending. Without that, "tests pass" on an unverified build
  would be a string we could not act on.

### D19. Hook metadata lives in TypeScript, not in a JSON sidecar

ECC splits `hooks/hooks.json` (what Claude Code loads) from
`hooks/hooks.metadata.json` (ids, descriptions, fingerprints) because that
loader rejects unknown keys and its CI verifies the two files against hashes.
That constraint does not exist for a compiled bundle. `core/src/ecc/registry.ts`
holds the graph and `hookCatalogue()` renders it for Settings; `test/hooks.test.ts`
asserts the declared `blocking` flags match the exit codes the hooks actually
return, which is the property the fingerprint file was protecting.

### D20. Seven ECC skills are vendored; selection is trigger-based

ECC ships 314 skills, each a `SKILL.md` with only `name`, `description` and
`metadata.origin` in its front matter — no triggers, no globs, no embedding. So
*selection* has to be ours. Seven skills are relevant to an Android generator
(`android-clean-architecture`, `kotlin-patterns`,
`compose-multiplatform-patterns`, `kotlin-coroutines-flows`, `kotlin-testing`,
`tdd-workflow`, `security-review`); they are vendored verbatim, MIT attribution
kept in the file and in NOTICE §1b, and bundled as text by esbuild
(`--loader:.md=text`).

- Selection is **deterministic and cheap**: case-insensitive trigger words plus
  an agent allow-list plus a 24 000-character budget, so a low-end phone never
  ships 100 KB of guidance per turn. Truncations and dropped skills are reported,
  not hidden.
- A user skill in `.forgex/skills` with the same name **overrides** the built-in,
  so a generated project can specialise the house style without forking the app.
- Vendored files carry an attribution comment *above* the `---` front matter;
  `parseSkillFile` strips leading comments so a faithfully vendored file still
  parses. (A "must start with `---`" parser failed on exactly this.)

### D21. Skills ship inside the APK, and can be installed into the project

The built-ins are compiled into the bundle so the app works offline and a fresh
install already has useful guidance. Settings also offers "Install copy", which
writes the skill into `<project>/.forgex/skills/<name>.md` with our own front
matter (name, description, triggers, enabled, origin). That file is visible in
the Workspace screen, editable, and wins over the built-in — the user can read
and change the exact text that steers their agents, which a hidden prompt could
not offer.

### D22. Three distribution paths for the APK, because artifacts are not portable

GitHub Actions artifacts are the obvious channel and the worst one to depend on:
they expire, they require a login, and they are served from an Azure blob host
that some clients cannot reach at all (this development sandbox cannot). A user
asking "give me the APK link" cannot use an artifact URL.

Every successful `build-apk` job now publishes the same bytes three ways:

1. `actions/upload-artifact@v4` — unchanged, for CI debugging and the
   `web-bundle`/`android-test-reports` companions.
2. A rolling release, tag `forgex-apk-latest`, asset `app-debug.apk`, with the
   commit SHA, byte size and `sha256` in the release body. This is the link a
   human should be given.
3. A force-pushed `forgex-apk` branch containing `forgex-debug.apk` and a
   README. This exists specifically so an automation that can only reach
   `api.github.com` can still read the exact bytes through the Git blob API.

The two copies are the same file (verified by matching size + `sha256`), and the
tag-based release path is skipped for forks that cannot write releases.

Note on the drive step: with no real device here, "install and launch" is still
unverified (see STATUS). Uploading the file proves the artifact is intact and
transferable, not that it runs. The debug key is CI's ephemeral one, so the
release notes say side-load only.
