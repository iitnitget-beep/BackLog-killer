/**
 * Generates the GitHub Actions workflow that builds the *target* project's APK.
 * The Android SDK never runs on the phone: CI does the heavy lifting and we
 * stream the logs back (spec §5, sandbox).
 */
export interface WorkflowOptions {
  /** Gradle task to run. */
  gradleTask?: string;
  javaVersion?: number;
  apkGlob?: string;
  /** Extra steps injected before the build (e.g. `npm ci`). */
  extraSteps?: string[];
  uploadArtifactName?: string;
}

export function androidBuildWorkflow(options: WorkflowOptions = {}): string {
  const task = options.gradleTask ?? 'assembleDebug';
  const java = options.javaVersion ?? 17;
  const apkGlob = options.apkGlob ?? 'app/build/outputs/apk/debug/*.apk';
  const artifactName = options.uploadArtifactName ?? 'debug-apk';
  return `name: Build APK

on:
  push:
    branches: [ main ]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up JDK ${java}
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '${java}'

      - name: Set up Android SDK
        uses: android-actions/setup-android@v3
${(options.extraSteps ?? []).map((step) => `\n      - name: Extra step\n        run: ${step}`).join('')}

      - name: Build
        run: |
          chmod +x gradlew || true
          ./gradlew ${task} --no-daemon --stacktrace

      - name: Upload APK
        uses: actions/upload-artifact@v4
        with:
          name: ${artifactName}
          path: ${apkGlob}
          if-no-files-found: error
`;
}

/** Workflow for the ForgeX repo itself (spec §6). */
export function forgexSelfWorkflow(): string {
  return `name: Build ForgeX APK

on:
  push:
    branches: [ main ]
    tags: [ 'v*' ]
  workflow_dispatch:

jobs:
  test-core:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
      - run: npm ci
      - run: npm --workspace core run typecheck
      - run: npm --workspace core run test
      - run: npm --workspace core run build

  build-apk:
    needs: test-core
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
      - name: Assemble web assets
        run: |
          npm ci
          npm --workspace core run build
      - name: Build debug APK
        run: |
          cd android
          gradle wrapper --gradle-version 8.7 || true
          ./gradlew assembleDebug --no-daemon --stacktrace
      - uses: actions/upload-artifact@v4
        with:
          name: forgex-debug-apk
          path: android/app/build/outputs/apk/debug/*.apk
          if-no-files-found: error
      - name: Attach APK to release
        if: startsWith(github.ref, 'refs/tags/v')
        uses: softprops/action-gh-release@v2
        with:
          files: android/app/build/outputs/apk/debug/*.apk
`;
}
