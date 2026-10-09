'use strict';
// Centralized AI hub. Runs ONLY in the desktop app (Electron main process).
// Phones never see keys: they send audio/text to the desktop, the desktop calls the AI and returns JSON.
//
// - Providers: Gemini (REST) and OpenRouter (OpenAI-compatible REST).
// - Model-agnostic: no model name is hard-coded in logic. The model list comes from
//   settings (ai-config.json) or env (PRESENTER_AI_MODELS="gemini:gemini-flash-latest,openrouter:google/gemini-2.5-flash").
//   Any Gemini or OpenRouter model ID works.
// - Multi-key rotation: each provider has an array of keys. On 429 / quota / bad key the key is put on
//   cooldown and the next key is used; when every key of a model is cooling down the next model is tried.
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Only used when the user configured nothing. These are plain defaults, editable in Settings / env.
const DEFAULT_MODELS = [
  { provider: 'gemini', model: 'gemini-flash-latest' },
  { provider: 'gemini', model: 'gemini-2.5-flash' },
  { provider: 'gemini', model: 'gemini-2.5-flash-lite' }
];

function parseModelList(text) {
  // "gemini:gemini-flash-latest, openrouter:google/gemini-2.5-flash"  (also accepts one per line)
  return String(text || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.indexOf(':');
    if (i < 0) return { provider: /\//.test(s) ? 'openrouter' : 'gemini', model: s };
    const p = s.slice(0, i).toLowerCase();
    if (p !== 'gemini' && p !== 'openrouter') return { provider: /\//.test(s) ? 'openrouter' : 'gemini', model: s };
    return { provider: p, model: s.slice(i + 1).trim() };
  }).filter((m) => m.model);
}

function parseKeys(text) {
  return Array.from(new Set(String(text || '').split(/[\s,;]+/).map((k) => k.trim()).filter(Boolean)));
}

// store = { load(): {geminiKeys:[], openrouterKeys:[], models:[]}, save(cfg) }  (provided by main.js, keys encrypted there)
function createAiHub(store) {
  const cooldown = new Map();      // `${provider}:${keyTail}` -> timestamp until usable again
  const rr = { gemini: 0, openrouter: 0 };   // round-robin start index per provider
  const keyId = (provider, key) => provider + ':' + key.slice(-8);
  const isCool = (provider, key) => (cooldown.get(keyId(provider, key)) || 0) > Date.now();
  const setCool = (provider, key, ms) => cooldown.set(keyId(provider, key), Date.now() + ms);

  function config() {
    const c = store.load() || {};
    const envKeysG = parseKeys(process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS);
    const envKeysO = parseKeys(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEYS);
    let models = Array.isArray(c.models) && c.models.length ? c.models : [];
    if (!models.length && process.env.PRESENTER_AI_MODELS) models = parseModelList(process.env.PRESENTER_AI_MODELS);
    if (!models.length && process.env.PRESENTER_GEMINI_MODEL) models = [{ provider: 'gemini', model: process.env.PRESENTER_GEMINI_MODEL }];
    if (!models.length) models = DEFAULT_MODELS;
    return {
      keys: { gemini: (c.geminiKeys || []).concat(envKeysG), openrouter: (c.openrouterKeys || []).concat(envKeysO) },
      models
    };
  }

  function status() {
    const c = config();
    return {
      geminiKeys: c.keys.gemini.length, openrouterKeys: c.keys.openrouter.length,
      last4: { gemini: c.keys.gemini.map((k) => k.slice(-4)), openrouter: c.keys.openrouter.map((k) => k.slice(-4)) },
      models: c.models, has: c.keys.gemini.length + c.keys.openrouter.length > 0
    };
  }

  // ---- one HTTP call -------------------------------------------------------------------------------
  // parts: [{text}] or [{text},{audio:{mime,base64}}]
  async function callGemini(key, model, parts) {
    const gp = parts.map((p) => p.audio ? { inlineData: { mimeType: p.audio.mime, data: p.audio.base64 } } : { text: p.text });
    let r;
    try {
      r = await fetch(GEMINI_BASE + 'models/' + encodeURIComponent(model) + ':generateContent', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts: gp }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } })
      });
    } catch (e) { return { ok: false, code: 'network', error: 'Could not reach Gemini.' }; }
    if (r.ok) {
      try {
        const j = await r.json();
        const ps = (((j.candidates || [])[0] || {}).content || {}).parts || [];
        return { ok: true, text: ps.map((p) => p.text || '').join('') };
      } catch (e) { return { ok: false, code: 'parse', error: 'Unreadable Gemini reply.' }; }
    }
    return failure(r, 'Gemini');
  }

  async function callOpenRouter(key, model, parts) {
    const content = parts.map((p) => p.audio
      ? { type: 'input_audio', input_audio: { data: p.audio.base64, format: /mp3|mpeg/.test(p.audio.mime) ? 'mp3' : 'wav' } }
      : { type: 'text', text: p.text });
    let r;
    try {
      r = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'X-Title': 'Presenter' },
        body: JSON.stringify({ model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'user', content }] })
      });
    } catch (e) { return { ok: false, code: 'network', error: 'Could not reach OpenRouter.' }; }
    if (r.ok) {
      try { const j = await r.json(); return { ok: true, text: String((((j.choices || [])[0] || {}).message || {}).content || '') }; }
      catch (e) { return { ok: false, code: 'parse', error: 'Unreadable OpenRouter reply.' }; }
    }
    return failure(r, 'OpenRouter');
  }

  async function failure(r, name) {
    let msg = ''; try { msg = (((await r.json()).error) || {}).message || ''; } catch (e) {}
    const base = { status: r.status };
    if (r.status === 429 || /quota|rate/i.test(msg)) {
      const ra = Number(r.headers.get('retry-after')) || 0;
      return Object.assign(base, { ok: false, code: 'rate_limit', error: name + ' rate limit reached.', retryMs: Math.max(ra * 1000, 30000) });
    }
    if (r.status === 401 || r.status === 403 || /API key/i.test(msg)) return Object.assign(base, { ok: false, code: 'bad_key', error: name + ' rejected a key.', retryMs: 10 * 60000 });
    if (r.status === 404 || r.status === 400 && /model/i.test(msg)) return Object.assign(base, { ok: false, code: 'bad_model', error: name + ' model not available.' });
    if (r.status >= 500) return Object.assign(base, { ok: false, code: 'server', error: name + ' is having trouble (HTTP ' + r.status + ').', retryMs: 15000 });
    return Object.assign(base, { ok: false, code: 'http', error: name + ' error (HTTP ' + r.status + (msg ? ': ' + msg.slice(0, 140) : '') + ').' });
  }

  function parseJson(text) {
    const raw = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    try { return JSON.parse(raw); } catch (e) {
      const m = raw.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch (e2) {} }
      return null;
    }
  }

  // ---- public: run a prompt through models x keys with fallback ----------------------------------
  async function run(parts) {
    const c = config();
    if (!c.keys.gemini.length && !c.keys.openrouter.length) return { ok: false, code: 'no_key', error: 'Add an API key in Settings first.' };
    let last = null; const badModels = new Set();
    for (const m of c.models) {
      const keys = c.keys[m.provider] || [];
      if (!keys.length) continue;
      const id = m.provider + ':' + m.model;
      if (badModels.has(id)) continue;
      // rotate the starting key so load is spread across keys
      const start = rr[m.provider]++ % keys.length;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[(start + i) % keys.length];
        if (isCool(m.provider, key)) continue;
        const res = m.provider === 'openrouter' ? await callOpenRouter(key, m.model, parts) : await callGemini(key, m.model, parts);
        if (res.ok) {
          const data = parseJson(res.text);
          if (data) return { ok: true, data, provider: m.provider, model: m.model };
          last = { ok: false, code: 'parse', error: 'The AI returned something unreadable.' };
          break;                                  // try the next model
        }
        last = res;
        if (res.code === 'rate_limit' || res.code === 'bad_key' || res.code === 'server') setCool(m.provider, key, res.retryMs || 30000);
        if (res.code === 'bad_model') { badModels.add(id); break; }   // next model
        if (res.code === 'network') return res;                      // offline: keys/models won't help
        // rate_limit / bad_key / server / http: continue with the next key
      }
    }
    return last || { ok: false, code: 'all_cooling', error: 'All API keys are cooling down after rate limits. Try again in a minute.' };
  }

  // ---- features -----------------------------------------------------------------------------------
  const clean = (s, n) => String(s == null ? '' : s).slice(0, n);

  // Listen to 1-3 s of audio (hummed, sung or played) and return the best match plus alternatives.
  async function identify(audio, ctx) {
    ctx = ctx || {};
    const prompt =
      'Listen to this very short audio clip (1-3 seconds). It may be a recording, or someone humming, singing or playing a melody. ' +
      'Identify the song if you can. ' + (ctx.hint ? 'Extra hint from the user: "' + clean(ctx.hint, 200) + '". ' : '') +
      'Reply with JSON only: {"isSong":boolean,"best":{"title":string,"artist":string,"confidence":number 0-100},' +
      '"similar":[{"title":string,"artist":string,"confidence":number 0-100}],"transcript":string (words heard, max 200 chars)}. ' +
      'List up to 5 "similar" songs: other plausible matches or songs with a similar melody. ' +
      'Short clips are ambiguous: be honest with low confidence and never invent a title you do not recognise.';
    const r = await run([{ text: prompt }, { audio: { mime: audio.mime || 'audio/wav', base64: String(audio.base64 || '') } }]);
    if (!r.ok) return r;
    const d = r.data || {};
    const norm = (x) => ({ title: clean(x && x.title, 120), artist: clean(x && x.artist, 120), confidence: Math.max(0, Math.min(100, Number(x && x.confidence) || 0)) });
    const best = norm(d.best);
    const similar = (Array.isArray(d.similar) ? d.similar : []).map(norm).filter((x) => x.title).slice(0, 5);
    return { ok: true, isSong: !!d.isSong && !!best.title, best, similar, transcript: clean(d.transcript, 200), model: r.model };
  }

  // Song -> slide cards. Uses the same normal request path as every other call: if a model declines or can
  // only give part of a song, that is reported back (complete:false / found:false) and shown to the user.
  async function lyricsSlides(query, ctx) {
    ctx = ctx || {};
    const prompt =
      'The user is preparing presentation slides for a song. Query: "' + clean(query, 300) + '".' +
      (ctx.artist ? ' Artist hint: ' + clean(ctx.artist, 100) + '.' : '') +
      (ctx.transcript ? ' Heard in the room: "' + clean(ctx.transcript, 300) + '".' : '') +
      (ctx.prompt ? ' Formatting preference from the user: "' + clean(ctx.prompt, 300) + '".' : '') +
      ' Only answer if you actually know this song and do not invent text. If you cannot provide the full text, provide what you can and set complete=false. ' +
      'Reply with JSON only: {"found":boolean,"title":string,"artist":string,"complete":boolean,"note":string,' +
      '"slides":[string]} where each slide is 2-4 short lines separated by \\n, one verse or chorus section per slide.';
    const r = await run([{ text: prompt }]);
    if (!r.ok) return r;
    const d = r.data || {};
    const slides = (Array.isArray(d.slides) ? d.slides : []).map((s) => String(s || '').trim()).filter(Boolean);
    return { ok: true, found: !!d.found && slides.length > 0, title: clean(d.title || query, 160), artist: clean(d.artist, 120), complete: !!d.complete, note: clean(d.note, 300), slides, model: r.model };
  }

  // Live captions: translate a small batch of short spoken phrases. Returns { ok, texts:[...] } in the same order.
  async function translate(texts, toName, fromName) {
    const list = (Array.isArray(texts) ? texts : []).map((t) => clean(t, 400)).slice(0, 6);
    if (!list.length) return { ok: true, texts: [] };
    const prompt =
      'Translate each string of this JSON array into ' + clean(toName, 40) + (fromName ? ' (the speaker uses ' + clean(fromName, 40) + ')' : '') + '. ' +
      'These are live speech-to-text captions from a church service: keep it natural and faithful, keep names, fix obvious recognition slips only when certain, and never add commentary. ' +
      'For quoted Bible verses use the familiar wording of a standard ' + clean(toName, 40) + ' Bible. ' +
      'Reply with JSON only: {\"t\":[string]} with exactly ' + list.length + ' items in the same order. Input: ' + JSON.stringify(list);
    const r = await run([{ text: prompt }]);
    if (!r.ok) return r;
    const out = r.data && Array.isArray(r.data.t) ? r.data.t.map((x) => clean(x, 600)) : [];
    if (out.length !== list.length) return { ok: false, code: 'parse', error: 'The AI returned an unexpected translation.' };
    return { ok: true, texts: out, model: r.model };
  }

  return { run, identify, lyricsSlides, translate, status, parseModelList, parseKeys };
}

module.exports = { createAiHub, parseModelList, parseKeys };
