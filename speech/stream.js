'use strict';
// "AI Live": runs whisper.cpp's own live-microphone program (`whisper-stream`, called `stream` in older builds)
// as ONE child process and turns its stdout into plain text lines.
//   - tiny model, fixed thread count (-t 2 by default) and below-normal CPU priority, so OBS never starves
//   - VAD mode (--step 0): whisper-stream waits for a pause in speech and prints one finished phrase,
//     so there are no half-written, constantly rewritten lines to clean up
//   - --translate is passed ONLY when asked for. Whisper can only translate INTO ENGLISH; every other
//     target language is handled by speech/translate.js after the text comes out.
// This module knows nothing about captions, Bible references or the overlay: pipeline.js feeds it text callbacks.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const EXE = process.platform === 'win32' ? '.exe' : '';
const NAMES = ['whisper-stream' + EXE, 'stream' + EXE];

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const STAMP = /^\[\d{1,2}:\d{2}:\d{2}[.,]\d+\s*-->\s*\d{1,2}:\d{2}:\d{2}[.,]\d+\]\s*/;
// lines that are program chatter, not speech
const CHATTER = /^(###|init:|whisper_|main:|ggml_|audio_sdl|sdl|found \d+|- capture device|\[start speaking\]|\[blank_audio\]|\[ ?silence ?\]|\[music\])/i;

const exists = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };

function createStream(opts) {
  const log = opts.log || (() => {});
  const dir = path.join(opts.dataDir, 'whisper');
  let proc = null, stopping = false, buf = '', errTail = '', info = null;
  const devices = [];                                   // remembered after the first run: [{ id, name }]

  function find(cfg) {
    if (cfg.streamBinaryPath) {
      if (exists(cfg.streamBinaryPath)) return cfg.streamBinaryPath;
      const d = path.dirname(cfg.streamBinaryPath); for (const n of NAMES) if (exists(path.join(d, n))) return path.join(d, n);
    }
    const roots = [dir, path.join(dir, 'bin'), path.join(dir, 'Release'), path.join(opts.appDir || __dirname, 'whisper')];
    for (const r of roots) for (const n of NAMES) if (exists(path.join(r, n))) return path.join(r, n);
    return '';
  }

  function buildArgs(cfg, model, translate) {
    const threads = String(Math.max(1, Math.min(8, parseInt(cfg.threads, 10) || 2)));
    const a = ['-m', model, '-t', threads, '-l', cfg.source && cfg.source !== 'auto' ? cfg.source : 'auto',
      '--step', '0', '--length', '10000', '-vth', '0.6'];
    if (translate) a.push('--translate');
    const mic = parseInt(cfg.streamMic, 10);
    if (isFinite(mic) && mic >= 0) a.push('-c', String(mic));
    return a;
  }

  function line(raw, onText) {
    const t = String(raw).replace(ANSI, '').trim();
    if (!t || CHATTER.test(t)) return;
    const text = t.replace(STAMP, '').trim();
    if (text) onText(text);
  }

  function noteDevices(chunk) {
    const re = /capture device #(\d+): '([^']*)'/gi; let m;
    while ((m = re.exec(chunk))) { const id = Number(m[1]); if (!devices.some((d) => d.id === id)) devices.push({ id, name: m[2] }); }
  }

  // cb: { onText(text), onExit(code, stderrTail) }. Resolves once the process is running, rejects if it cannot start.
  async function start(cfg, model, translate, cb) {
    await stop();
    const bin = find(cfg);
    if (!bin) throw new Error('whisper-stream' + EXE + ' not found. Put it (with its .dll files) in: ' + dir);
    const args = buildArgs(cfg, model, translate);
    buf = ''; errTail = ''; stopping = false;
    const child = spawn(bin, args, { cwd: path.dirname(bin), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    proc = child;
    child.stdout.on('data', (b) => {
      buf += b.toString('utf8');
      const parts = buf.split(/[\r\n]+/); buf = parts.pop();
      if (buf.length > 4000) buf = '';
      parts.forEach((l) => line(l, cb.onText));
    });
    child.stderr.on('data', (b) => { const s = b.toString('utf8'); noteDevices(s); errTail = (errTail + s).slice(-1500); });
    child.on('exit', (code) => {
      log('whisper-stream exited ' + code);
      if (proc === child) { proc = null; info = null; if (!stopping) cb.onExit && cb.onExit(code, errTail); }
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (e) => { if (proc === child) { proc = null; info = null; } reject(new Error('Could not start whisper-stream: ' + (e && e.message))); });
    });
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) {}
    info = { binary: bin, args, translate: !!translate };
    return info;
  }

  async function stop() {
    const p = proc; if (!p) return;
    stopping = true; proc = null; info = null;
    await new Promise((resolve) => {
      let done = false; const fin = () => { if (!done) { done = true; resolve(); } };
      p.once('exit', fin);
      try { p.kill(); } catch (e) { return fin(); }
      setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} setTimeout(fin, 200); }, 1500);
    });
  }

  return { start, stop, find, isRunning: () => !!proc, info: () => info, devices: () => devices.slice(), dir, buildArgs, _line: line };
}

module.exports = { createStream };
