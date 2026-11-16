# Keep the JS bridge: its methods are called by name from JavaScript.
-keepclassmembers class dev.forgex.app.ForgeXBridge {
    public *;
}
