import type { Platform } from '../platform/types';
import type { NativeBridge } from '../platform/webview';
import { createMemoryPlatform } from '../platform/memory';
import { createWebViewPlatform } from '../platform/webview';

/**
 * In the real app the Kotlin shell injects `forgeXBridge`. In a desktop browser
 * (the preview build) there is no native bridge, so we fall back to an in-memory
 * workspace seeded with a demo project. The UI is identical; the banner tells the
 * user which mode they are in so nothing is passed off as a device feature.
 */
export interface PlatformChoice {
  platform: Platform;
  mode: 'android' | 'browser-preview';
  note: string;
}

export function resolvePlatform(): PlatformChoice {
  const bridge = (window as unknown as { forgeXBridge?: NativeBridge }).forgeXBridge;
  if (bridge) {
    return {
      platform: createWebViewPlatform(bridge),
      mode: 'android',
      note: 'On-device sandbox',
    };
  }
  const memory = createMemoryPlatform();
  const seeded: Record<string, string> = {
    'AGENTS.md': '# Demo project\n\nThis workspace is an in-browser preview.\nFiles you create here stay in memory until you reload.\n',
    'README.md': '# Timer demo\n\nA tiny project used to exercise the ForgeX screens.\n',
    'app/build.gradle.kts': 'plugins { id("com.android.application") }\n\nandroid {\n  namespace = "dev.forgex.timer"\n  compileSdk = 34\n}\n',
    'app/src/main/java/dev/forgex/timer/MainActivity.kt': 'class MainActivity : ComponentActivity() {\n  override fun onCreate(state: Bundle?) {\n    super.onCreate(state)\n  }\n}\n',
  };
  for (const [path, content] of Object.entries(seeded)) {
    void memory.fs.write(`/workspace/demo/${path}`, content);
  }
  return {
    platform: memory,
    mode: 'browser-preview',
    note: 'Browser preview: workspace is in-memory, model calls need a provider key in Settings.',
  };
}
