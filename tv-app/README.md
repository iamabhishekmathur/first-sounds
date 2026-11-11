# First Sounds TV

A tiny Android TV / Google TV app that wraps the First Sounds website
(`https://first-sounds-two.vercel.app/?tv=1`) in a full-screen WebView, driven by the TV remote.

- Package `ca.firstsounds.tv`, minSdk 23, target/compile SDK 36, one Java activity.
- Shows on the Google TV home screen (leanback launcher, 320x180 banner). Landscape only.
- JS bridge `FirstSoundsTV.speak(text)` uses Android TextToSpeech (rate 0.85); ignored unless the page is on the site's origin.
- Back key calls `window.FirstSoundsTV_onBack()` in the page; if it returns `true` the key is consumed, otherwise the app closes.
- Offline or load error shows a native message; press OK to retry.
- Only permission: INTERNET. Browsing data (IndexedDB etc.) is kept between launches.

## Build

Needs JDK 17+ and the Android SDK (platform 36, build-tools 36.0.0). Point at the SDK, then:

```
echo "sdk.dir=/path/to/android/sdk" > local.properties     # gitignored
./gradlew :app:assembleRelease
```

Output: `app/build/outputs/apk/release/app-release.apk`. A prebuilt, signed copy is in `dist/first-sounds-tv.apk`.
Banner and icon PNGs can be regenerated with `python3 tools/make_images.py` (Pillow).

## Signing

The release build is signed (v1 + v2) when Gradle finds a keystore, from either:

- env vars `FS_KEYSTORE`, `FS_KEYSTORE_PASSWORD` (optional `FS_KEY_ALIAS`, default `firstsounds`; `FS_KEY_PASSWORD`), or
- a gitignored `keystore.properties` in this folder with `storeFile`, `storePassword`, `keyAlias`.

Without either, the APK is unsigned and will not install. Keep the keystore and password out of the repo and keep a backup:
updates must be signed with the same key.

## Install on a Google TV

Easiest: the "Downloader" app by AFTVnews (Play Store).
1. Host the APK somewhere with a direct URL (for example the raw/download link to `dist/first-sounds-tv.apk`).
2. Open Downloader, enter that URL, and download.
3. When asked, allow "Install unknown apps" for Downloader (Settings), then go back and choose Install.

Alternative: "Send Files to TV" (phone app plus TV app). Send the APK to the TV, open it from the TV app's received files,
and allow "Install unknown apps" for that app when prompted.

Then open First Sounds from the Apps row on the home screen and enter the family code once.
