package dev.forgex.app

/**
 * Placeholder so the source set always compiles even if the bundled web assets
 * were not copied yet. The real assets are produced by `npm --workspace core run
 * build` and copied into app/src/main/assets/app by the Gradle task
 * `copyForgeXWebAssets` (see app/build.gradle.kts).
 */
internal object WebAssets {
    const val ENTRY = "index.html"
}
