# Setup

## 1. Model provider

ForgeX speaks the OpenAI `/chat/completions` shape, so any of these work with the
same client:

| Preset | Base URL | Notes |
| --- | --- | --- |
| OpenRouter | `https://openrouter.ai/api/v1` | Default; has free-tier coder models |
| OpenAI | `https://api.openai.com/v1` | |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | OpenAI-compatibility endpoint |
| Qwen | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | |
| Groq | `https://api.groq.com/openai/v1` | Fast, good for the file-picker |
| Ollama / LM Studio | `http://127.0.0.1:11434/v1` | Local models; see the note below |
| Custom | anything | Any gateway that speaks the same JSON |

Enter the key in **Settings**. On a device it is written to
`EncryptedSharedPreferences` (Android Keystore); it never enters the workspace,
the event log, or git. If the Keystore cannot initialise, ForgeX refuses to start
instead of storing the key in plaintext.

**Local models:** `127.0.0.1` on the phone is the phone, not your laptop. Use your
machine's LAN address (e.g. `http://192.168.1.20:11434/v1`) and make sure the
server accepts remote connections. Cleartext HTTP is disabled in the manifest, so
expose it over HTTPS or use `adb reverse` during development.

### Fallback

Add more than one provider entry (Settings → preset → Save, then switch preset
and Save) to get automatic fallback. The router retries a provider once on a rate
limit or 5xx, then moves to the next provider/model. Auth errors are not retried:
a bad key is not fixed by another vendor.

## 2. GitHub

Two options:

**A. Device flow (recommended).** Create a GitHub OAuth app
(Settings → Developer settings → OAuth Apps) with the device flow enabled, and
pass its client id at build time:

```bash
cd android
./gradlew assembleDebug -Pforgex.githubClientId=Iv1.xxxxxxxxxxxx
```

or set `forgex.githubClientId` in `~/.gradle/gradle.properties`. The id is a
*public* client id; a client secret is never used or stored, which is the point of
device flow for apps you install from an APK.

**B. Personal access token.** Paste a fine-grained PAT with `contents: write` and
`actions: read` on the target repo. It is stored in the Keystore exactly like a
provider key.

Then set the target **Owner** and **Repository** on the Ship screen. The repo must
already exist (ForgeX does not create repos on your behalf by default; the API
path exists in `GitHubClient.createRepo` and is used by the CLI harness).

## 3. CI for the target app

ForgeX writes `.github/workflows/build-apk.yml` into the generated project. It:

- checks out the repo,
- sets up JDK 17 and the Android SDK,
- runs `./gradlew assembleDebug`,
- uploads `app/build/outputs/apk/debug/*.apk` as an artifact (and fails if
  nothing was produced).

If your generated project uses a different module name or task, edit
`core/src/ci/workflow.ts` (`androidBuildWorkflow`) — it is one function with
named options and is covered by tests.

## 4. Building ForgeX itself

```bash
npm install
npm --workspace core run test        # 96 tests
npm --workspace core run build       # core/dist (copied into the APK)
cd android
gradle wrapper --gradle-version 8.7  # once, if gradlew is absent
./gradlew testDebugUnitTest          # Robolectric path-sandbox + keystore tests
./gradlew assembleDebug              # → app/build/outputs/apk/debug/app-debug.apk
```

Requirements: JDK 17, Android SDK platform 34, build-tools, Node 20+.

### Release builds

The committed workflow produces **debug** APKs signed with CI's ephemeral key —
fine for side-loading. For a release build you need your own keystore:

```bash
keytool -genkey -v -keystore forgex-release.jks -keyalg RSA -keysize 2048 \
        -validity 10000 -alias forgex
```

Store it outside the repository and pass the four values
(`storeFile`, `storePassword`, `keyAlias`, `keyPassword`) through Gradle
properties. Never commit a keystore or its passwords: the pre-push secret scanner
blocks anything that looks like `storePassword = "..."`.

## 5. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `core/dist is missing` during Gradle build | Web bundle not built | `npm --workspace core run build` |
| App refuses to start with a message about the Keystore | Device has no secure lock screen / broken Keystore | Set a screen lock and retry; ForgeX will not degrade to plaintext |
| "all providers failed" | Key invalid or no network | Check Settings; the event log shows each attempt and status code |
| CI run never appears | Workflow file missing on the default branch | Check `.github/workflows/build-apk.yml` exists in the repo |
| APK artifact download 302 without location | Token lacks `actions: read` | Re-issue the PAT with the right scopes |
