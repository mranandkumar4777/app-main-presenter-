'use strict';
// Presenter desktop app (Electron main process).
// - starts the helper server (pages, phone remote, PIN) inside the app
// - opens the Control window; Live / Preview windows are opened by the page itself
// - "Check for Updates" reads a small JSON file published on GitHub Releases
// - AI API keys (Gemini / OpenRouter, several each) are stored encrypted by the operating system (safeStorage)
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, session } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const server = require('./server');
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (e) { /* not installed: falls back to the manual checker below */ }

// ---------------------------------------------------------------------------------------------
// Settings you may want to change
// ---------------------------------------------------------------------------------------------
const { createAiHub, parseModelList, parseKeys } = require('./ai-hub');   // Gemini + OpenRouter, multi-key rotation, model fallback
const UPDATE_CHECK_TIMEOUT_MS = 10000;
const WINDOW_DEFAULT = { width: 1280, height: 800 };
// How updates work
//  1. Push a version tag (git tag v1.0.1 && git push origin v1.0.1) or run the "Build desktop app" workflow.
//  2. GitHub builds the Windows and Mac installers and publishes them to the release "desktop-latest",
//     together with desktop-version.json (the file named below).
//  3. In the app: Settings -> Check for Updates reads that file and offers the download if the
//     version in it is higher than the version in package.json.
// Keep "version" in package.json in step with the tag you push.
// Release files are named like Presenter-1.0.1-win-x64.exe and Presenter-1.0.1-mac-arm64.dmg
// (see "artifactName" in package.json), so desktop-version.json can link to them directly.
// Unsigned builds: Windows SmartScreen / macOS Gatekeeper show a warning the first time.
// If you later buy a code-signing certificate, nothing in this file has to change.
//
//
//
// Where "Check for Updates" looks. The GitHub Action in .github/workflows/desktop.yml writes this
// file (desktop-version.json) to the "desktop-latest" release of the repository on every build.
// Format: { "version": "1.0.1", "notes": "...", "windows": "<url>", "mac_arm64": "<url>", "mac_x64": "<url>" }
const UPDATE_INFO_URL = 'https://github.com/mranandkumar4777/p1-app-pc/releases/download/desktop-latest/desktop-version.json';
const RELEASES_PAGE = 'https://github.com/mranandkumar4777/p1-app-pc/releases';

let mainWindow = null;
let serverInfo = null;
let bgMode = 'dark';          // 'dark' | 'transparent' (Live window background)
let checking = false;

// ---------------------------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------------------------
function createMainWindow() {
  mainWindow = new BrowserWindow(Object.assign({}, WINDOW_DEFAULT, {
    backgroundColor: '#0b1220',
    title: 'PRESENTER',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  }));
  mainWindow.loadURL('http://localhost:' + serverInfo.port + '/');
  mainWindow.on('closed', () => { mainWindow = null; });

  // Live / Preview windows are opened by the page with window.open(...?mode=display|preview)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    let u; try { u = new URL(url); } catch (e) { return { action: 'deny' }; }
    if (u.origin === 'http://localhost:' + serverInfo.port) {
      const live = u.searchParams.get('mode') === 'display';
      const web = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true };
      // Live window: ALWAYS created transparent + frameless (Electron cannot change this after creation).
      // The page paints it black in "Dark" mode and leaves it clear in "Transparent" mode, so OBS
      // Window Capture sees real transparency (use the "Windows 10 (1903 and up)" capture method).
      const liveOpts = { transparent: true, frame: false, backgroundColor: '#00000000', hasShadow: false, alwaysOnTop: bgMode === 'transparent' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: Object.assign({ autoHideMenuBar: true, backgroundColor: '#000000', webPreferences: web }, live ? liveOpts : {})
      };
    }
    if (/^https?:$/.test(u.protocol)) shell.openExternal(url);   // e.g. the Google search link
    return { action: 'deny' };
  });
}

// ---------------------------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------------------------
function cmpVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
function downloadUrlFor(info) {
  if (process.platform === 'win32') return info.windows;
  if (process.platform === 'darwin') return process.arch === 'arm64' ? info.mac_arm64 : info.mac_x64;
  return info.url || RELEASES_PAGE;
}
async function checkForUpdates() {
  const current = app.getVersion();
  if (checking) return { status: 'busy', current };
  checking = true;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), UPDATE_CHECK_TIMEOUT_MS);
    let r; try { r = await fetch(UPDATE_INFO_URL + '?t=' + Date.now(), { signal: ctl.signal, cache: 'no-store' }); } finally { clearTimeout(t); }
    if (!r.ok) return { status: 'error', current, error: 'The update file was not found yet (HTTP ' + r.status + ').' };
    const info = await r.json();
    const latest = String(info.version || '').trim();
    if (!latest) return { status: 'error', current, error: 'The update file has no version.' };
    if (cmpVersions(latest, current) <= 0) return { status: 'uptodate', current, latest };
    const parent = mainWindow || undefined;
    const choice = await dialog.showMessageBox(parent, {
      type: 'info', buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1,
      title: 'Update available',
      message: 'Presenter ' + latest + ' is available (you have ' + current + ').',
      detail: info.notes ? String(info.notes).slice(0, 500) : ''
    });
    if (choice.response === 0) { shell.openExternal(downloadUrlFor(info) || RELEASES_PAGE); return { status: 'available', current, latest }; }
    return { status: 'dismissed', current, latest };
  } catch (e) {
    return { status: 'error', current, error: e && e.name === 'AbortError' ? 'Timed out.' : 'No internet connection?' };
  } finally { checking = false; }
}


// ---------------------------------------------------------------------------------------------
// Automatic updates (electron-updater) - Windows installer builds
// ---------------------------------------------------------------------------------------------
// Feed = the rolling GitHub release "desktop-latest" (see build.publish in package.json). The
// workflow uploads latest.yml + the .exe there. We use the generic provider on purpose: the GitHub
// provider looks at the newest release of the whole repo, which could be "mobile-latest".
// macOS: Squirrel.Mac refuses unsigned apps, so the Mac build keeps the manual flow above.
const AUTO_UPDATE = !!autoUpdater && app.isPackaged && process.platform === 'win32';
let updateState = { status: 'idle' };
function sendUpdate(s) { updateState = s; if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('presenter:updateStatus', s); }
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;            // download in the background
  autoUpdater.autoInstallOnAppQuit = true;    // if the user clicks "Later", it installs when they quit
  autoUpdater.on('checking-for-update', () => sendUpdate({ status: 'checking' }));
  autoUpdater.on('update-available', (i) => sendUpdate({ status: 'downloading', latest: i.version, percent: 0 }));
  autoUpdater.on('update-not-available', (i) => sendUpdate({ status: 'uptodate', current: app.getVersion(), latest: i && i.version }));
  autoUpdater.on('download-progress', (p) => sendUpdate({ status: 'downloading', latest: updateState.latest, percent: Math.round(p.percent || 0) }));
  autoUpdater.on('error', (e) => sendUpdate({ status: 'error', error: String(e && e.message || e).slice(0, 200) }));
  autoUpdater.on('update-downloaded', async (i) => {
    sendUpdate({ status: 'ready', latest: i.version });
    const choice = await dialog.showMessageBox(mainWindow || undefined, {
      type: 'info', buttons: ['Update Now', 'Later'], defaultId: 0, cancelId: 1,
      title: 'Update ready',
      message: 'Presenter ' + i.version + ' has been downloaded.',
      detail: 'Update Now restarts Presenter and installs it. If you choose Later, it installs the next time you close Presenter.'
    });
    if (choice.response === 0) setImmediate(() => autoUpdater.quitAndInstall());
  });
}
async function autoCheck() {
  try { await autoUpdater.checkForUpdates(); } catch (e) { /* 'error' event already reported it */ }
}

// ---------------------------------------------------------------------------------------------
// Gemini API key (encrypted with the OS keychain when available) + AI helpers
// ---------------------------------------------------------------------------------------------
// All keys live in ONE encrypted file: { geminiKeys:[], openrouterKeys:[], models:[{provider,model}] }.
const cfgFile = () => path.join(app.getPath('userData'), 'ai-config.bin');
const legacyKeyFile = () => path.join(app.getPath('userData'), 'gemini.key');
function decode(raw) {
  if (raw[0] === 0x45 /* 'E' */) return safeStorage.decryptString(raw.subarray(1));
  return raw.subarray(1).toString('utf8');             // 'P' = stored without encryption
}
function encode(text) {
  if (safeStorage.isEncryptionAvailable()) return Buffer.concat([Buffer.from('E'), safeStorage.encryptString(text)]);
  return Buffer.concat([Buffer.from('P'), Buffer.from(text, 'utf8')]);
}
function loadAiConfig() {
  let c = {};
  try { c = JSON.parse(decode(fs.readFileSync(cfgFile()))) || {}; } catch (e) {}
  if (!c.geminiKeys) {                                  // one-time import of the old single Gemini key
    try { const k = decode(fs.readFileSync(legacyKeyFile())).trim(); if (k) c.geminiKeys = [k]; } catch (e) {}
  }
  c.geminiKeys = c.geminiKeys || []; c.openrouterKeys = c.openrouterKeys || []; c.models = c.models || [];
  return c;
}
function saveAiConfig(c) { fs.writeFileSync(cfgFile(), encode(JSON.stringify(c))); }

const aiHub = createAiHub({ load: loadAiConfig, save: saveAiConfig });
// The page only ever sees counts / last-4 digits, never a full key.
function keyStatus() {
  const s = aiHub.status();
  return { has: s.has, last4: (s.last4.gemini[0] || s.last4.openrouter[0] || ''), geminiKeys: s.geminiKeys, openrouterKeys: s.openrouterKeys,
           models: s.models, modelsText: s.models.map((m) => m.provider + ':' + m.model).join('\n'), encrypted: safeStorage.isEncryptionAvailable() };
}
// patch = { geminiKeys?: string (one per line / comma), openrouterKeys?: string, models?: string }; '' clears a field.
function setAiConfig(patch) {
  const c = loadAiConfig();
  if (patch.geminiKeys !== undefined) c.geminiKeys = parseKeys(patch.geminiKeys);
  if (patch.openrouterKeys !== undefined) c.openrouterKeys = parseKeys(patch.openrouterKeys);
  if (patch.models !== undefined) c.models = parseModelList(patch.models);
  saveAiConfig(c);
  try { fs.unlinkSync(legacyKeyFile()); } catch (e) {}
  return { ok: true };
}

const aiLyrics = (query, ctx) => aiHub.lyricsSlides(query, ctx);
// Desktop mic: (wavBase64, ctx). Phone relay sends { base64, mime } as well.
const aiIdentify = (audio, ctx) => aiHub.identify(typeof audio === 'string' ? { base64: audio, mime: 'audio/wav' } : audio, ctx);
// Old shape used by the continuous listener: { isSong, title, artist, confidence, transcript }
async function aiDetect(wavB64, ctx) {
  const r = await aiIdentify(wavB64, { hint: ctx && ctx.recentTranscript });
  if (!r.ok) return r;
  return { ok: true, isSong: r.isSong, title: r.best.title, artist: r.best.artist, confidence: r.best.confidence, transcript: r.transcript, similar: r.similar };
}

// Tailscale shows up as a network adapter with an address in 100.64.0.0/10 (100.64.x.x - 100.127.x.x)
ipcMain.handle('presenter:tailscaleStatus', () => {
  const addresses = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach((k) => (ifs[k] || []).forEach((a) => {
    if (a.family === 'IPv4' && !a.internal) { const p = a.address.split('.').map(Number); if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) addresses.push(a.address); }
  }));
  return { online: addresses.length > 0, addresses };
});
ipcMain.handle('presenter:getVersion', () => app.getVersion());
ipcMain.handle('presenter:checkForUpdates', async () => {
  if (!AUTO_UPDATE) return checkForUpdates();                       // Mac / dev run: manual flow
  if (updateState.status === 'downloading' || updateState.status === 'checking') return { status: 'busy', current: app.getVersion() };
  if (updateState.status === 'ready') { autoUpdater.quitAndInstall(); return { status: 'ready', current: app.getVersion(), latest: updateState.latest }; }
  try {
    const r = await autoUpdater.checkForUpdates();
    const latest = r && r.updateInfo && r.updateInfo.version;
    if (!latest || cmpVersions(latest, app.getVersion()) <= 0) return { status: 'uptodate', current: app.getVersion(), latest };
    return { status: 'downloading', current: app.getVersion(), latest };
  } catch (e) { return { status: 'error', current: app.getVersion(), error: 'No internet connection, or the update file is missing.' }; }
});
ipcMain.handle('presenter:setBgMode', (_e, mode) => { bgMode = mode === 'transparent' ? 'transparent' : 'dark'; return true; });
ipcMain.handle('presenter:ai:keyStatus', () => keyStatus());
ipcMain.handle('presenter:ai:setKey', (_e, k) => { try { return setAiConfig({ geminiKeys: String(k || '') }); } catch (e) { return { ok: false, error: 'Could not store the key.' }; } });
ipcMain.handle('presenter:ai:setConfig', (_e, p) => { try { return setAiConfig(p || {}); } catch (e) { return { ok: false, error: 'Could not store the settings.' }; } });
ipcMain.handle('presenter:ai:identify', (_e, audio, c) => aiIdentify(audio, c));
ipcMain.handle('presenter:ai:lyrics', (_e, q, c) => aiLyrics(q, c));
ipcMain.handle('presenter:ai:detect', (_e, wav, c) => aiDetect(wav, c));

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    // microphone is needed for AI song detection; allow it only for the app's own pages
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media' && /^http:\/\/localhost:/.test(wc.getURL())));
    serverInfo = await server.start({ dataDir: app.getPath('userData'), appDir: __dirname, ai: { identify: aiIdentify, lyrics: aiLyrics, translate: (t, to, from) => aiHub.translate(t, to, from) } });
    createMainWindow();
    if (AUTO_UPDATE) { setupAutoUpdater(); setTimeout(autoCheck, 5000); }   // check shortly after launch
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createMainWindow(); });
  }).catch((e) => { dialog.showErrorBox('Presenter could not start', String(e && e.message || e)); app.quit(); });
  app.on('will-quit', () => { try { serverInfo && serverInfo.speech && serverInfo.speech.stop(); } catch (e) {} });   // never leave whisper-server running
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
