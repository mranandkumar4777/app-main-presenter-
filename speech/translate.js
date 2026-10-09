'use strict';
// Live-caption translation. Providers:
//   'ai'    - Gemini / OpenRouter through the keys already saved in Settings (batched, so ~1 request per few phrases)
//   'libre' - a LibreTranslate server (self-hosted = unlimited and offline-capable; supports Telugu and Hindi)
const LANGS = {
  te: 'Telugu', en: 'English', hi: 'Hindi', ta: 'Tamil', kn: 'Kannada', ml: 'Malayalam', mr: 'Marathi', bn: 'Bengali'
};

// Which language is this text? (speech-to-text output is Telugu / Devanagari script, or Latin => English)
function scriptLang(text) {
  const t = String(text || ''), cnt = (re) => (t.match(re) || []).length;
  const te = cnt(/[\u0C00-\u0C7F]/g), hi = cnt(/[\u0900-\u097F]/g), ta = cnt(/[\u0B80-\u0BFF]/g), kn = cnt(/[\u0C80-\u0CFF]/g), ml = cnt(/[\u0D00-\u0D7F]/g), bn = cnt(/[\u0980-\u09FF]/g), la = cnt(/[A-Za-z]/g);
  const best = [['te', te], ['hi', hi], ['ta', ta], ['kn', kn], ['ml', ml], ['bn', bn], ['en', la]].sort((a, b) => b[1] - a[1])[0];
  return best[1] ? best[0] : 'en';
}

function createTranslator(deps) {
  const cache = new Map();                          // "to|text" -> translated (keeps repeated phrases / reconnects free)
  const remember = (k, v) => { cache.set(k, v); if (cache.size > 300) cache.delete(cache.keys().next().value); };

  async function libre(texts, to, from, cfg) {
    const url = String(cfg.libreUrl || '').replace(/\/+$/, '');
    if (!url) return { ok: false, error: 'Set the LibreTranslate address in the Captions panel.' };
    const out = [];
    for (const q of texts) {
      let r;
      try {
        r = await fetch(url + '/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q, source: from || 'auto', target: to, format: 'text', api_key: cfg.libreKey || undefined }) });
      } catch (e) { return { ok: false, error: 'Could not reach the LibreTranslate server.' }; }
      if (!r.ok) return { ok: false, error: 'LibreTranslate error (HTTP ' + r.status + ').' };
      const j = await r.json().catch(() => ({}));
      out.push(String(j.translatedText || ''));
    }
    return { ok: true, texts: out };
  }

  // items: [{ text, from }]  ->  { ok, texts } (same order). Items already in the target language are passed through.
  async function translateBatch(items, to, cfg) {
    const res = new Array(items.length).fill(null), todo = [], idx = [];
    items.forEach((it, i) => {
      if (it.from === to) { res[i] = it.text; return; }
      const hit = cache.get(to + '|' + it.text); if (hit) { res[i] = hit; return; }
      todo.push(it); idx.push(i);
    });
    if (todo.length) {
      let r;
      if (cfg.translator === 'libre') r = await libre(todo.map((x) => x.text), to, todo[0].from, cfg);
      else if (deps.ai && deps.ai.translate) {
        const fromName = LANGS[todo[0].from] || '';
        r = await deps.ai.translate(todo.map((x) => x.text), LANGS[to] || to, fromName);
      } else r = { ok: false, error: 'Translation needs the Presenter desktop app (Gemini key) or a LibreTranslate server.' };
      if (!r.ok) return { ok: false, error: r.error || 'Translation failed.', code: r.code };
      r.texts.forEach((t, k) => { res[idx[k]] = t; remember(to + '|' + todo[k].text, t); });
    }
    return { ok: true, texts: res };
  }
  return { translateBatch };
}

module.exports = { LANGS, scriptLang, createTranslator };
