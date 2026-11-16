/**
 * A minimal, *known-compiling* Android project skeleton.
 *
 * Why this exists: even the best model occasionally produces a Gradle file with
 * a wrong plugin id or a missing settings file, which burns CI minutes and a
 * repair round. Starting from a skeleton that is known to assemble keeps the
 * agent's job to "write the feature", which is the part models are actually good
 * at. The scaffold is plain text, so it is fully unit-testable.
 */
export interface ScaffoldOptions {
  /** Gradle project name / directory-independent identifier. */
  projectName: string;
  /** Android applicationId, e.g. dev.forgex.timer. */
  packageName: string;
  appName: string;
  minSdk?: number;
  compileSdk?: number;
  /** Kotlin or Compose. Compose is the default because it is one file to render. */
  ui?: 'compose' | 'views';
}

export interface ScaffoldFile {
  path: string;
  content: string;
}

export const DEFAULT_SCAFFOLD: Required<Pick<ScaffoldOptions, 'minSdk' | 'compileSdk' | 'ui'>> = {
  minSdk: 26,
  compileSdk: 34,
  ui: 'compose',
};

/** Validates an Android package name. Returns an error string, or null if OK. */
export function validatePackageName(packageName: string): string | null {
  if (!packageName) return 'package name is empty';
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(packageName)) {
    return `invalid package name "${packageName}": use lowercase segments like dev.forgex.timer`;
  }
  if (packageName.split('.').some((segment) => RESERVED_JAVA_WORDS.has(segment))) {
    return `package name "${packageName}" contains a reserved word`;
  }
  return null;
}

const RESERVED_JAVA_WORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
  'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native',
  'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void',
  'volatile', 'while',
]);

export function androidScaffold(options: ScaffoldOptions): ScaffoldFile[] {
  const settings = {
    minSdk: options.minSdk ?? DEFAULT_SCAFFOLD.minSdk,
    compileSdk: options.compileSdk ?? DEFAULT_SCAFFOLD.compileSdk,
    ui: options.ui ?? DEFAULT_SCAFFOLD.ui,
  };
  const path = options.packageName.replace(/\./g, '/');
  const files: ScaffoldFile[] = [
    {
      path: 'settings.gradle.kts',
      content: `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "${options.projectName}"
include(":app")
`,
    },
    {
      path: 'build.gradle.kts',
      content: `plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.20" apply false
}
`,
    },
    {
      path: 'gradle.properties',
      content: `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official
`,
    },
    {
      path: 'app/build.gradle.kts',
      content: `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "${options.packageName}"
    compileSdk = ${settings.compileSdk}

    defaultConfig {
        applicationId = "${options.packageName}"
        minSdk = ${settings.minSdk}
        targetSdk = ${settings.compileSdk}
        versionCode = 1
        versionName = "1.0"
    }

    buildFeatures {
        compose = ${settings.ui === 'compose'}
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation(platform("androidx.compose:compose-bom:2024.09.03"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
`,
    },
    {
      path: `app/src/main/java/${path}/MainActivity.kt`,
      content: `package ${options.packageName}

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    HomeScreen()
                }
            }
        }
    }
}

@Composable
fun HomeScreen() {
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(text = "${options.appName}", style = MaterialTheme.typography.headlineMedium)
        Text(text = "Built with ForgeX", style = MaterialTheme.typography.bodyMedium)
    }
}
`,
    },
    {
      path: 'app/src/main/AndroidManifest.xml',
      content: `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="true"
        android:label="${options.appName}"
        android:supportsRtl="true"
        android:theme="@style/Theme.Material3.Light.NoActionBar">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`,
    },
    {
      path: 'gradle/wrapper/gradle-wrapper.properties',
      content: `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-8.7-bin.zip
networkTimeout=10000
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`,
    },
    {
      path: 'AGENTS.md',
      content: `# ${options.appName}

Generated by ForgeX.

## Conventions
- Kotlin + Jetpack Compose, Material 3.
- Package: ${options.packageName}
- Keep UI state in a ViewModel; do not block the main thread.
- Every new feature gets a unit test for its non-UI logic.

## Verify
The APK is built by .github/workflows/build-apk.yml with \`./gradlew assembleDebug\`.
`,
    },
    { path: '.gitignore', content: `*.iml\n.gradle/\nlocal.properties\n.idea/\nbuild/\ncaptures/\n.externalNativeBuild\n.cxx/\n` },
  ];
  return files;
}

/** Checks a scaffold is coherent before it is written to a workspace. */
export function validateScaffold(files: ScaffoldFile[]): string[] {
  const problems: string[] = [];
  const paths = new Set(files.map((file) => file.path));
  for (const required of ['settings.gradle.kts', 'app/build.gradle.kts', 'app/src/main/AndroidManifest.xml']) {
    if (!paths.has(required)) problems.push(`missing ${required}`);
  }
  const settings = files.find((file) => file.path === 'settings.gradle.kts')?.content ?? '';
  if (!/include\(":app"\)/.test(settings)) problems.push('settings.gradle.kts does not include :app');
  const manifest = files.find((file) => file.path.endsWith('AndroidManifest.xml'))?.content ?? '';
  if (!manifest.includes('android.intent.category.LAUNCHER')) problems.push('manifest has no launcher activity');
  for (const file of files) {
    if (file.path.endsWith('.kt') && !file.content.includes('package ')) {
      problems.push(`${file.path} has no package declaration`);
    }
  }
  return problems;
}
