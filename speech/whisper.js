'use strict';
// Runs whisper.cpp for live speech-to-text with a small CPU footprint.
//  - Preferred: `whisper-server` is started ONCE (model stays loaded, so each 1-5 s segment costs only inference time).
//  - Fallback:  `whisper-cli` is run once per segment (slower: reloads the model every time).
// Both run at below-normal priority with a fixed thread count (-t 2 or -t 4) so OBS / the stream never starves.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const EXE = process.platform === 'win32' ? '.exe' : '';
const SERVER_NAMES = ['whisper-server' + EXE, 'server' + EXE];
const CLI_NAMES = ['whisper-cli' + EXE, 'main' + EXE, 'whisper' + EXE];

function wavFromPcm16(pcm, rate) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function createWhisper(opts) {
  const dir = path.join(opts.dataDir, 'whisper');
  const modelsDir = path.join(dir, 'models');
  const log = opts.log || (() => {});
  let proc = null, port = 0, mode = '', stderrTail = '', starting = null;

  const exists = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
  function findBin(names, custom) {
    if (custom) {
      if (exists(custom)) return custom;
      const d = path.dirname(custom); for (const n of names) if (exists(path.join(d, n))) return path.join(d, n);
    }
    const roots = [dir, path.join(dir, 'bin'), path.join(dir, 'Release'), path.join(opts.appDir || __dirname, 'whisper')];
    for (const r of roots) for (const n of names) if (exists(path.join(r, n))) return path.join(r, n);
    return '';
  }
  function modelFile(cfg) {
    if (cfg.modelPath && exists(cfg.modelPath)) return cfg.modelPath;
    const p = path.join(modelsDir, 'ggml-' + (cfg.model || 'tiny') + '.bin');
    return exists(p) ? p : '';
  }
  function setup(cfg) {
    const server = findBin(SERVER_NAMES, cfg.binaryPath), cli = findBin(CLI_NAMES, cfg.binaryPath);
    return { dir, modelsDir, server, cli, binary: server || cli, model: modelFile(cfg), modelWanted: path.join(modelsDir, 'ggml-' + (cfg.model || 'tiny') + '.bin') };
  }
  function lower(child) { try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) {} }

  function ping(p) {
    return new Promise((resolve) => {
      const rq = http.get({ host: '127.0.0.1', port: p, path: '/', timeout: 1500 }, (r) => { r.resume(); resolve(r.statusCode > 0); });
      rq.on('error', () => resolve(false)); rq.on('timeout', () => { rq.destroy(); resolve(false); });
    });
  }
  function freePort() {
    return new Promise((resolve, reject) => {
      const s = require('net').createServer(); s.unref(); s.on('error', reject);
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
  }

  async function start(cfg) {
    if (starting) return starting;
    starting = (async () => {
      await stop();
      const su = setup(cfg);
      if (!su.binary) throw new Error('Whisper program not found. Put whisper-server' + EXE + ' (or whisper-cli' + EXE + ') in: ' + dir);
      if (!su.model) throw new Error('Whisper model not found. Download it from the Captions panel, or put ' + path.basename(su.modelWanted) + ' in: ' + modelsDir);
      const threads = String(Math.max(1, Math.min(8, parseInt(cfg.threads, 10) || 2)));
      if (!su.server) { mode = 'cli'; return { mode, binary: su.cli, model: su.model, threads }; }
      port = await freePort(); stderrTail = '';
      const args = ['-m', su.model, '-t', threads, '--host', '127.0.0.1', '--port', String(port)];
      if (cfg.source && cfg.source !== 'auto') args.push('-l', cfg.source); else args.push('-l', 'auto');
      proc = spawn(su.server, args, { cwd: path.dirname(su.server), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      lower(proc);
      const keep = (b) => { stderrTail = (stderrTail + b.toString()).slice(-1500); };
      proc.stdout.on('data', keep); proc.stderr.on('data', keep);
      let exited = false; proc.on('exit', (c) => { exited = true; log('whisper-server exited ' + c); if (proc && proc.pid === pidAtStart) { proc = null; mode = ''; opts.onExit && opts.onExit(c, stderrTail); } });
      const pidAtStart = proc.pid;
      proc.on('error', (e) => { stderrTail += String(e && e.message); exited = true; });
      const t0 = Date.now();
      while (Date.now() - t0 < 45000) {                     // model load: normally 0.2 - 3 s
        if (exited) { const tail = stderrTail.trim().split(/\r?\n/).slice(-3).join(' | '); proc = null; throw new Error('Whisper stopped while starting: ' + tail); }
        if (await ping(port)) { mode = 'server'; return { mode, binary: su.server, model: su.model, threads }; }
        await new Promise((r) => setTimeout(r, 250));
      }
      await stop(); throw new Error('Whisper took too long to start.');
    })();
    try { return await starting; } finally { starting = null; }
  }

  async function stop() {
    const p = proc; proc = null; mode = '';
    if (p) { try { p.kill(); } catch (e) {} await new Promise((r) => setTimeout(r, 150)); }
  }

  function postMultipart(wav, fields) {
    const boundary = '----wcm' + Math.random().toString(16).slice(2);
    const parts = [];
    Object.keys(fields).forEach((k) => parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + fields[k] + '\r\n')));
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="seg.wav"\r\nContent-Type: audio/wav\r\n\r\n'));
    parts.push(wav); parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
    const body = Buffer.concat(parts);
    return new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port, path: '/inference', method: 'POST', timeout: 30000,
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length } }, (res) => {
        const ch = []; res.on('data', (c) => ch.push(c));
        res.on('end', () => {
          const txt = Buffer.concat(ch).toString('utf8');
          if (res.statusCode !== 200) return reject(new Error('Whisper HTTP ' + res.statusCode + ' ' + txt.slice(0, 120)));
          try { const j = JSON.parse(txt); if (j.error) return reject(new Error(String(j.error))); resolve(String(j.text || '')); }
          catch (e) { resolve(txt); }
        });
      });
      rq.on('error', reject); rq.on('timeout', () => { rq.destroy(new Error('Whisper timed out')); });
      rq.write(body); rq.end();
    });
  }

  function runCli(wavBuf, cfg, lang, prompt) {
    const su = setup(cfg), tmp = path.join(os.tmpdir(), 'wcm-seg-' + process.pid + '-' + Date.now() + '.wav');
    fs.writeFileSync(tmp, wavBuf);
    const args = ['-m', su.model, '-f', tmp, '-t', String(Math.max(1, Math.min(8, parseInt(cfg.threads, 10) || 2))), '-l', lang || 'auto', '-nt', '-np', '-bs', '1', '-bo', '1'];
    if (prompt) args.push('--prompt', prompt);
    return new Promise((resolve, reject) => {
      const c = spawn(su.cli, args, { cwd: path.dirname(su.cli), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      lower(c); let out = '', err = '';
      c.stdout.on('data', (b) => { out += b; }); c.stderr.on('data', (b) => { err = (err + b).slice(-800); });
      c.on('error', (e) => { try { fs.unlinkSync(tmp); } catch (x) {} reject(e); });
      c.on('exit', (code) => { try { fs.unlinkSync(tmp); } catch (e) {} if (code === 0) resolve(out); else reject(new Error('whisper-cli failed: ' + err.trim().split(/\r?\n/).slice(-2).join(' | '))); });
    });
  }

  // pcm: Int16 little-endian, 16 kHz mono. Returns plain text (may be empty).
  async function transcribe(pcm, cfg) {
    const wav = wavFromPcm16(pcm, 16000), lang = cfg.source && cfg.source !== 'auto' ? cfg.source : 'auto', prompt = String(cfg.prompt || '').slice(0, 200);
    if (mode === 'server' && proc) {
      const f = { response_format: 'json', temperature: '0.0', language: lang, beam_size: '1', best_of: '1', no_timestamps: 'true' };
      if (prompt) f.prompt = prompt;
      return postMultipart(wav, f);
    }
    if (mode === 'cli') return runCli(wav, cfg, lang, prompt);
    throw new Error('Whisper is not running.');
  }

  return { start, stop, transcribe, setup, isRunning: () => !!mode, mode: () => mode, dir, modelsDir, wavFromPcm16 };
}

module.exports = { createWhisper, wavFromPcm16 };
