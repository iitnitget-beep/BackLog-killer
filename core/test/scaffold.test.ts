import { describe, expect, it } from 'vitest';
import { androidScaffold, validatePackageName, validateScaffold } from '../src/scaffold/android';
import { androidBuildWorkflow } from '../src/ci/workflow';

const options = { projectName: 'timer', packageName: 'dev.forgex.timer', appName: 'Timer' };

describe('android scaffold', () => {
  it('produces a coherent, complete project', () => {
    const files = androidScaffold(options);
    expect(validateScaffold(files)).toEqual([]);
  });

  it('places MainActivity in the package directory', () => {
    const files = androidScaffold(options);
    const activity = files.find((file) => file.path.endsWith('MainActivity.kt'));
    expect(activity?.path).toBe('app/src/main/java/dev/forgex/timer/MainActivity.kt');
    expect(activity?.content).toContain('package dev.forgex.timer');
  });

  it('wires the manifest to the launcher activity', () => {
    const files = androidScaffold(options);
    const manifest = files.find((file) => file.path.endsWith('AndroidManifest.xml'))!.content;
    expect(manifest).toContain('android:name=".MainActivity"');
    expect(manifest).toContain('LAUNCHER');
    expect(manifest).toContain('android:exported="true"');
  });

  it('honours SDK overrides', () => {
    const files = androidScaffold({ ...options, minSdk: 24, compileSdk: 35 });
    const build = files.find((file) => file.path === 'app/build.gradle.kts')!.content;
    expect(build).toContain('minSdk = 24');
    expect(build).toContain('compileSdk = 35');
  });

  it('ships the CI workflow the pipeline expects', () => {
    const files = androidScaffold(options);
    const workflow = androidBuildWorkflow();
    expect(workflow).toContain('assembleDebug');
    expect(files.some((file) => file.path === 'AGENTS.md')).toBe(true);
  });

  it('validates package names', () => {
    expect(validatePackageName('dev.forgex.timer')).toBeNull();
    expect(validatePackageName('Timer')).toMatch(/invalid/);
    expect(validatePackageName('dev.forgex.new')).toMatch(/reserved/);
    expect(validatePackageName('')).toMatch(/empty/);
  });

  it('detects an incomplete scaffold', () => {
    const broken = androidScaffold(options).filter((file) => file.path !== 'settings.gradle.kts');
    expect(validateScaffold(broken)).toContain('missing settings.gradle.kts');
  });

  it('is deterministic', () => {
    expect(JSON.stringify(androidScaffold(options))).toBe(JSON.stringify(androidScaffold(options)));
  });
});
