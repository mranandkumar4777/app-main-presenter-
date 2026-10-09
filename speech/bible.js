'use strict';
// Bible reference detector + bilingual (English / Telugu) names, for live speech-to-text output.
// Understands: "John 3:16", "John chapter 3 verse 16", "First John 2 verse 4", "Psalm twenty three",
// "John three sixteen", "Romans 8:28-30", and Telugu such as "యోహాను సువార్త 3వ అధ్యాయం 16వ వచనం".
// Optional verse text is read from <dataDir>/bibles/en.json and te.json (see tools/import-bible.js).
const fs = require('fs');
const path = require('path');

// n, English name, Telugu name, chapters, English aliases (spoken/typed), Telugu aliases (without number prefix)
const B = [
  [1, 'Genesis', 'ఆదికాండము', 50, ['genesis', 'gen'], ['ఆదికాండము', 'ఆదికాండం']],
  [2, 'Exodus', 'నిర్గమకాండము', 40, ['exodus', 'exod'], ['నిర్గమకాండము', 'నిర్గమకాండం']],
  [3, 'Leviticus', 'లేవీయకాండము', 27, ['leviticus', 'lev'], ['లేవీయకాండము', 'లేవీయకాండం']],
  [4, 'Numbers', 'సంఖ్యాకాండము', 36, ['numbers'], ['సంఖ్యాకాండము', 'సంఖ్యాకాండం']],
  [5, 'Deuteronomy', 'ద్వితీయోపదేశకాండము', 34, ['deuteronomy', 'deut'], ['ద్వితీయోపదేశకాండము', 'ద్వితీయోపదేశకాండం']],
  [6, 'Joshua', 'యెహోషువ', 24, ['joshua'], ['యెహోషువ', 'యెహోషువా']],
  [7, 'Judges', 'న్యాయాధిపతులు', 21, ['judges'], ['న్యాయాధిపతులు']],
  [8, 'Ruth', 'రూతు', 4, ['ruth'], ['రూతు']],
  [9, '1 Samuel', '1 సమూయేలు', 31, ['samuel'], ['సమూయేలు']],
  [10, '2 Samuel', '2 సమూయేలు', 24, [], []],
  [11, '1 Kings', '1 రాజులు', 22, ['kings'], ['రాజులు']],
  [12, '2 Kings', '2 రాజులు', 25, [], []],
  [13, '1 Chronicles', '1 దినవృత్తాంతములు', 29, ['chronicles'], ['దినవృత్తాంతములు']],
  [14, '2 Chronicles', '2 దినవృత్తాంతములు', 36, [], []],
  [15, 'Ezra', 'ఎజ్రా', 10, ['ezra'], ['ఎజ్రా']],
  [16, 'Nehemiah', 'నెహెమ్యా', 13, ['nehemiah'], ['నెహెమ్యా']],
  [17, 'Esther', 'ఎస్తేరు', 10, ['esther'], ['ఎస్తేరు']],
  [18, 'Job', 'యోబు', 42, ['job'], ['యోబు']],
  [19, 'Psalms', 'కీర్తనలు', 150, ['psalms', 'psalm', 'salm'], ['కీర్తనలు', 'కీర్తన']],
  [20, 'Proverbs', 'సామెతలు', 31, ['proverbs', 'proverb'], ['సామెతలు']],
  [21, 'Ecclesiastes', 'ప్రసంగి', 12, ['ecclesiastes'], ['ప్రసంగి']],
  [22, 'Song of Solomon', 'పరమగీతము', 8, ['song of solomon', 'song of songs', 'songs of solomon'], ['పరమగీతము', 'పరమగీతములు', 'పరమగీతం']],
  [23, 'Isaiah', 'యెషయా', 66, ['isaiah'], ['యెషయా']],
  [24, 'Jeremiah', 'యిర్మీయా', 52, ['jeremiah'], ['యిర్మీయా']],
  [25, 'Lamentations', 'విలాపవాక్యములు', 5, ['lamentations'], ['విలాపవాక్యములు', 'విలాపవాక్యాలు']],
  [26, 'Ezekiel', 'యెహెజ్కేలు', 48, ['ezekiel'], ['యెహెజ్కేలు']],
  [27, 'Daniel', 'దానియేలు', 12, ['daniel'], ['దానియేలు']],
  [28, 'Hosea', 'హోషేయ', 14, ['hosea'], ['హోషేయ', 'హోషేయా']],
  [29, 'Joel', 'యోవేలు', 3, ['joel'], ['యోవేలు']],
  [30, 'Amos', 'ఆమోసు', 9, ['amos'], ['ఆమోసు']],
  [31, 'Obadiah', 'ఓబద్యా', 1, ['obadiah'], ['ఓబద్యా']],
  [32, 'Jonah', 'యోనా', 4, ['jonah'], ['యోనా']],
  [33, 'Micah', 'మీకా', 7, ['micah'], ['మీకా']],
  [34, 'Nahum', 'నహూము', 3, ['nahum'], ['నహూము']],
  [35, 'Habakkuk', 'హబక్కూకు', 3, ['habakkuk'], ['హబక్కూకు']],
  [36, 'Zephaniah', 'జెఫన్యా', 3, ['zephaniah'], ['జెఫన్యా']],
  [37, 'Haggai', 'హగ్గయి', 2, ['haggai'], ['హగ్గయి']],
  [38, 'Zechariah', 'జెకర్యా', 14, ['zechariah'], ['జెకర్యా']],
  [39, 'Malachi', 'మలాకీ', 4, ['malachi'], ['మలాకీ']],
  [40, 'Matthew', 'మత్తయి సువార్త', 28, ['matthew', 'mathew'], ['మత్తయి']],
  [41, 'Mark', 'మార్కు సువార్త', 16, ['mark'], ['మార్కు']],
  [42, 'Luke', 'లూకా సువార్త', 24, ['luke'], ['లూకా']],
  [43, 'John', 'యోహాను సువార్త', 21, ['john'], ['యోహాను']],
  [44, 'Acts', 'అపొస్తలుల కార్యములు', 28, ['acts', 'acts of the apostles'], ['అపొస్తలుల కార్యములు', 'అపొస్తలుల']],
  [45, 'Romans', 'రోమీయులకు', 16, ['romans'], ['రోమీయులకు', 'రోమీయులు']],
  [46, '1 Corinthians', '1 కొరింథీయులకు', 16, ['corinthians'], ['కొరింథీయులకు', 'కొరింథీయులు']],
  [47, '2 Corinthians', '2 కొరింథీయులకు', 13, [], []],
  [48, 'Galatians', 'గలతీయులకు', 6, ['galatians'], ['గలతీయులకు', 'గలతీయులు']],
  [49, 'Ephesians', 'ఎఫెసీయులకు', 6, ['ephesians'], ['ఎఫెసీయులకు', 'ఎఫెసీయులు']],
  [50, 'Philippians', 'ఫిలిప్పీయులకు', 4, ['philippians', 'phillippians'], ['ఫిలిప్పీయులకు', 'ఫిలిప్పీయులు']],
  [51, 'Colossians', 'కొలొస్సయులకు', 4, ['colossians'], ['కొలొస్సయులకు', 'కొలొస్సయులు']],
  [52, '1 Thessalonians', '1 థెస్సలొనీకయులకు', 5, ['thessalonians'], ['థెస్సలొనీకయులకు', 'థెస్సలొనీకయులు']],
  [53, '2 Thessalonians', '2 థెస్సలొనీకయులకు', 3, [], []],
  [54, '1 Timothy', '1 తిమోతికి', 6, ['timothy'], ['తిమోతికి', 'తిమోతి']],
  [55, '2 Timothy', '2 తిమోతికి', 4, [], []],
  [56, 'Titus', 'తీతుకు', 3, ['titus'], ['తీతుకు', 'తీతు']],
  [57, 'Philemon', 'ఫిలేమోనుకు', 1, ['philemon'], ['ఫిలేమోనుకు', 'ఫిలేమోను']],
  [58, 'Hebrews', 'హెబ్రీయులకు', 13, ['hebrews'], ['హెబ్రీయులకు', 'హెబ్రీయులు']],
  [59, 'James', 'యాకోబు', 5, ['james'], ['యాకోబు']],
  [60, '1 Peter', '1 పేతురు', 5, ['peter'], ['పేతురు']],
  [61, '2 Peter', '2 పేతురు', 3, [], []],
  [62, '1 John', '1 యోహాను', 5, [], []],
  [63, '2 John', '2 యోహాను', 1, [], []],
  [64, '3 John', '3 యోహాను', 1, [], []],
  [65, 'Jude', 'యూదా', 1, ['jude'], ['యూదా']],
  [66, 'Revelation', 'ప్రకటన గ్రంథము', 22, ['revelation', 'revelations', 'revelation of john'], ['ప్రకటన గ్రంథము', 'ప్రకటన గ్రంధము', 'ప్రకటన']]
];
const BOOKS = B.map((b) => ({ n: b[0], en: b[1], te: b[2], chapters: b[3], enAliases: b[4], teAliases: b[5] }));

// ---------- text helpers ----------
// Telugu "skeleton": drops vowel signs, virama, anusvara etc. so spelling variations from speech-to-text still match.
function skel(w) {
  let s = String(w).replace(/[\u0C01-\u0C03\u0C3C\u0C3E-\u0C4D\u0C55\u0C56\u0C62\u0C63\u200c\u200d]/g, '');
  if (s.length > 3 && /[\u0C2E]$/.test(s)) s = s.slice(0, -1);   // final -mu / -m
  return s;
}
const isTe = (w) => /[\u0C00-\u0C7F]/.test(w);
const key = (w) => (isTe(w) ? skel(w) : w);

function tokenize(text) {
  const t = String(text || '').toLowerCase().replace(/[\u2013\u2014\-]/g, ' to ').replace(/(\d)\s*:\s*(\d)/g, '$1 : $2');
  const raw = t.match(/[\p{L}\p{M}\p{N}]+|:/gu) || [];
  return raw.map((w) => {
    const m = w.match(/^(\d+)[\p{L}\p{M}]*$/u);     // "3rd", "16వ", "3వ"
    return m ? m[1] : w;
  });
}

// ---------- numbers ----------
const EN_UNITS = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const EN_TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const TE_UNITS = { ఒకటి: 1, రెండు: 2, మూడు: 3, నాలుగు: 4, ఐదు: 5, అయిదు: 5, ఆరు: 6, ఏడు: 7, ఎనిమిది: 8, తొమ్మిది: 9, పది: 10, పదకొండు: 11, పన్నెండు: 12, పదమూడు: 13, పద్నాలుగు: 14, పధ్నాలుగు: 14, పదిహేను: 15, పదహారు: 16, పదిహేడు: 17, పద్దెనిమిది: 18, పంతొమ్మిది: 19 };
const TE_TENS = { ఇరవై: 20, ముప్పై: 30, నలభై: 40, యాభై: 50, అరవై: 60, డెబ్బై: 70, ఎనభై: 80, తొంభై: 90 };
const mk = (o) => { const r = {}; Object.keys(o).forEach((k) => { r[skel(k)] = o[k]; }); return r; };
const TEU = mk(TE_UNITS), TET = mk(TE_TENS);
const teKey = (w) => { const k = skel(w); return k.length > 2 && /వ$/.test(k) && !(k in TEU) && !(k in TET) ? k.slice(0, -1) : k; };   // ordinal "-వ"

// Parses a number starting at tokens[i]; returns { v, used } or null.
function parseNum(tk, i) {
  const w = tk[i]; if (w === undefined) return null;
  if (/^\d+$/.test(w)) return w.length <= 3 ? { v: parseInt(w, 10), used: 1 } : null;
  if (isTe(w)) {
    const k = teKey(w);
    if (k === skel('నూట') || k === skel('వంద')) {                      // 100 .. 150 ("నూట పంతొమ్మిది")
      let v = 100, used = 1; const n = i + 1 < tk.length && isTe(tk[i + 1]) ? teKey(tk[i + 1]) : null;
      if (n && TET[n] !== undefined) { v += TET[n]; used++; const u = i + 2 < tk.length && isTe(tk[i + 2]) ? teKey(tk[i + 2]) : null; if (u && TEU[u] !== undefined && TEU[u] < 10) { v += TEU[u]; used++; } }
      else if (n && TEU[n] !== undefined) { v += TEU[n]; used++; }
      return { v, used };
    }
    if (TET[k] !== undefined) {
      const u = i + 1 < tk.length && isTe(tk[i + 1]) ? teKey(tk[i + 1]) : null;
      if (u && TEU[u] !== undefined && TEU[u] < 10) return { v: TET[k] + TEU[u], used: 2 };
      return { v: TET[k], used: 1 };
    }
    if (TEU[k] !== undefined) return { v: TEU[k], used: 1 };
    return null;
  }
  // English words
  let j = i, v = 0, any = false;
  if (EN_UNITS[tk[j]] !== undefined && tk[j + 1] === 'hundred') { v = EN_UNITS[tk[j]] * 100; j += 2; any = true; }
  else if (tk[j] === 'a' && tk[j + 1] === 'hundred') { v = 100; j += 2; any = true; }
  else if (tk[j] === 'hundred') { v = 100; j += 1; any = true; }
  if (any && tk[j] === 'and') j++;
  if (EN_TENS[tk[j]] !== undefined) {
    v += EN_TENS[tk[j]]; j++; any = true;
    if (EN_UNITS[tk[j]] !== undefined && EN_UNITS[tk[j]] >= 1 && EN_UNITS[tk[j]] < 10) { v += EN_UNITS[tk[j]]; j++; }
  } else if (EN_UNITS[tk[j]] !== undefined && tk[j] !== 'oh' && (tk[j] !== 'zero')) {
    if (!(tk[j] === 'one' && !any && false)) { v += EN_UNITS[tk[j]]; j++; any = true; }
  }
  return any ? { v, used: j - i } : null;
}

// ---------- alias table ----------
const EN_ORD = { 1: ['1', 'first', '1st', 'i'], 2: ['2', 'second', '2nd', 'ii'], 3: ['3', 'third', '3rd', 'iii'] };
const TE_ORD = { 1: ['1', 'మొదటి', 'మొదటీ'], 2: ['2', 'రెండవ', 'రెండో', 'రెండు'], 3: ['3', 'మూడవ', 'మూడో'] };
const aliasIndex = new Map();     // first token key -> [{ seq:[keys], book }]
function addAlias(seqTokens, book) {
  const seq = seqTokens.map(key);
  const k = seq[0]; if (!aliasIndex.has(k)) aliasIndex.set(k, []);
  aliasIndex.get(k).push({ seq, book });
}
// numbered-book families: base alias -> numbers
const NUMBERED_EN = { samuel: [9, 10], kings: [11, 12], chronicles: [13, 14], corinthians: [46, 47], thessalonians: [52, 53], timothy: [54, 55], peter: [60, 61], john: [62, 63, 64] };
const NUMBERED_TE = { సమూయేలు: [9, 10], రాజులు: [11, 12], దినవృత్తాంతములు: [13, 14], కొరింథీయులకు: [46, 47], కొరింథీయులు: [46, 47], థెస్సలొనీకయులకు: [52, 53], థెస్సలొనీకయులు: [52, 53], తిమోతికి: [54, 55], తిమోతి: [54, 55], పేతురు: [60, 61], యోహాను: [62, 63, 64] };
const bookByN = (n) => BOOKS[n - 1];
BOOKS.forEach((b) => {
  b.enAliases.forEach((a) => {
    const toks = tokenize(a);
    if (NUMBERED_EN[a]) NUMBERED_EN[a].forEach((n, idx) => EN_ORD[idx + 1].forEach((o) => addAlias([o].concat(toks), bookByN(n))));
    if (NUMBERED_EN[a] && a !== 'john') addAlias(toks, bookByN(NUMBERED_EN[a][0]));   // bare "Samuel" -> 1 Samuel is a guess; bare "John" is the Gospel
    else if (!NUMBERED_EN[a]) addAlias(toks, b);
    else addAlias(toks, b);                                                           // john -> Gospel of John (book 43 owns the alias)
  });
  b.teAliases.forEach((a) => {
    const toks = tokenize(a);
    if (NUMBERED_TE[a]) NUMBERED_TE[a].forEach((n, idx) => TE_ORD[idx + 1].forEach((o) => addAlias([o].concat(toks), bookByN(n))));
    if (NUMBERED_TE[a] && a !== 'యోహాను') addAlias(toks, bookByN(NUMBERED_TE[a][0]));
    else if (!NUMBERED_TE[a]) addAlias(toks, b);
    else addAlias(toks, b);
  });
});
aliasIndex.forEach((arr) => arr.sort((x, y) => y.seq.length - x.seq.length));
// bare "john"/"యోహాను" must be the Gospel, not 1 John: make sure book 43 wins for single-token aliases
['john', skel('యోహాను')].forEach((k) => { const arr = aliasIndex.get(k); if (arr) { const g = arr.filter((e) => e.seq.length > 1 || e.book.n === 43); aliasIndex.set(k, g.concat(arr.filter((e) => !g.includes(e) && e.seq.length > 1))); } });

const EN_FILL = new Set(['chapter', 'chapters', 'ch', 'verse', 'verses', 'v', 'vs', 'the', 'of', 'at', 'in']);
const EN_VERSE_W = new Set(['verse', 'verses', 'v', 'vs']);
const EN_CH_W = new Set(['chapter', 'chapters', 'ch']);
const TE_FILL_SUFFIX = ['సువార్త', 'పత్రిక', 'గ్రంథము', 'గ్రంధము', 'గ్రంథం', 'లో', 'కు'].map(skel);
const isTeChapterW = (w) => isTe(w) && skel(w).startsWith(skel('అధ్య'));
const isTeVerseW = (w) => isTe(w) && skel(w).startsWith(skel('వచన'));
const SINGLE_CHAPTER = new Set([31, 57, 63, 64, 65]);
const AMBIGUOUS = new Set([4, 7, 18, 41, 44, 59]);     // Numbers, Judges, Job, Mark, Acts, James: ordinary English words, so a bare "Mark 5" is not enough

function bookAt(tk, i) {
  const cands = aliasIndex.get(key(tk[i])); if (!cands) return null;
  for (const c of cands) {
    let ok = true;
    for (let k = 0; k < c.seq.length; k++) { if (i + k >= tk.length || key(tk[i + k]) !== c.seq[k]) { ok = false; break; } }
    if (ok) return { book: c.book, used: c.seq.length };
  }
  return null;
}

// Finds every reference in a text. Returns [{ book, chapter, verse, verseEnd, end:index-of-last-token }]
function detect(text) {
  const tk = tokenize(text), out = [];
  for (let i = 0; i < tk.length; i++) {
    const m = bookAt(tk, i); if (!m) continue;
    let j = i + m.used, sawChapterWord = false, sawVerseWord = false;
    const skip = () => {
      while (j < tk.length) {
        const w = tk[j];
        if (EN_CH_W.has(w) || isTeChapterW(w)) { sawChapterWord = true; j++; }
        else if (EN_VERSE_W.has(w) || isTeVerseW(w)) { sawVerseWord = true; j++; }
        else if (EN_FILL.has(w) || (isTe(w) && TE_FILL_SUFFIX.includes(skel(w)))) j++;
        else break;
      }
    };
    skip();
    const c = parseNum(tk, j); if (!c) continue;
    j += c.used;
    let chapter = c.v, verse = null, verseEnd = null;
    const before = j;
    if (tk[j] === ':') j++;
    const explicit = tk[before] === ':';
    skip();
    const v = parseNum(tk, j);
    if (v && (explicit || sawVerseWord || tk[before] !== undefined)) { verse = v.v; j += v.used; }
    // "to" / "and" ranges for verses
    if (verse !== null && (tk[j] === 'to' || tk[j] === 'through' || tk[j] === 'and' || tk[j] === 'మరియు')) {
      const e = parseNum(tk, j + 1);
      if (e && e.v > verse && e.v - verse <= 12) { verseEnd = e.v; j += 1 + e.used; }
    }
    const bk = m.book;
    if (SINGLE_CHAPTER.has(bk.n) && verse === null && !sawChapterWord) { verse = chapter; chapter = 1; }
    if (AMBIGUOUS.has(bk.n) && verse === null && !sawChapterWord && !explicit) continue;
    if (chapter < 1 || chapter > bk.chapters) continue;
    if (verse !== null && (verse < 1 || verse > 176)) verse = null;
    out.push({ n: bk.n, chapter, verse, verseEnd, end: j - 1, explicit: explicit || sawVerseWord || sawChapterWord });
    i = Math.max(i, j - 1);
  }
  return out;
}

const refKey = (r) => r.n + ':' + r.chapter + ':' + (r.verse || 0) + ':' + (r.verseEnd || 0);
function formatRef(r, lang) {
  const b = bookByN(r.n);
  const name = lang === 'te' ? b.te : b.en;
  let loc = String(r.chapter);
  if (r.verse) loc += ':' + r.verse + (r.verseEnd ? '-' + r.verseEnd : '');
  if (SINGLE_CHAPTER.has(r.n) && r.verse) loc = String(r.verse) + (r.verseEnd ? '-' + r.verseEnd : '');
  return name + ' ' + loc;
}

// ---------- optional verse text ----------
function createStore(dataDir) {
  const dir = path.join(dataDir, 'bibles'), cache = {};
  function load(lang) {
    if (cache[lang] !== undefined) return cache[lang];
    try { cache[lang] = JSON.parse(fs.readFileSync(path.join(dir, lang + '.json'), 'utf8')); } catch (e) { cache[lang] = null; }
    return cache[lang];
  }
  function text(lang, r, maxVerses) {
    const d = load(lang); if (!d || !d.books || !r.verse) return '';
    const ch = (d.books[String(r.n)] || {})[String(r.chapter)]; if (!ch) return '';
    const last = Math.min(r.verseEnd || r.verse, r.verse + (maxVerses || 4) - 1), parts = [];
    for (let v = r.verse; v <= last; v++) { if (ch[String(v)]) parts.push(ch[String(v)]); }
    return parts.join(' ').trim();
  }
  function verseCount(lang, n, chapter) {                 // highest verse number of a chapter (0 = no Bible text imported for it)
    const d = load(lang); if (!d || !d.books) return 0;
    const ch = (d.books[String(n)] || {})[String(chapter)]; if (!ch) return 0;
    return Object.keys(ch).reduce((m, k) => Math.max(m, parseInt(k, 10) || 0), 0);
  }
  const has = (lang) => { const d = load(lang); return !!(d && d.books && Object.keys(d.books).length); };
  return { text, verseCount, has, dir, translations: () => ({ en: (load('en') || {}).name || '', te: (load('te') || {}).name || '' }), reload: () => { delete cache.en; delete cache.te; } };
}

module.exports = { BOOKS, detect, formatRef, refKey, createStore, tokenize, skel, parseNum };
