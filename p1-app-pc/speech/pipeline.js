'use strict';
// Speech pipeline: mic segments in -> whisper -> (Bible reference | caption [+ translation]) -> overlay messages out.
// Everything is queued so a slow moment drops OLD audio instead of building up lag on a live stream.
const fs = require('fs');
const path = require('path');
const { createWhisper } = require('./whisper');
const { createSetup } = require('./setup');
const { createStream } = require('./stream');
const bible = require('./bible');
const { LANGS, scriptLang, createTranslator } = require('./translate');

const DEFAULTS = {
  source: 'auto',            // spoken language: auto | any code from translate.js LANGS (te, en, hi, es, fr, ...)
  target: 'off',             // caption language: off (as spoken) | te | en | hi | ...
  bible: true, captions: true, showOriginal: false,
  threads: 2, model: 'tiny', binaryPath: '', modelPath: '', prompt: '',
  translator: 'ai', libreUrl: '', libreKey: '',
  bibleHoldMs: 12000, captionHoldMs: 5000,
  stage: true,               // stream captions to the Stage Display (Live window, OBS /live, Stage phones) as well as the OBS /overlay page
  autoListen: false,         // open the microphone as soon as the Control window loads (needs the engine to be ready)
  whisperTranslate: true,    // target = English: let whisper.cpp translate itself (offline, no extra step)
  streamMic: -1, streamBinaryPath: ''       // AI Live (whisper-stream): capture device number (-1 = default) and optional full path of the program
};
const MAX_QUEUE = 2;        // segments waiting for whisper; older ones are dropped
const HALLUCINATIONS = [
  /^(thank you|thanks|thank you for watching|thanks for watching|bye|you|okay|ok|so|yeah)[.! ]*$/i,
  /subtitles? by|please subscribe|like and subscribe|amara\.org|transcribed by|www\./i,
  /^[\s.,!?\-–—_*#♪]+$/
];

function cleanText(raw) {
  let t = String(raw || '').replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[♪♫]+/g, ' ').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (HALLUCINATIONS.some((re) => re.test(t))) return '';
  const w = t.split(/\s+/);                                     // "thank you thank you thank you ..." loops
  if (w.length >= 6) { const u = new Set(w.map((x) => x.toLowerCase())); if (u.size <= Math.max(1, Math.floor(w.length / 5))) return ''; }
  return t;
}

function createPipeline(opts) {
  const dataDir = opts.dataDir, emit = opts.emit, log = opts.log || (() => {});
  const cfgFile = path.join(dataDir, 'speech-config.json');
  let cfg = Object.assign({}, DEFAULTS);
  try { Object.assign(cfg, JSON.parse(fs.readFileSync(cfgFile, 'utf8'))); } catch (e) {}
  const save = () => { try { fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2)); } catch (e) {} };

  const whisper = createWhisper({ dataDir, appDir: opts.appDir, log, onExit: (code, tail) => { if (st.state === 'running') setStatus({ state: 'error', message: 'Whisper stopped unexpectedly' + (tail ? ': ' + tail.trim().split(/\r?\n/).slice(-1)[0] : '') }); } });
  const setup = createSetup({ dataDir, appDir: opts.appDir, log, onState: (x) => { st.setup = x; sendStatus(true); } });
  const store = bible.createStore(dataDir);
  const translator = createTranslator({ ai: opts.ai });
  const stream = createStream({ dataDir, appDir: opts.appDir, log });

  const st = { setup: { state: 'idle', step: '', pct: 0, message: '', error: '' }, state: 'stopped', message: '', mode: '', lastMs: 0, avgMs: 0, queue: 0, segments: 0, dropped: 0, translating: false, translateError: '', download: null,
    live: { on: false, bible: false, text: false, state: 'off', message: '', translate: false, phrases: 0 } };   // AI Live (whisper-stream) state, shown in the panel next to Songs
  let outLines = [], outSeq = 0, textSeq = 0, outBible = null;   // what the control-panel columns show and stage in Preview (live jobs only)
  let recent = [];                                  // last transcript lines for the control panel
  let seq = 0, queue = [], working = false, lastStatusSend = 0, ms = [];
  let tail = '', tailAt = 0, shown = new Map();     // Bible: recent text for split references, and when each ref was last shown

  function setStatus(p) { Object.assign(st, p); sendStatus(true); }
  function sendStatus(force) {
    const now = Date.now(); if (!force && now - lastStatusSend < 400) return; lastStatusSend = now;
    emit({ kind: 'status', status: publicStatus() });
  }
  function publicStatus() { return Object.assign({}, st, { recent: recent.slice(-8), running: whisper.isRunning(), live: Object.assign({}, st.live, { devices: stream.devices() }),
    out: { bible: outBible, lines: outLines.slice(-6), textSeq } }); }

  // ---------- lifecycle ----------
  // Checks / downloads whisper.cpp and the model into <userData>/whisper. Called when the app starts (no waiting) and again before every start.
  function ensureReady() { return setup.ensure(cfg); }
  async function start() {
    if (st.state === 'starting') return publicStatus();
    if (st.live.on || stream.isRunning()) await liveStop();     // the panel's engine and AI Live both want the microphone: the one started last wins
    setStatus({ state: 'starting', message: 'Preparing the speech engine…' });
    const ready = await ensureReady();
    if (!ready.ok) { setStatus({ state: 'error', message: ready.error || 'The speech engine is not ready.', mode: '' }); return publicStatus(); }
    setStatus({ state: 'starting', message: 'Loading Whisper (' + cfg.model + ', ' + cfg.threads + ' threads)…' });
    try {
      const r = await whisper.start(cfg);
      setStatus({ state: 'running', message: r.mode === 'cli' ? 'Running (slower mode: whisper-server.exe not found, using whisper-cli.exe)' : 'Listening', mode: r.mode });
    } catch (e) { setStatus({ state: 'error', message: String(e && e.message || e), mode: '' }); }
    return publicStatus();
  }
  async function stop() {
    await liveStop();                                        // app quit also lands here: never leave whisper-stream running
    return stopEngine();
  }
  async function stopEngine() {
    queue = []; await whisper.stop();
    setStatus({ state: 'stopped', message: '', mode: '', queue: 0 });
    return publicStatus();
  }

  // ---------- segments ----------
  function addSegment(pcm, meta) {
    if (st.state !== 'running') return { ok: false, reason: 'not running' };
    if (queue.length >= MAX_QUEUE) { queue.shift(); st.dropped++; }
    queue.push({ pcm, meta: meta || {}, at: Date.now() });
    st.queue = queue.length; pump();
    return { ok: true, queued: queue.length };
  }
  async function pump() {
    if (working) return; working = true;
    try {
      while (queue.length && st.state === 'running') {
        const job = queue.shift(); st.queue = queue.length;
        const t0 = Date.now();
        let text = '';
        let res;
        try { res = await whisper.transcribe(job.pcm, cfg, { translate: wantWhisperTranslate() }); text = res && res.text; }
        catch (e) { log('whisper error ' + (e && e.message)); setStatus({ message: 'Whisper error: ' + String(e && e.message || e).slice(0, 120) }); continue; }
        const took = Date.now() - t0; ms.push(took); if (ms.length > 20) ms.shift();
        st.lastMs = took; st.avgMs = Math.round(ms.reduce((a, b) => a + b, 0) / ms.length); st.segments++;
        job.lang = res && res.language ? res.language : '';
        handleText(cleanText(text), job);
        sendStatus(false);
      }
    } finally { working = false; }
  }

  // whisper.cpp can translate into English by itself. Only used when the original text is not wanted next to it.
  function wantWhisperTranslate() { return cfg.whisperTranslate && cfg.target === 'en' && cfg.source !== 'en' && !cfg.showOriginal; }

  // ---------- text -> overlay ----------
  function handleText(text, job) {
    if (!text) return;
    const live = !!(job && job.live), doBible = live ? st.live.bible : cfg.bible, doCaps = live ? st.live.text : cfg.captions;
    // language of this phrase: what whisper detected (works for Latin-script languages too), else guessed from the script
    const lang = wantWhisperTranslate() && !live ? 'en' : (job && LANGS[job.lang] ? job.lang : scriptLang(text)), id = ++seq, now = Date.now();
    recent.push({ id, text, lang, at: now }); if (recent.length > 30) recent.shift();
    if (doBible) {
      if (now - tailAt > 15000) tail = '';
      const refs = bible.detect(tail ? tail + ' ' + text : text);
      tail = (tail + ' ' + text).slice(-160); tailAt = now;
      for (let k = refs.length - 1; k >= 0; k--) {          // the most recent reference wins
        const r = refs[k], kk = bible.refKey(r);
        if (now - (shown.get(kk) || 0) < 20000) continue;   // same reference said twice in a row: don't re-animate
        showRef(r, !live); recent[recent.length - 1].ref = bible.formatRef(r, 'en'); break;
      }
    }
    if (doCaps) caption(id, text, lang, live);
  }

  // direct = true: card goes straight to the OBS /overlay page (old Captions panel, manual "Show").
  // direct = false (AI Live columns): nothing goes on air; the card waits in the status for the Bible column to stage it in Preview.
  function showRef(r, direct) {
    shown.set(bible.refKey(r), Date.now());
    const en = { name: bible.BOOKS[r.n - 1].en, ref: bible.formatRef(r, 'en'), text: store.text('en', r, 12) };
    const te = { name: bible.BOOKS[r.n - 1].te, ref: bible.formatRef(r, 'te'), text: store.text('te', r, 12) };
    const card = { ref: { n: r.n, chapter: r.chapter, verse: r.verse, verseEnd: r.verseEnd }, en, te };
    if (direct) emit(Object.assign({ kind: 'bible', holdMs: cfg.bibleHoldMs }, card));
    else { outBible = Object.assign({ seq: ++outSeq }, card); sendStatus(true); }
    return { en: en.ref, te: te.ref };
  }

  // ---------- captions + translation ----------
  let pending = [], tBusy = false, lastErrAt = 0;
  function caption(id, text, lang, live) {
    const target = cfg.target === 'off' || !LANGS[cfg.target] ? '' : cfg.target;
    const needs = !!target && target !== lang;
    if (live) { outLines.push({ id, text, orig: text, lang, pending: needs }); if (outLines.length > 12) outLines.shift(); textSeq++; }
    if (!live || cfg.stage) emit({ kind: 'caption', id, text, lang, target, pending: needs, showOriginal: cfg.showOriginal, holdMs: cfg.captionHoldMs, stage: !!cfg.stage });
    if (needs) { pending.push({ id, text, from: lang, target, live }); if (pending.length > 6) pending.shift(); runTranslate(); }
  }
  async function runTranslate() {
    if (tBusy) return; tBusy = true; st.translating = true;
    try {
      while (pending.length) {
        const batch = pending.splice(0, 4), to = batch[0].target;
        const same = batch.filter((b) => b.target === to); pending = batch.filter((b) => b.target !== to).concat(pending);
        const r = await translator.translateBatch(same.map((b) => ({ text: b.text, from: b.from })), to, cfg);
        const settle = (b, t) => { const l = outLines.find((x) => x.id === b.id); if (l) { if (t) l.text = t; l.pending = false; textSeq++; } };
        if (r.ok) { st.translateError = ''; same.forEach((b, i) => { settle(b, r.texts[i]); if (!b.live || cfg.stage) emit({ kind: 'caption-update', id: b.id, text: r.texts[i], target: to, stage: !!cfg.stage }); }); }
        else {
          st.translateError = r.error || 'Translation failed.';
          same.forEach((b) => { settle(b, ''); if (!b.live || cfg.stage) emit({ kind: 'caption-update', id: b.id, text: '', target: to, failed: true, stage: !!cfg.stage }); });   // overlay / column keep the original text
          if (Date.now() - lastErrAt > 10000) { lastErrAt = Date.now(); sendStatus(true); }
          if (r.code === 'rate_limit' || r.code === 'all_cooling') await new Promise((rs) => setTimeout(rs, 1500));
        }
      }
    } finally { tBusy = false; st.translating = false; sendStatus(true); }
  }


  // ---------- AI Live: whisper-stream (tiny model, -t 2) -> same caption / Bible / translation path as the panel ----------
  // Switching the target language costs nothing, EXCEPT when it switches whisper's built-in "translate to English" on or off
  // (that is a launch option of the program, so it is restarted, about a second).
  let liveSigAtStart = '', liveChain = Promise.resolve(), liveToken = 0;
  const wantTranslate = () => cfg.target === 'en' && cfg.source !== 'en';
  const liveSig = () => JSON.stringify([cfg.model, cfg.threads, cfg.source, cfg.streamBinaryPath, cfg.modelPath, cfg.streamMic, wantTranslate()]);
  function setLive(p) { Object.assign(st.live, p); sendStatus(true); }

  async function liveStart() {
    const token = ++liveToken;
    if (st.state !== 'stopped') await stopEngine();            // the panel's own engine would hear the same microphone
    setLive({ on: true, state: 'starting', message: 'Starting AI Live…', phrases: 0 });
    await ensureReady();
    const su = whisper.setup(cfg), translate = wantTranslate();
    if (!su.model) return setLive({ on: false, bible: false, text: false, state: 'error', message: 'Model missing: ' + path.basename(su.modelWanted) + ' (use Download in the Captions panel).' });
    try {
      await stream.start(cfg, su.model, translate, {
        onText: (t) => { if (token !== liveToken || !st.live.on) return; st.live.phrases++; handleText(cleanText(t), { live: true }); sendStatus(false); },
        onExit: (code, errTail) => {
          if (token !== liveToken) return;
          const last = String(errTail || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '';
          setLive({ on: false, bible: false, text: false, state: 'error', message: 'whisper-stream stopped (' + code + ')' + (last ? ': ' + last.slice(0, 140) : '') });
        }
      });
      liveSigAtStart = liveSig();
      setLive({ on: true, state: 'on', translate, message: translate ? 'Whisper translates to English' : (cfg.target === 'off' ? 'Captions as spoken' : 'Translator → ' + (LANGS[cfg.target] || cfg.target)) });
    } catch (e) { setLive({ on: false, bible: false, text: false, state: 'error', message: String(e && e.message || e).slice(0, 220) }); }
  }
  async function liveStop() {
    liveToken++;                                               // ignore anything the old process still prints or its exit
    const was = st.live.on || stream.isRunning();
    await stream.stop();
    if (st.live.state !== 'error') st.live.message = '';
    setLive({ on: false, bible: false, text: false, state: st.live.state === 'error' ? 'error' : 'off', translate: false });
    if (was) emit({ kind: 'hide', which: 'caption' });
  }
  // p: { bible?: boolean (detect spoken Bible references), text?: boolean (live captions; `on` is an alias),
  //      target?: 'off' | 'te' | 'en' | 'hi' | ... }. The microphone program runs while EITHER switch is on and stops when both are off.
  // Calls are queued, so rapid clicks never race.
  function aiLive(p) {
    p = p || {};
    if (p.target !== undefined) setConfig({ target: p.target });   // saved + sent to the translator immediately
    const run = async () => {
      if (p.on !== undefined && p.text === undefined) p.text = p.on;
      if (p.bible !== undefined) st.live.bible = !!p.bible;
      if (p.text !== undefined) st.live.text = !!p.text;
      const wantOn = st.live.bible || st.live.text;
      if (!wantOn) { if (st.live.on || stream.isRunning()) await liveStop(); else if (st.live.state === 'error') setLive({ state: 'off', message: '' }); return publicStatus(); }
      if (stream.isRunning() && st.live.on && liveSig() === liveSigAtStart) {      // only the caption language changed: instant
        setLive({ message: cfg.target === 'off' ? 'Captions as spoken' : 'Translator → ' + (LANGS[cfg.target] || cfg.target) });
        return publicStatus();
      }
      await liveStart(); return publicStatus();
    };
    liveChain = liveChain.then(run, run);
    return liveChain;
  }

  // ---------- manual controls ----------
  function showManual(text) {
    const refs = bible.detect(String(text || ''));
    if (!refs.length) return { ok: false, error: 'Could not read that reference. Try "John 3:16" or "యోహాను 3:16".' };
    return { ok: true, shown: showRef(refs[0], true) };
  }
  function hide(kind) { emit({ kind: 'hide', which: kind || 'all' }); }
  function clear() { recent = []; pending = []; outLines = []; textSeq++; emit({ kind: 'hide', which: 'caption' }); sendStatus(true); }

  // ---------- config ----------
  function setConfig(patch) {
    const clampInt = (v, a, b, d) => { v = parseInt(v, 10); return isFinite(v) ? Math.max(a, Math.min(b, v)) : d; };
    const before = JSON.stringify([cfg.model, cfg.threads, cfg.source, cfg.binaryPath, cfg.modelPath]);
    const p = patch || {};
    if (p.source !== undefined) cfg.source = p.source === 'auto' || LANGS[p.source] ? p.source : 'auto';
    if (p.target !== undefined) cfg.target = p.target === 'off' || LANGS[p.target] ? p.target : 'off';
    ['bible', 'captions', 'showOriginal', 'stage', 'autoListen', 'whisperTranslate'].forEach((k) => { if (p[k] !== undefined) cfg[k] = !!p[k]; });
    if (p.threads !== undefined) cfg.threads = clampInt(p.threads, 1, 8, 2);
    if (p.model !== undefined) cfg.model = /^[a-z0-9._-]{2,24}$/i.test(String(p.model)) ? String(p.model) : 'tiny';
    if (p.streamMic !== undefined) cfg.streamMic = clampInt(p.streamMic, -1, 32, -1);
    ['binaryPath', 'modelPath', 'streamBinaryPath', 'prompt', 'libreUrl', 'libreKey'].forEach((k) => { if (p[k] !== undefined) cfg[k] = String(p[k]).slice(0, 300); });
    if (p.translator !== undefined) cfg.translator = p.translator === 'libre' ? 'libre' : 'ai';
    if (p.bibleHoldMs !== undefined) cfg.bibleHoldMs = clampInt(p.bibleHoldMs, 3000, 60000, 12000);
    if (p.captionHoldMs !== undefined) cfg.captionHoldMs = clampInt(p.captionHoldMs, 2000, 30000, 5000);
    save();
    const restart = before !== JSON.stringify([cfg.model, cfg.threads, cfg.source, cfg.binaryPath, cfg.modelPath]);
    sendStatus(true);
    if (st.live.on && liveSig() !== liveSigAtStart) aiLive({});      // model / threads / source / mic changed while AI Live is on: restart it with the new settings
    return { restartNeeded: restart && whisper.isRunning() };
  }
  function getConfig() { return Object.assign({}, cfg, { libreKey: cfg.libreKey ? '••••' : '' }); }
  function setupInfo() { const s = whisper.setup(cfg); return { install: setup.state(), dir: s.dir, modelsDir: s.modelsDir, binaryFound: !!s.binary, binary: s.binary, serverMode: !!s.server, modelFound: !!s.model, modelFile: path.basename(s.modelWanted), streamFound: !!stream.find(cfg), streamDir: stream.dir, translations: store.translations(), biblesDir: store.dir }; }

  // ---------- model download (the Captions panel button / choosing a bigger model) ----------
  async function downloadModel(model) {
    model = /^[a-z0-9._-]{2,24}$/i.test(String(model || '')) ? String(model) : cfg.model;
    if (setup.isRunning()) return { ok: false, error: 'A download is already running.' };
    const r = await setup.ensure(Object.assign({}, cfg, { model, modelPath: '' }));
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  return { start, stop, ensureReady, retrySetup: () => ensureReady(), aiLive, bibleStore: () => store, addSegment, showManual, hide, clear, setConfig, getConfig, setupInfo, status: publicStatus, downloadModel, handleText, _cfg: () => cfg, _bible: bible };
}

module.exports = { createPipeline, cleanText };
