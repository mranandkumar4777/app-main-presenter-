#!/usr/bin/env node
// Converts a Bible you are licensed to use into the file the lower thirds read for verse text.
//   node tools/import-bible.js <en|te> "<Translation name>" <input.tsv> [outputFolder]
// input.tsv: one verse per line, tab separated:   book <TAB> chapter <TAB> verse <TAB> text
//   "book" is the number 1-66 (Genesis=1 ... Revelation=66) or the English book name.
// Output: <outputFolder>/en.json or te.json. Default folder on Windows: %APPDATA%\Presenter\bibles
//         (macOS ~/Library/Application Support/Presenter/bibles, Linux ~/.config/Presenter/bibles).
const fs = require('fs'), path = require('path'), os = require('os');
const { BOOKS } = require('../speech/bible');
const [lang, name, input, outArg] = process.argv.slice(2);
if (!['en', 'te'].includes(lang) || !name || !input) { console.error('Usage: node tools/import-bible.js <en|te> "<Translation name>" <input.tsv> [outputFolder]'); process.exit(1); }
const base = process.platform === 'win32' ? process.env.APPDATA : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config');
const outDir = outArg || path.join(base, 'Presenter', 'bibles');
const byName = {}; BOOKS.forEach((b) => { byName[b.en.toLowerCase()] = b.n; });
const books = {}; let count = 0, bad = 0;
fs.readFileSync(input, 'utf8').split(/\r?\n/).forEach((line) => {
  if (!line.trim()) return;
  const p = line.split('\t'); if (p.length < 4) { bad++; return; }
  const n = /^\d+$/.test(p[0].trim()) ? parseInt(p[0], 10) : byName[p[0].trim().toLowerCase()];
  const c = parseInt(p[1], 10), v = parseInt(p[2], 10), t = p.slice(3).join('\t').trim();
  if (!n || n < 1 || n > 66 || !c || !v || !t) { bad++; return; }
  ((books[n] = books[n] || {})[c] = books[n][c] || {})[v] = t; count++;
});
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, lang + '.json'), JSON.stringify({ name, books }));
console.log('Imported ' + count + ' verses (' + bad + ' lines skipped) -> ' + path.join(outDir, lang + '.json'));
