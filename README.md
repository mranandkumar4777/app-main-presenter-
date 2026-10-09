# PRESENTER (p1-app-pc)

Desktop presenter app (Windows / macOS) + Android phone remote.

## Folder layout
```
main.js            Electron app (line 36 = UPDATE_INFO_URL)
preload.js         safe bridge between the page and the app
server.js          built-in server: pages, phone remote (PIN), devices, workspace sync
public/presenter.html   the Presenter control / live page
public/remote.html      the phone remote page (served at /remote)
mobile/            Android app (Capacitor). www/main.js = launcher, www/remote.html = built-in remote,
                   android/ = native project, ALREADY GENERATED (do not delete it)
.github/workflows/ desktop.yml (Win + Mac) and android.yml (APK)
package.json       app + installer (electron-builder) settings
```

## Dockable workspace (Premiere-style)
The Control window is made of 10 panels: AI Controls, Preview, Controls, Live, Slides, Library, Bible, Captions, Lower Thirds, Stage Style.
- **Drag a panel's title bar** onto another panel: left/right edge = side by side, middle = stack, hold **Shift** on the top/bottom half = new row. Drop on the dashed bars at the very top/bottom for a full-width row.
- Drag the dividers to resize, double-click a title bar (or press `` ` ``) to maximize, **x** closes a panel (reopen it from the **Panels** menu).
- **Window** menu: switch / save / reset workspaces. **File** menu: windows, phone, settings, export / import workspaces.
- Layouts saved by older versions are converted automatically. The buttons and settings themselves are unchanged (same ids and handlers).

## Run on your computer
```
npm install
npm start          # opens the app
```
Open the app, click **📱 Phone** for the QR code and the password.

### Phone connection (2 steps)
1. **Scan the QR code**: the phone connects straight away, with no password (the QR code contains none).
2. The phone shows **Choose a mode**: **Remote Control** (full control) or **Main Stage Display** (live slide full screen, view only).
   After choosing, enter the password. It is checked by the computer, which gives the phone a session token for that mode only
   (the password is never stored on the phone). Wrong passwords are limited to 5 tries per minute. Changing the password in
   Settings → PINs, or removing a phone, signs it out immediately. Sessions end after 12 h of no use.
Use a long password (Settings → PINs); the default is a random 6-digit code.
Server only (no window): `npm run server` -> http://localhost:8787/ (PIN printed in the console).

## Build on GitHub
1. Upload everything in this folder to https://github.com/mranandkumar4777/p1-app-pc
2. GitHub -> Settings -> Actions -> General -> Workflow permissions -> **Read and write** -> Save.
3. Actions tab -> **Build desktop app** -> Run workflow (and **Build Android remote app (APK)**).
   Or push a tag: `git tag v1.0.1 && git push origin v1.0.1`.

Results appear on the Releases page:
- `desktop-latest`: Windows .exe, Mac .dmg (Intel + Apple Silicon), desktop-version.json
- `mobile-latest`: PresenterRemote.apk

Push a tag like `v1.0.1`: the workflows use it as the app version (no need to edit package.json).

## How updates reach users
- **Windows**: `electron-updater` checks `desktop-latest` ~5 s after launch (and on Settings -> Check for Updates), downloads in the background, then asks "Restart now / Later". Needs `latest.yml` from the build.
- **Mac**: builds are unsigned, and macOS refuses to auto-install unsigned apps, so Mac keeps the "Download" popup (opens the .dmg link from desktop-version.json).
- **Android**: on the launcher screen the app reads `mobile-version.json` from `mobile-latest`.
  Web files update silently (Capgo OTA, `www-bundle.zip`). A new APK shows an "Update Available" popup, downloads it and opens Android's installer.
  Android needs the same signing key + higher versionCode: the key is `mobile/android/app/presenter-update.keystore`, the versionCode is the workflow run number. Never delete/replace that keystore.
  If a release changes native code or plugins (anything outside `mobile/www`), put that release's versionCode in `mobile/min-native-version-code.txt` so old APKs are forced to update instead of receiving incompatible web files.

## Android notes
- `mobile/android/` is committed on purpose, so the build never has to run `cap add android`. The workflow only runs `cap sync`.
- Upload the whole `mobile` folder including `android` (the folder starts with a dot-free name, but contains `gradlew`; the workflow sets it executable).
- Local build (needs Android Studio / JDK 17): `cd mobile && npm install && npx cap sync android && cd android && ./gradlew assembleDebug`

## Notes
- Builds are unsigned: Windows SmartScreen -> More info -> Run anyway; Mac -> right-click -> Open.
- Phone on other networks: install Tailscale on computer and phone, use the computer's Tailscale address.
- AI song search / detection needs your own Gemini API key (Settings). Model can be changed with the
  PRESENTER_GEMINI_MODEL environment variable (default gemini-2.5-flash).

## Lower thirds

Open the **Lower thirds** panel in the Library sidebar (or use the **Lower thirds** switch in the top bar).

- **Switch ON** – slides and song-lyric lines are shown at the bottom of the Live window / OBS page / Preview window in the selected style.
- **Switch OFF** – slides show as normal centred plain text with no background panel.
- **Catalog** – Glassmorphism (Frost, Smoke), Gradient (Aurora, Ocean), Accent (Gold bar, Crimson bar).
- **Custom styling** – font, text / background / accent colour, background opacity, text size, position (bottom left / centre / right), animation (fade, slide up, slide from left or right, zoom, blur, wipe, none) and animation speed. Changes show in Preview first and reach the Live window / OBS page only on **Go live**.
- The glass style's backdrop blur needs something behind it; on a transparent OBS source it shows as a tinted panel.

## Preview vs Live

Editing a slide, staging a slide, clicking a playlist lyric line, and changing lower-third or font/colour settings only affect **Preview**. The Live screen (and OBS page) change only when you press **Go live** (button, Enter, or Space/phone Go live). Double-clicking a slide no longer sends it live.


## Live captions, translation and automatic Bible references (Whisper)

Click **🎙 Captions** in the Presenter window. It listens to a microphone / mixer input, runs **whisper.cpp** on this PC
(`-t 2` by default, `-t 4` optional, below-normal CPU priority so OBS and the stream stay smooth), and drives a transparent
overlay for OBS.

**One-time setup**
1. Download the whisper.cpp Windows release (`whisper-bin-x64.zip`) from github.com/ggml-org/whisper.cpp -> Releases.
   Copy `whisper-server.exe` and all the `.dll` files into the folder shown in the Captions panel
   (Windows: `%APPDATA%\Presenter\whisper`). `whisper-cli.exe` also works but is slower.
2. In the panel press **Download tiny model** (one file, about 75 MB), or copy `ggml-tiny.bin` into `whisper\models`.
3. In OBS add a **Browser** source: `http://localhost:8787/overlay`, width 1920, height 1080. (`?demo=1` shows a sample.)
4. Pick the microphone, press **Start listening**.

**What it does**
- **Bible references**: says "John chapter 3 verse 16", "Psalm twenty three", "యోహాను సువార్త 3వ అధ్యాయం 16వ వచనం" ->
  an animated card with the reference in **English and Telugu**. Verse text is shown too if you import a Bible
  (`node tools/import-bible.js en "KJV" kjv.tsv` and the same for `te`; see the header of that file).
- **Captions**: live text of the speech, 1-3 s behind. Choose the caption language (English / Telugu / Hindi / Tamil / ...).
  Translation uses your Gemini/OpenRouter keys from Settings (batched), or a LibreTranslate server (free, offline-capable).
- If the PC falls behind, old audio is skipped rather than letting captions lag.

**Accuracy notes**
- `tiny` is fast but weak in Telugu and on sung worship. For Telugu choose **base** or **small** if the PC can take it
  (use 4 threads only if OBS shows no dropped frames).
- Whisper only translates to English itself; every other target language goes through the translator above.
- Gemini's free tier limits requests per minute; for all-day use add several keys, use a paid key, or run LibreTranslate.

## Bible References + Text / Live Captions (columns right of Songs)

Two stacked sections in the Library, next to **Songs**. Everything they produce is staged in **Preview** first; it reaches the Live
window / OBS `/live` page (in the selected lower-third style and animation) only on **Go live**. Turn the **Lower thirds** switch on to
see the lower-third animation in Preview.

**Bible References (top)**
- *Manual*: Book (Genesis to Revelation), Chapter, Verse and optional "to" verse. The verse text appears in an editable box (edit it like
  any text). **Send to Preview** stages it; **Auto** re-sends whenever the selection or the text changes. The reference ("John 3:16") is
  added under the verse because the Live screen shows only the text. EN / Telugu chooses the language of book names and verse text.
- *AI auto mode*: the **AI Auto** switch listens to the microphone; a spoken reference ("John chapter 3 verse 16") fills the selectors and
  the text box and is staged in Preview. Captions then wait 12 s so the verse is not overwritten.
- Verse text comes from your imported Bibles (`node tools/import-bible.js en "KJV" kjv.tsv`, same for `te`). Without an import the
  selectors still work and you can type or paste the verse.

**Text / Live Captions (below)**
- **Language** menu (Telugu, English, Hindi, ...) at the top; changing it applies from the next phrase.
- **AI Live** switch: ON starts speech-to-text, OFF stops Whisper completely (0 % CPU). Live text shows in the box.
- **To Preview** switch: ON stages each new phrase (the last two lines) in Preview; OFF keeps the text in the box only.
- **Go live** sends Preview to Live. **Auto go live** (off by default) skips that check.
- Microphone list (under *Microphone*) fills in after the first start.

The microphone program (`whisper-stream`, tiny model, `-t 2`, below-normal priority) runs while EITHER AI switch is on and stops when both are
off. Starting the old Captions panel's Start button stops it, and vice versa (one microphone user at a time).

**One-time setup** - `whisper-stream` (called `stream` in old builds) exists only when whisper.cpp is built with SDL2
(`cmake -B build -DWHISPER_SDL2=ON && cmake --build build --config Release`). Put `whisper-stream.exe` and its .dll files in
`%APPDATA%\Presenter\whisper`; `ggml-tiny.bin` goes in `whisper\models` (Captions panel -> Download tiny model).

**About translation** - whisper.cpp's `--translate` only translates INTO ENGLISH and `--language` is the SPOKEN language. Target English =
`--translate` (offline; the only change that restarts whisper, about 1 s). Telugu / Hindi / others: whisper transcribes, then the translator
(Gemini / OpenRouter keys or LibreTranslate) translates. Whisper tiny is weak at Telugu; use `base` / `small` if the PC can take it.

Server API (computer only): `GET /api/bible/books`, `GET /api/bible/passage?lang=en&n=43&chapter=3&verse=16&verseEnd=17`,
`POST /api/stt/ai-live {bible?, text?, target?}` (also over `/ws`: `{"t":"aiLive", ...}`).

## UI theme (PRESENTER glass dashboard)

The Control window uses a dark glass theme: card panels (Library, Slides, Preview & Live, AI Controls), a left rail
(Live, Preview, Phone, OBS, Captions, Lower 3rd, Playlist, On air, Lock, Settings) and unified ON/OFF switches, sliders and drop-downs.
The theme is one CSS block at the end of the `<style>` in `public/presenter.html`; the rail only clicks the original (hidden) top-bar
buttons, so every existing handler is unchanged. Press **Reset** in the Workspace bar once to pick up the new default panel widths.
