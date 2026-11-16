# Private offline APK packaging

**Experimental packaging: NOT deployable.** An authorized Android/Cobalt integration test confirmed that the current loopback loader is rejected by the document's Content Security Policy. The candidate was rolled back. The JavaScript gate therefore did not initialize, and playback routes were not verified. Offline media/JVM/APK tests are not proof that protection works on Android.

This directory builds review candidates only. Do not install this loader until CSP-compatible script initialization and failure handling have been fixed and separately authorized for integration testing. Publishing source does not publish a usable APK; never include APKs, credentials, application data, or personal blocklists in a source push. No command here connects to a TV, changes application data, or imports lists.

The installed private Cobalt APK's c382127 loader points at a public CDN. Instead of publishing this patch, the candidate embeds `dist/userScript.js` as an APK asset. A non-exported Android ContentProvider starts a read-only HTTP server bound to **127.0.0.1:8107** before application startup. The two native loader strings are replaced in place, preserving the ELF layout, to load/check that bundled script. There is no remote-script fallback.

The server only exposes `/tube.js`, accepts GET/HEAD/OPTIONS, and never reads settings, profiles, files or blocklists. Its CORS/preflight headers allow the two HTTPS YouTube origins only. An arbitrary local app can read the public-code bundle, but cannot write or retrieve private application data. The manifest adds `usesCleartextTraffic=true` for this HTTP loopback transport; this is an app-wide Android policy flag, not a user preference change. The provider is not exported and no permissions are added. The current loader fails Android/Cobalt CSP verification: both the loopback script and the splash document's loopback health request are denied, and an inline fallback can also be denied. Cleartext/CORS settings do not override CSP. No fallback protection should be assumed when the script cannot initialize.

## Build without downloads

Use an already installed JDK, Android SDK/build-tools 35.0.0, platform android-36, and cached mods dependencies. Do not run installation scripts, ADB, SDB, or dependency downloads.

```sh
cd mods
npm test
npm run build
cd ..
python3 private-android/build.py /private/path/tizentube-community.apk /private/path/artifacts \
  --sdk "$ANDROID_SDK_ROOT"
```

`JAVA_HOME` is required. If `KEYSTORE_FILE` and `KEYSTORE_PASSWORD` are supplied locally, the candidate is signed using that keystore; otherwise the output is aligned but unsigned. Never put credentials in source, arguments, logs, the APK or chat. The existing original APK is read-only. `hashes.json` records the original APK, bundled JavaScript and candidate hashes. Verify the candidate signer matches the existing private app before any future installation.

The AXML patch preserves existing typed attributes/resources; it adds only the provider and loader policy. APK integrity tests compare every original entry and normalized manifest structure.

## Additional local tests

```sh
PLAYBACK_BASELINE_APK=/private/path/tizentube-community.apk \
PLAYBACK_CANDIDATE_APK=/private/path/artifacts/tizentube-playback-gate.apk \
python3 -m unittest discover -s private-android/tests -v

javac -d /private/path/java-tests \
  private-android/src/io/gh/akshat/tizentube/gate/BundleServer.java \
  private-android/tests/BundleServerTest.java
java -ea -cp /private/path/java-tests BundleServerTest
```

These are JVM/packaging checks, not proof of Android/Cobalt integration or a TV deployment. The playback route tests use synthetic metadata and native-media stand-ins; the private review directory additionally records isolated Chromium tests with real local media.
