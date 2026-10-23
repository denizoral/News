# Frontier Wire for Android

Two native apps (Kotlin, Jetpack Compose, Material 3) in one Gradle project:

| Module | App | Package |
|---|---|---|
| `app` | **Frontier Wire**: the reader app (stories, follows, alerts, accounts) | `com.frontierwire.app` |
| `admin` | **Wire Admin**: the admin panel and changelog, for admin accounts only | `com.frontierwire.admin` |
| `core` | Shared: API client, Keystore-encrypted session storage, theme, notification channels | — |

## Build

Needs JDK 17+ and the Android SDK (on the server: `/opt/android-sdk`).

```sh
android/build-apks.sh                       # both release APKs -> data/apps/
android/build-apks.sh -Pwire.apiBase=https://wire.example.com
cd android && ./gradlew :app:testDebugUnitTest :app:verifyPaparazziDebug :admin:verifyPaparazziDebug
```

The server offers the latest builds at `/apps/frontier-wire.apk` and
`/apps/wire-admin.apk`. Open those on the phone and allow installing from the browser.

`wire.apiBase` (in `gradle.properties`) is the server the apps talk to. It is
`http://192.168.1.33:3000` today, so the apps work on the home network only.
Plain HTTP is allowed for that address alone (`res/xml/network_security_config.xml`).

## Push notifications (Firebase)

Until these are in place the reader app checks for news in the background
about every 15 minutes, and the admin app gets no pushes.

1. Create a Firebase project and add two Android apps: `com.frontierwire.app` and `com.frontierwire.admin`.
2. Download each app's `google-services.json` into `android/app/` and
   `android/admin/`. They're git-ignored, and the build applies the Google
   Services plugin only when the file is there.
3. In Project settings → Service accounts, generate a private key and save it
   on the server as `data/firebase-service-account.json` (`chmod 600`).
4. Rebuild the APKs and restart `frontier-wire`. `/api/user/config` should then report `"push": true`.

## Google sign-in

1. In Google Cloud (the same project as Firebase), create OAuth client ids:
   - a **Web** client;
   - an **Android** client for `com.frontierwire.app` with your signing key's SHA-1.
2. Set `GOOGLE_CLIENT_IDS=<web client id>` in `/root/News/.env` and restart.
   The server checks ID tokens against this audience.
3. The app reads the client id from `/api/user/config` (or from `-Pwire.googleClientId=…`).

## Before the Play Store

- **HTTPS.** Give the site a public HTTPS address (e.g. a Cloudflare Tunnel),
  build with `-Pwire.apiBase=https://…`, and remove the cleartext exception.
- **Signing.** Release builds are signed with the debug key for now. Create
  an upload key, add a `signingConfigs.release`, and enrol in Play App Signing.
- **Store listing.** Add a privacy policy page: accounts store an email, a
  password hash and follows, and push tokens are kept per device. Fill in the
  data-safety form to match.
- **Account deletion.** In-app deletion is done (Account → Delete my account).
  Play also wants a web link for deletion requests.
- **Admin app.** Don't publish Wire Admin publicly. Keep it as a sideloaded
  APK, or use an internal testing track.
