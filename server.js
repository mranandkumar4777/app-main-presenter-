'use strict';
// Presenter helper server: serves the pages, relays phone-remote commands (SSE + POST),
// keeps the connection PIN, the list of connected phones and the shared Workspace layout.
const http = require('http');
const fs = require('fs');
const { createPipeline } = require('./speech/pipeline');
const bibleLib = require('./speech/bible');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const isTailscale = (a) => { const p = String(a).split('.').map(Number); return p[0] === 100 && p[1] >= 64 && p[1] <= 127; };
// G.711 mu-law -> 16-bit PCM (phones send 8-bit mu-law to halve the upload)
const MULAW = (() => { const t = new Int16Array(256); for (let i = 0; i < 256; i++) { let u = ~i & 0xff; const sign = u & 0x80, exp = (u >> 4) & 7, man = u & 15; let s = ((man << 3) + 0x84) << exp; s -= 0x84; t[i] = sign ? -s : s; } return t; })();
function mulawToWav(buf, rate) {
  const n = buf.length, out = Buffer.alloc(44 + n * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + n * 2, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) out.writeInt16LE(MULAW[buf[i]], 44 + i * 2);
  return out;
}
function wsFrame(opcode, payload) {
  const n = payload.length; let head;
  if (n < 126) head = Buffer.from([0x80 | opcode, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, payload]);
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const BLOCK_MS = 24 * 3600 * 1000;

function start(opts) {
  opts = opts || {};
  const dataDir = opts.dataDir || path.join(__dirname, 'data');
  const wantedPort = Number(opts.port || process.env.PORT || 8787);
  fs.mkdirSync(dataDir, { recursive: true });

  // ---- settings (connection PIN) ----
  const cfgFile = path.join(dataDir, 'server-config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) || {}; } catch (e) {}
  if (!cfg.pin) { cfg.pin = String(crypto.randomInt(100000, 1000000)); saveCfg(); }
  function saveCfg() { try { fs.writeFileSync(cfgFile, JSON.stringify(cfg)); } catch (e) {} }
  function pinOk(p) {
    const a = Buffer.from(String(p || '')), b = Buffer.from(String(cfg.pin));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // ---- live speech: Whisper -> Bible references / captions -> overlay page (see speech/) ----
  const speech = createPipeline({
    dataDir, appDir: opts.appDir, ai: opts.ai,
    emit: (m) => broadcast(Object.assign({ from: 'server', type: 'lt-overlay' }, m))
  });
  function readRaw(req, limit) {
    return new Promise((resolve, reject) => {
      let n = 0; const parts = [];
      req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('too big')); req.destroy(); } else parts.push(c); });
      req.on('end', () => resolve(Buffer.concat(parts)));
      req.on('error', reject);
    });
  }

  // ---- phone sessions: a phone connects with NO password, picks a mode, then proves the password once ----
  // and receives a random session token for that mode. The password itself is never stored on the phone.
  //   'remote' = full remote control (as before)      'stage' = read-only Main Stage Display (live text + style only)
  const MODES = ['remote', 'stage'];
  const SESSION_TTL = 12 * 3600 * 1000;           // sliding: every use renews it
  const sessions = new Map();                     // token -> { device, mode, ip, t }
  const authFails = new Map();                    // ip -> { n, t } failed /api/auth attempts
  function authLimited(ip) { const f = authFails.get(ip); return !!(f && f.n >= 5 && Date.now() - f.t < 60000); }
  function noteAuthFail(ip) { const f = authFails.get(ip); if (!f || Date.now() - f.t > 60000) authFails.set(ip, { n: 1, t: Date.now() }); else { f.n++; f.t = Date.now(); } }
  function sessionFor(token) {
    token = String(token || ''); if (!token) return null;
    const s = sessions.get(token); if (!s) return null;
    if (Date.now() - s.t > SESSION_TTL) { sessions.delete(token); return null; }
    const d = devices.get(s.device); if (d && d.blocked) { sessions.delete(token); return null; }
    s.t = Date.now(); return s;
  }
  // Who is this request? the connection PIN (the computer's own windows, older remotes) or a session token (phones).
  function authOf(pin, token) {
    if (pin && pinOk(pin)) return { mode: 'remote', byPin: true };
    const s = sessionFor(token); return s ? { mode: s.mode, byPin: false, device: s.device, token: String(token) } : null;
  }
  function dropSessions(filter) { for (const [k, v] of Array.from(sessions)) if (filter(v)) sessions.delete(k); }

  // ---- workspace layouts (shared by every Control window) ----
  const wsFile = path.join(dataDir, 'workspace.json');
  let ws = { rev: 0, current: null, custom: {}, names: [] };
  try { ws = Object.assign(ws, JSON.parse(fs.readFileSync(wsFile, 'utf8'))); } catch (e) {}

  // ---- state ----
  const clients = new Set();          // { res, device, isLocal }
  const devices = new Map();          // id -> { id, name, ip, lastSeen, blocked, blockedAt }
  let lastState = null;
  const fails = new Map();            // ip -> { n, t } failed PIN attempts

  const isLoopback = (req) => /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '');
  const clientIp = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');

  function limited(ip) { const f = fails.get(ip); return !!(f && f.n >= 10 && Date.now() - f.t < 60000); }
  function noteFail(ip) { const f = fails.get(ip); if (!f || Date.now() - f.t > 60000) fails.set(ip, { n: 1, t: Date.now() }); else { f.n++; f.t = Date.now(); } }

  function touchDevice(req, id, name) {
    if (!id) return null;
    id = String(id).slice(0, 40);
    let d = devices.get(id);
    if (!d) { d = { id, name: 'Phone', ip: clientIp(req), lastSeen: Date.now(), blocked: false, blockedAt: 0 }; devices.set(id, d); }
    if (name) d.name = String(name).slice(0, 40);
    d.ip = clientIp(req); d.lastSeen = Date.now();
    if (d.blocked && Date.now() - d.blockedAt > BLOCK_MS) d.blocked = false;
    return d;
  }
  const deviceConnected = (id) => { for (const c of clients) if (c.device === id) return true; return false; };

  // Main Stage Display phones only ever see the live slide and its style, never the library, previews or commands.
  function stageView(obj) {
    return obj && obj.from === 'control' && obj.type === 'state' ? { from: 'control', type: 'state', live: obj.live, style: obj.style } : null;
  }
  function broadcast(obj) {
    const text = JSON.stringify(obj); let sv = null;
    for (const c of clients) {
      try {
        if (obj.type === 'lt-overlay' && !c.overlay) continue;       // caption / Bible traffic only goes to the overlay page and the Control window
        let t = text;
        if (c.mode === 'stage') { if (sv === null) { const v = stageView(obj); sv = v ? JSON.stringify(v) : ''; } if (!sv) continue; t = sv; }
        if (c.send) c.send(t); else c.res.write('data: ' + t + '\n\n');
      } catch (e) {}
    }
  }
  function replayState(c) {
    if (!lastState) return;
    const t = c.mode === 'stage' ? JSON.stringify(stageView(lastState)) : JSON.stringify(lastState);
    if (c.send) c.send(t); else c.res.write('data: ' + t + '\n\n');
  }
  function dropClients(filter) { for (const c of Array.from(clients)) if (filter(c)) { try { if (c.close) c.close(); else c.res.end(); } catch (e) {} clients.delete(c); } }

  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let n = 0; const parts = [];
      req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('too big')); req.destroy(); } else parts.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (e) { resolve({}); } });
      req.on('error', reject);
    });
  }
  function addresses() {
    const out = [];
    const ifs = os.networkInterfaces();
    Object.keys(ifs).forEach((k) => (ifs[k] || []).forEach((a) => { if (a.family === 'IPv4' && !a.internal) out.push(a.address); }));
    return out;
  }

  let boundPort = wantedPort;
  function servePage(req, res, file, inject) {
    let html;
    try { html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8'); } catch (e) { res.writeHead(404); return res.end('Not found'); }
    if (inject) {
      const tag = '<script>window.__SERVER_PIN__=' + JSON.stringify(cfg.pin) + ';window.__SERVER_INFO__=' +
        JSON.stringify({ addresses: addresses(), tailscale: addresses().filter(isTailscale), port: boundPort }) + ';</script>';
      html = html.replace(/<head[^>]*>/i, (m) => m + tag);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  }

  const server = http.createServer(async (req, res) => {
    let u; try { u = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
    const p = u.pathname, local = isLoopback(req), ip = clientIp(req);
    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

    // pages: the PIN is only ever written into pages opened ON this computer
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return servePage(req, res, 'presenter.html', local);
    if (req.method === 'GET' && p === '/live') return servePage(req, res, 'presenter.html', local);
    if (req.method === 'GET' && p === '/remote') return servePage(req, res, 'remote.html', false);
    if (req.method === 'GET' && p === '/overlay') return servePage(req, res, 'overlay.html', local);   // OBS Browser Source: transparent lower thirds

    // live updates (Server-Sent Events)
    if (req.method === 'GET' && p === '/events') {
      cors(res);
      if (limited(ip)) { res.writeHead(429); return res.end(); }
      const au = authOf(u.searchParams.get('pin'), u.searchParams.get('token'));
      if (!au) { noteFail(ip); res.writeHead(401); return res.end(); }
      const devId = au.device || u.searchParams.get('device');
      const d = devId ? touchDevice(req, devId, u.searchParams.get('name')) : null;
      if (d && d.blocked) { res.writeHead(403); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      const c = { res, device: d ? d.id : null, isLocal: local, mode: au.mode, token: au.token || null, overlay: u.searchParams.get('overlay') === '1' };
      clients.add(c);
      replayState(c);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) {} }, 20000);
      req.on('close', () => { clearInterval(ka); clients.delete(c); if (d) d.lastSeen = Date.now(); });
      return;
    }

    // commands from phones / state from the Control window
    if (req.method === 'POST' && p === '/api/send') {
      cors(res);
      if (limited(ip)) return json(res, 429, { ok: false });
      let body; try { body = await readBody(req, 2 * 1024 * 1024); } catch (e) { return json(res, 413, { ok: false }); }
      const au = authOf(body.pin, body.token);
      if (!au) { noteFail(ip); return json(res, 401, { ok: false, message: 'Not signed in' }); }
      if (au.mode !== 'remote') return json(res, 403, { ok: false, message: 'This mode is view-only.' });
      if (body.from === 'remote' || !au.byPin) {
        const d = touchDevice(req, au.device || body.device, body.name);
        if (d && d.blocked) return json(res, 403, { ok: false });
      }
      const msg = Object.assign({}, body); delete msg.pin; delete msg.device; delete msg.name; delete msg.token;
      if (!au.byPin) msg.from = 'remote';          // a phone session can never speak as the Control window
      if (msg.from === 'control' && msg.type === 'state') lastState = msg;
      if (msg.from === 'control' || msg.from === 'remote') broadcast(msg);
      return json(res, 200, { ok: true });
    }

    // ---- AI relay: phones send raw audio / text, the computer calls the AI and returns JSON (no keys on the phone) ----
    if (req.method === 'POST' && (p === '/api/ai/identify' || p === '/api/ai/lyrics')) {
      cors(res);
      if (!opts.ai) return json(res, 503, { ok: false, error: 'AI is only available in the Presenter desktop app.' });
      if (limited(ip)) return json(res, 429, { ok: false });
      let body; try { body = await readBody(req, 6 * 1024 * 1024); } catch (e) { return json(res, 413, { ok: false, error: 'Audio clip too large.' }); }
      const au = authOf(body.pin, body.token);
      if (!au) { noteFail(ip); return json(res, 401, { ok: false, error: 'Not signed in' }); }
      if (au.mode !== 'remote') return json(res, 403, { ok: false, error: 'This mode is view-only.' });
      const d = touchDevice(req, au.device || body.device, body.name);
      if (d && d.blocked) return json(res, 403, { ok: false });
      try {
        if (p === '/api/ai/identify') {
          const b64 = String(body.audio || '');
          if (!b64 || b64.length > 4 * 1024 * 1024) return json(res, 400, { ok: false, error: 'Send 1-3 seconds of audio.' });
          return json(res, 200, await opts.ai.identify({ base64: b64, mime: String(body.mime || 'audio/wav').slice(0, 40) }, { hint: String(body.hint || '').slice(0, 200) }));
        }
        return json(res, 200, await opts.ai.lyrics(String(body.query || '').slice(0, 300), { artist: String(body.artist || '').slice(0, 100), prompt: String(body.prompt || '').slice(0, 300) }));
      } catch (e) { return json(res, 500, { ok: false, error: 'AI request failed.' }); }
    }

    // ---- phone connection, step 1: reach the computer. NO password here: scanning the QR code just connects. ----
    if (req.method === 'GET' && p === '/api/hello') {
      cors(res);
      const d = touchDevice(req, u.searchParams.get('device'), u.searchParams.get('name'));
      if (d && d.blocked) return json(res, 403, { ok: false, message: 'This phone was removed from Presenter.' });
      return json(res, 200, { ok: true, app: 'presenter', modes: MODES });
    }
    // ---- step 2: after the phone chose a mode, it proves the password and receives a session token for that mode ----
    if (req.method === 'POST' && p === '/api/auth') {
      cors(res);
      if (authLimited(ip)) return json(res, 429, { ok: false, message: 'Too many wrong passwords. Wait a minute and try again.' });
      let body; try { body = await readBody(req, 4096); } catch (e) { return json(res, 413, { ok: false }); }
      const mode = String(body.mode || '');
      if (MODES.indexOf(mode) < 0) return json(res, 400, { ok: false, message: 'Choose a mode first.' });
      const devId = String(body.device || '').slice(0, 40);
      if (!devId) return json(res, 400, { ok: false, message: 'Missing device.' });
      const d = touchDevice(req, devId, body.name);
      if (d && d.blocked) return json(res, 403, { ok: false, message: 'This phone was removed from Presenter.' });
      if (!pinOk(body.password)) { noteAuthFail(ip); return json(res, 401, { ok: false, message: 'Wrong password.' }); }
      authFails.delete(ip);
      dropSessions((x) => x.device === devId);                 // one active session per phone
      const token = crypto.randomBytes(24).toString('hex');
      sessions.set(token, { device: devId, mode, ip, t: Date.now() });
      return json(res, 200, { ok: true, token, mode });
    }
    if (req.method === 'GET' && p === '/api/session') {        // is this phone's token still valid? (never reveals anything else)
      cors(res);
      const sx = sessionFor(u.searchParams.get('token'));
      return json(res, 200, sx ? { ok: true, mode: sx.mode } : { ok: false });
    }
    if (req.method === 'POST' && p === '/api/logout') {
      cors(res);
      let body; try { body = await readBody(req, 4096); } catch (e) { return json(res, 413, { ok: false }); }
      const tk = String(body.token || '');
      sessions.delete(tk); dropClients((c) => c.token === tk);
      return json(res, 200, { ok: true });
    }

    // ---- computer-only endpoints ----
    if (p.startsWith('/api/')) {
      if (!local) return json(res, 403, { ok: false, message: 'Only on the computer running Presenter.' });
      // ---- Bible lookup for the Bible References column (book / chapter / verse selectors) ----
      if (req.method === 'GET' && p === '/api/bible/books') {
        const st = speech.bibleStore();
        return json(res, 200, { ok: true, books: bibleLib.BOOKS.map((b) => ({ n: b.n, en: b.en, te: b.te, chapters: b.chapters })),
          have: { en: st.has('en'), te: st.has('te') }, names: st.translations() });
      }
      if (req.method === 'GET' && p === '/api/bible/passage') {
        const q = u.searchParams, lang = q.get('lang') === 'te' ? 'te' : 'en', st = speech.bibleStore();
        const n = parseInt(q.get('n'), 10), chapter = parseInt(q.get('chapter'), 10);
        if (!(n >= 1 && n <= 66) || !(chapter >= 1) || chapter > bibleLib.BOOKS[n - 1].chapters) return json(res, 400, { ok: false, error: 'Unknown book or chapter.' });
        const verseCount = st.verseCount(lang, n, chapter);
        let verse = Math.max(1, parseInt(q.get('verse'), 10) || 1), verseEnd = parseInt(q.get('verseEnd'), 10) || 0;
        if (verseCount) { verse = Math.min(verse, verseCount); verseEnd = Math.min(verseEnd, verseCount); }
        if (verseEnd <= verse) verseEnd = 0;
        const r = { n, chapter, verse, verseEnd: verseEnd || undefined };
        return json(res, 200, { ok: true, lang, have: st.has(lang), verseCount, verse, verseEnd, ref: bibleLib.formatRef(r, lang), text: st.text(lang, r, 40) });
      }
      // ---- live speech (captions / Bible references) ----
      if (p.startsWith('/api/stt/')) {
        if (req.method === 'GET' && p === '/api/stt/status') return json(res, 200, { ok: true, status: speech.status(), config: speech.getConfig(), setup: speech.setupInfo() });
        if (req.method === 'POST' && p === '/api/stt/segment') {          // raw 16 kHz mono Int16 PCM from the mic capture in the Control window
          let buf; try { buf = await readRaw(req, 1.5 * 1024 * 1024); } catch (e) { return json(res, 413, { ok: false }); }
          if (buf.length < 3200 || buf.length % 2) return json(res, 400, { ok: false, error: 'bad segment' });
          return json(res, 202, speech.addSegment(buf, { peak: Number(req.headers['x-peak']) || 0 }));
        }
        let b = {}; if (req.method === 'POST') { try { b = await readBody(req, 8192); } catch (e) { return json(res, 413, { ok: false }); } }
        if (req.method === 'POST' && p === '/api/stt/config') { const r = speech.setConfig(b); return json(res, 200, Object.assign({ ok: true, config: speech.getConfig() }, r)); }
        if (req.method === 'POST' && p === '/api/stt/start') return json(res, 200, { ok: true, status: await speech.start() });
        if (req.method === 'POST' && p === '/api/stt/stop') return json(res, 200, { ok: true, status: await speech.stop() });
        if (req.method === 'POST' && p === '/api/stt/ai-live') return json(res, 200, { ok: true, status: await speech.aiLive({ on: typeof b.on === 'boolean' ? b.on : undefined, bible: typeof b.bible === 'boolean' ? b.bible : undefined, text: typeof b.text === 'boolean' ? b.text : undefined, target: b.target !== undefined ? String(b.target).slice(0, 8) : undefined }) });   // AI Live switches / language dropdown
        if (req.method === 'POST' && p === '/api/stt/show') return json(res, 200, speech.showManual(String(b.text || '').slice(0, 200)));
        if (req.method === 'POST' && p === '/api/stt/hide') { speech.hide(String(b.which || 'all')); return json(res, 200, { ok: true }); }
        if (req.method === 'POST' && p === '/api/stt/clear') { speech.clear(); return json(res, 200, { ok: true }); }
        if (req.method === 'POST' && p === '/api/stt/download-model') return json(res, 200, await speech.downloadModel(b.model));
        return json(res, 404, { ok: false });
      }
      if (req.method === 'GET' && p === '/api/devices') {
        const list = Array.from(devices.values()).map((d) => ({ id: d.id, name: d.name, ip: d.ip, lastSeen: d.lastSeen, blocked: d.blocked, connected: deviceConnected(d.id) }));
        return json(res, 200, { ok: true, devices: list });
      }
      if (req.method === 'POST' && (p === '/api/devices/remove' || p === '/api/devices/allow')) {
        const b = await readBody(req, 4096); const d = devices.get(String(b.id || ''));
        if (d) {
          if (p.endsWith('remove')) { d.blocked = true; d.blockedAt = Date.now(); dropClients((c) => c.device === d.id); dropSessions((x) => x.device === d.id); }
          else d.blocked = false;
        }
        const list = Array.from(devices.values()).map((x) => ({ id: x.id, name: x.name, ip: x.ip, lastSeen: x.lastSeen, blocked: x.blocked, connected: deviceConnected(x.id) }));
        return json(res, 200, { ok: true, devices: list });
      }
      if (req.method === 'GET' && p === '/api/workspace') return json(res, 200, Object.assign({ ok: true }, ws));
      if (req.method === 'POST' && p === '/api/workspace') {
        const b = await readBody(req, 1024 * 1024);
        ws = { rev: ws.rev + 1, current: b.current || null, custom: b.custom || {}, names: Array.isArray(b.names) ? b.names : [] };
        try { fs.writeFileSync(wsFile, JSON.stringify(ws)); } catch (e) {}
        broadcast({ from: 'server', type: 'workspace', rev: ws.rev });
        return json(res, 200, { ok: true, rev: ws.rev });
      }
      // The connection PIN is the only PIN: changing it needs no second password.
      if (req.method === 'POST' && p === '/api/set-password') {
        const b = await readBody(req, 4096); const np = String(b.password || '');
        if (np.length < 4 || np.length > 64) return json(res, 400, { ok: false, message: 'The PIN must be 4–64 characters.' });
        cfg.pin = np; saveCfg();
        sessions.clear();                            // every phone must sign in again
        dropClients((c) => !c.isLocal);              // sign every phone out
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { ok: false });
    }

    res.writeHead(404); res.end('Not found');
  });


  // ---- WebSocket (/ws): same commands as /api/send + /events, plus binary audio streaming for the AI relay ----
  // Works over any reachable address, including Tailscale (100.x.y.z), so a phone on 4G/5G can reach a computer on Wi-Fi.
  server.on('upgrade', (req, socket) => {
    let u; try { u = new URL(req.url, 'http://x'); } catch (e) { return socket.destroy(); }
    const ip = clientIp(req), local = isLoopback(req), key = req.headers['sec-websocket-key'];
    const refuse = (line) => { try { socket.write('HTTP/1.1 ' + line + '\r\nConnection: close\r\n\r\n'); } catch (e) {} socket.destroy(); };
    if (u.pathname !== '/ws' || !key) return refuse('404 Not Found');
    if (limited(ip)) return refuse('429 Too Many Requests');
    const au = authOf(u.searchParams.get('pin'), u.searchParams.get('token'));
    if (!au) { noteFail(ip); return refuse('401 Unauthorized'); }
    const devId = au.device || u.searchParams.get('device');
    const d = devId ? touchDevice(req, devId, u.searchParams.get('name')) : null;
    if (d && d.blocked) return refuse('403 Forbidden');
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.setNoDelay(true); socket.setTimeout(0);

    const c = { device: d ? d.id : null, isLocal: local, ws: true, mode: au.mode, token: au.token || null,
      send: (text) => { if (!socket.destroyed) socket.write(wsFrame(1, Buffer.from(text, 'utf8'))); },
      close: () => { try { socket.write(wsFrame(8, Buffer.alloc(0))); } catch (e) {} socket.end(); } };
    clients.add(c);
    replayState(c);
    const ka = setInterval(() => { try { if (!socket.destroyed) socket.write(wsFrame(9, Buffer.alloc(0))); } catch (e) {} }, 20000);
    const cleanup = () => { clearInterval(ka); clients.delete(c); if (d) d.lastSeen = Date.now(); };
    socket.on('close', cleanup); socket.on('error', () => { cleanup(); socket.destroy(); });

    let buf = Buffer.alloc(0), frag = null, fragOp = 0, stream = null, busy = false;
    const MAX_FRAME = 2 * 1024 * 1024, MAX_AUDIO = 400 * 1024;

    async function onText(text) {
      let m; try { m = JSON.parse(text); } catch (e) { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'ping') return c.send(JSON.stringify({ from: 'server', type: 'pong', ts: m.ts }));
      if (d) { d.lastSeen = Date.now(); if (d.blocked) return c.close(); }
      if (au.token && !sessionFor(au.token)) return c.close();      // session expired or revoked
      if (c.mode !== 'remote') return;                              // Main Stage Display is view-only
      if (m.t === 'aiLive') {                                       // AI Live toggle / language over the socket (the computer itself only)
        if (local && au.byPin) speech.aiLive({ on: typeof m.on === 'boolean' ? m.on : undefined, bible: typeof m.bible === 'boolean' ? m.bible : undefined, text: typeof m.text === 'boolean' ? m.text : undefined, target: m.target !== undefined ? String(m.target).slice(0, 8) : undefined }).catch(() => {});
        return;
      }
      if (m.t === 'msg') {
        const msg = Object.assign({}, m); delete msg.t;
        if (!local || !au.byPin) msg.from = 'remote';          // only the computer itself may speak as the Control window
        if (msg.from === 'control' && msg.type === 'state') lastState = msg;
        if (msg.from === 'control' || msg.from === 'remote') broadcast(msg);
        return;
      }
      if (m.t === 'aiStart') { stream = { id: m.id, rate: Math.max(8000, Math.min(48000, Number(m.rate) || 16000)), parts: [], n: 0, hint: String(m.hint || '').slice(0, 300) }; return; }
      if (m.t === 'aiEnd' || m.t === 'aiLyrics') {
        const reply = (kind, result) => c.send(JSON.stringify({ from: 'server', type: 'aiResult', id: m.id, kind, result }));
        if (!opts.ai) return reply(m.t, { ok: false, error: 'AI is only available in the Presenter desktop app.' });
        if (busy) return reply(m.t, { ok: false, error: 'Still working on the previous request.' });
        busy = true;
        try {
          if (m.t === 'aiEnd') {
            if (!stream || stream.id !== m.id || !stream.n) return reply('aiEnd', { ok: false, error: 'No audio received.' });
            const wav = mulawToWav(Buffer.concat(stream.parts), stream.rate);
            const hint = stream.hint; stream = null;
            return reply('aiEnd', await opts.ai.identify({ base64: wav.toString('base64'), mime: 'audio/wav' }, { hint }));
          }
          return reply('aiLyrics', await opts.ai.lyrics(String(m.query || '').slice(0, 300), { artist: String(m.artist || '').slice(0, 100), prompt: String(m.prompt || '').slice(0, 300) }));
        } catch (e) { reply(m.t, { ok: false, error: 'AI request failed.' }); }
        finally { busy = false; }
      }
    }
    function onBinary(b) {
      if (!stream) return;
      stream.n += b.length;
      if (stream.n > MAX_AUDIO) { stream = null; return; }
      stream.parts.push(b);
    }
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const fin = !!(buf[0] & 0x80), op = buf[0] & 15, masked = !!(buf[1] & 0x80);
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (len > MAX_FRAME || !masked) return socket.destroy();        // clients must mask; refuse oversized frames
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4); const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
        buf = buf.subarray(off + 4 + len);
        if (op === 8) { try { socket.end(wsFrame(8, Buffer.alloc(0))); } catch (e) {} return; }
        if (op === 9) { socket.write(wsFrame(10, payload)); continue; }
        if (op === 10) continue;
        let whole = null, wop = op;
        if (op === 0) { if (!frag) continue; frag.push(payload); if (fin) { whole = Buffer.concat(frag); wop = fragOp; frag = null; } }
        else if (!fin) { frag = [payload]; fragOp = op; continue; }
        else whole = payload;
        if (!whole) continue;
        if (wop === 1) onText(whole.toString('utf8')); else if (wop === 2) onBinary(whole);
      }
    });
  });

  return new Promise((resolve, reject) => {
    let tries = 0;
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && tries++ < 10) { boundPort++; server.listen(boundPort, '0.0.0.0'); } else reject(e);
    });
    server.listen(boundPort, '0.0.0.0', () => resolve({ port: boundPort, server, getPin: () => cfg.pin, speech }));
  });
}

module.exports = { start };

if (require.main === module) {
  start({}).then((s) => {
    console.log('Presenter server running:  http://localhost:' + s.port + '/   (connection PIN: ' + s.getPin() + ')');
    const ts = os.networkInterfaces(); Object.keys(ts).forEach((k) => (ts[k] || []).forEach((a) => { if (a.family === 'IPv4' && isTailscale(a.address)) console.log('Tailscale address for phones on any network: http://' + a.address + ':' + s.port + '/remote'); }));
  }).catch((e) => { console.error(e); process.exit(1); });
}
