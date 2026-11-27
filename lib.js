// Reading .def files: definitions, phrases, variables, libraries. No VS Code here;
// extension.js connects it to the editor.
'use strict';
const fs = require('fs');
const path = require('path');

const FLAG = /^(as\s+written|regex)\s+/;
const LANGUAGE_LINE = /^language\s+(\w+)\s*$/;
// Fields of an entry (a `language`, `flag`, `modifier` or `statement`). `does` and
// `hook` can hold a body in another language, like a def's line can.
const ENTRY_FIELD = /^(does|hook|words|editor|reading|replaces)\b/;
const DOES_FIELD = /^does\s+in\s+(\w+)(?:\[[^\]]*\])?\s*$/;
const HOOK_FIELD = /^hook\s+(\w+)\s+(\w+)\s+in\s+(\w+)(?:\[[^\]]*\])?\s*$/;
const ENTRY_LINE = /^(language|flag|modifier|statement)\s+(\w+)\s*$/;

// The languages declared with `language NAME` in these texts, plus Python (built in).
function languageNames(texts) {
  const names = new Set(['python']);
  for (const text of texts) for (const m of text.matchAll(/^language\s+(\w+)\s*$/gm)) names.add(m[1]);
  return names;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

function addFlag(flags, text) {
  for (const word of text.split(/[\s,]+/)) {
    if (word) flags.add(word === 'written' ? 'as written' : word);
  }
}

// `def say A0`, `python[written] A0 is A1`, `html greeting A0`: a definition line
// starts with its language (def is one), then flags in brackets or as words, then
// the pattern. The old reader only found lines starting with the word `def`.
function parseDefinitionLine(line, languages) {
  const known = new Set(['def', ...languages]);
  const names = [...known].sort((a, b) => b.length - a.length);
  const start = new RegExp('^(' + names.map(escapeRegex).join('|') + ')(\\[[^\\]]*\\])?(?=\\s)').exec(line);
  if (!start) return null;
  let language = start[1];
  const flags = new Set();
  if (start[2]) addFlag(flags, start[2].slice(1, -1));
  let rest = line.slice(start[0].length).trim();
  let flag;
  // `def python as written X`: `def` is the language keyword, `python` its body's language
  if (language === 'def' && (flag = /^(\w+)\s+/.exec(rest)) && known.has(flag[1])) {
    language = flag[1];
    rest = rest.slice(flag[0].length).trim();
  }
  while ((flag = FLAG.exec(rest))) {
    addFlag(flags, flag[1]);
    rest = rest.slice(flag[0].length).trim();
  }
  if (!rest) return null;
  flags.add(language);
  return { language, flags, pattern: rest };
}

function closingParen(text, start) {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '(') depth++;
    if (text[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

// Same rules as readable_to_regex() in core/definition.py. Fixed words become
// named groups k0, k1, ... so we know where each one matched.
function readableToRegex(text, argumentName) {
  const restricted = new RegExp('^\\(' + escapeRegex(argumentName) + '\\d+:');
  const argument = new RegExp('^' + escapeRegex(argumentName) + '\\d+$');
  const tokens = []; // [isSymbol, regex, isArgument]
  let keywords = 0;
  let pos = 0;
  while (pos < text.length) {
    if (/\s/.test(text[pos])) { pos++; continue; }
    const m = restricted.exec(text.slice(pos));
    if (m) {
      const end = closingParen(text, pos + m[0].length);
      if (end < 0) return null;
      tokens.push([false, '(?:' + text.slice(pos + m[0].length, end).trim() + ')', true]);
      pos = end + 1;
      continue;
    }
    let end = pos;
    while (end < text.length && !/\s/.test(text[end])) end++;
    const word = text.slice(pos, end);
    pos = end;
    if (argument.test(word)) tokens.push([false, '[\\s\\S]+', true]);
    // "A0": a text stands there (strings are masked as \u0001)
    else if (word.length > 2 && word[0] === '"' && word[word.length - 1] === '"' && argument.test(word.slice(1, -1))) tokens.push([true, '\u0001+', true, 'text']);
    else {
      // a fixed word only matches a whole word, like the engine reads it: `place` not inside `places`
      const letter = /[\p{L}\p{N}_]/u;
      const before = letter.test(word[0]) ? '(?<![\\p{L}\\p{N}_])' : '';
      const after = letter.test(word[word.length - 1]) ? '(?![\\p{L}\\p{N}_])' : '';
      tokens.push([!letter.test(word), before + '(?<k' + keywords++ + '>' + escapeRegex(word) + ')' + after, false]);
    }
  }
  let source = '';
  tokens.forEach(([isSymbol, part], i) => {
    if (i) source += (isSymbol || tokens[i - 1][0]) ? '\\s*' : '\\s+';
    source += part;
  });
  // only arguments and texts (like joined text, `A0 "A1"`): no words to show
  if (!source || tokens.every(([, part, , kind]) => part === '[\\s\\S]+' || kind === 'text')) return null;
  const isArgument = token => token[2];
  const edges = { leadingArgument: isArgument(tokens[0]), trailingArgument: isArgument(tokens[tokens.length - 1]) };
  // no fixed words at all (like the number-words def): the whole match counts, as whole words only,
  // so `ten` isn't found inside `written`
  return keywords ? { source, keywords, ...edges }
    : { source: '(?<![\\p{L}\\p{N}_])(?<k0>' + source + ')(?![\\p{L}\\p{N}_])', keywords: 0 };
}

// `def regex ...`: every plain group is a fixed word
function rawRegex(text, argumentName) {
  let keywords = 0;
  let source = text
    .replace(new RegExp('\\(' + escapeRegex(argumentName) + '\\d+:\\s*', 'g'), '(?:')
    .replace(new RegExp(escapeRegex(argumentName) + '\\d+', 'g'), '[\\s\\S]+')
    .replace(/(^|[^\\])\((?!\?)/g, (all, before) => before + '(?<k' + keywords++ + '>');
  return keywords ? { source, keywords } : null;
}

function compile(made) {
  if (!made) return null;
  try {
    // greedy arguments find the last place a phrase fits, lazy ones the first;
    // both are searched so every use of a phrase on a line is found
    const lazy = made.source.replace(/\[\\s\\S\]\+/g, '[\\s\\S]+?');
    return { ...made, regex: new RegExp(made.source, 'gdu'), lazy: new RegExp(lazy, 'gdu') };
  } catch { return null; }
}

// Everything a file defines: def lines in any language, entries, `X means Y`
// lines, and which lines are bodies in another language.
function indexText(file, text, languages = languageNames([text])) {
  const defs = [];
  const entries = [];
  const lines = text.split(/\r?\n/);
  let argumentName = 'A';
  // `comment is X` makes X the comment marker from that line to the end of the file,
  // like the engine; each file starts with //
  let comment = '//';
  const commentLines = new Map(); // comment line -> its marker
  let inPython = false;
  let inHtml = null;           // the def or field line of the HTML body being read
  let entryBody = null;        // the entry field whose body is being read
  const pythonLines = new Set(); // lines in another language: Python or HTML bodies
  const htmlLines = new Map();   // HTML body line -> its def or field line
  const entryBodies = new Map(); // body line -> its `does`/`hook` field
  const languageLines = [];      // { name, line } of each `language NAME`
  const sequence = []; // ['import', file] (a `use` line) and ['def', group] in file order, for defOrder()
  let group = null;    // first line of the def group being written, until its body starts
  lines.forEach((line, number) => {
    if (/^\s/.test(line) && line.trim()) {
      const text = line.trim();
      if (ENTRY_FIELD.test(text)) {
        // a field starts its own body; a sibling field ends the one before it
        const does = DOES_FIELD.exec(text);
        const hook = HOOK_FIELD.exec(text);
        const language = does ? does[1] : hook ? hook[3] : null;
        inPython = language !== null && language !== 'def';
        inHtml = language === 'html' ? number : null;
        entryBody = language === null ? null : {
          language, pattern: '', argumentName, flags: new Set(),
          field: text, cycle: hook && hook[1], phase: hook && hook[2],
        };
        group = null;
        return;
      }
      if (inPython) {
        pythonLines.add(number);
        if (entryBody) entryBodies.set(number, entryBody);
      }
      if (inHtml !== null) htmlLines.set(number, inHtml);
      // like the engine: an indented comment is a comment, except inside a Python/HTML body
      else if (!inPython && text.startsWith(comment)) commentLines.set(number, comment);
      group = null;
      return;
    }
    if (!line.trim()) return;
    if (line.trim().startsWith(comment)) { commentLines.set(number, comment); return; }
    inPython = false;
    inHtml = null;
    entryBody = null;
    let m;
    const parsed = parseDefinitionLine(line, languages);
    if (!parsed) group = null;
    // `use FILE`, or `use NAMES from FILE`: either way FILE runs
    if ((m = /^use\s+(.+?)\s*$/.exec(line))) { const from = /\s+from\s+(\S+)$/.exec(m[1]); sequence.push(['import', from ? from[1] : m[1]]); return; }
    // `language NAME`: its body is the Python that runs that language
    if ((m = LANGUAGE_LINE.exec(line))) { languageLines.push({ name: m[1], line: number }); inPython = true; return; }
    // `modifier shared`, `statement comment`, ...: the entries a line can point at
    if ((m = ENTRY_LINE.exec(line))) { entries.push({ kind: m[1], name: m[2], file, line: number }); return; }
    if ((m = /^argument\s+is\s+(.+?)\s*$/.exec(line))) { argumentName = m[1]; return; }
    if ((m = /^comment\s+is\s+(.+?)\s*$/.exec(line))) { comment = m[1]; return; }
    if (parsed) {
      const { language, flags, pattern: rest } = parsed;
      // a body in another language (Python, HTML, ...): no def-lang phrases or variables in it
      inPython = language !== 'def';
      if (group === null) { group = number; sequence.push(['def', group]); }
      if (language === 'html') inHtml = group;
      const texts = flags.has('regex') ? rest.split(' or ') : [rest];
      for (const t of texts) {
        const pattern = compile(flags.has('regex') ? rawRegex(t.trim(), argumentName) : readableToRegex(t.trim(), argumentName));
        if (pattern) defs.push({ file, line: number, text: line.trim(), pattern: t.trim(), argumentName, group, flags, language, ...pattern });
      }
      return;
    }
    if (!/^(use|comment|indent|shared|error)\b/.test(line) && (m = /^(.+?)\s+means\s+(.+?)\s*$/.exec(line))) {
      const words = m[1].trim().split(/\s+/).map(escapeRegex).join('\\s+');
      const pattern = compile({ source: '(?<!\\S)(?<k0>' + words + ')(?!\\S)', keywords: m[1].trim().split(/\s+/).length });
      if (pattern) defs.push({ file, line: number, text: line.trim(), pattern: m[1].trim(), alias: true, ...pattern });
    }
  });
  return { file, defs, entries, lines, pythonLines, htmlLines, languageLines, commentLines, sequence, entryBodies };
}

// Every match of a def on a line, with greedy and with lazy arguments.
function* matches(text, def) {
  for (const regex of [def.regex, def.lazy]) {
    regex.lastIndex = 0;
    for (const m of text.matchAll(regex)) {
      if (!m[0]) break;
      yield m;
    }
  }
}

// Quoted text can't match a pattern; keep its length so positions stay right.
function maskStrings(line) {
  return line.replace(/"[^"]*"/g, s => '\u0001'.repeat(s.length));
}

// The defs whose fixed words are under the cursor, best first (most fixed words,
// like the engine's "a longer phrase wins").
function findDefinitions(line, column, indexes) {
  const masked = maskStrings(line);
  if (masked[column] === '\u0001') return [];
  const hits = [];
  for (const index of indexes) {
    for (const def of index.defs) {
      for (const m of matches(masked, def)) {
        const spans = Object.values(m.indices.groups || {}).filter(Boolean).sort((a, b) => a[0] - b[0]);
        const at = spans.findIndex(span => span[0] <= column && column < span[1]);
        if (at < 0) continue;
        // the phrase under the cursor: fixed words next to each other, with only spaces between
        let first = at;
        let last = at;
        const touching = (a, b) => /^\s*$/.test(line.slice(spans[a][1], spans[b][0]));
        while (first > 0 && touching(first - 1, first)) first--;
        while (last < spans.length - 1 && touching(last, last + 1)) last++;
        hits.push({ ...def, def, score: def.keywords, range: [spans[first][0], spans[last][1]], spans });
        break;
      }
    }
  }
  if (!hits.length) return [];
  const best = Math.max(...hits.map(h => h.score));
  // one result per definition: stacked def lines of one def share a body, so they
  // show once, pointing at the def's first line
  const seen = new Set();
  return hits
    .filter(h => h.score === best)
    .map(h => ({ ...h, line: h.group ?? h.line }))
    .filter(h => !seen.has(h.file + ':' + h.line) && seen.add(h.file + ':' + h.line));
}

// Words that are the language's own syntax; they keep their keyword colour.
const SYNTAX_WORDS = new Set(['is', 'not', 'are', 'does', 'do', 'and', 'or', 'both', 'either', 'if', 'otherwise',
  'repeat', 'times', 'while', 'for', 'each', 'in', 'means']);
const isSyntax = phrase => phrase.split(/\s+/).every(word => SYNTAX_WORDS.has(word) || !/[\p{L}\p{N}_]/u.test(word));

// Every def phrase on a line, as [start, end]: fixed words of one def that sit next
// to each other ("count the visit"), longest first when two overlap. Used to colour
// each phrase as one item.
function phrasesIn(line, indexes) {
  return allPhrases(line, indexes).filter(p => !isSyntax(line.slice(p.start, p.end))).map(p => [p.start, p.end]);
}

// Like phrasesIn, with syntax words too, and the def of each phrase: { start, end, def }.
function allPhrases(line, indexes) {
  const masked = maskStrings(line);
  const found = [];
  for (const index of indexes) {
    for (const def of index.defs) {
      if (def.alias || !def.keywords) continue;
      for (const m of matches(masked, def)) {
        const spans = Object.values(m.indices.groups || {}).filter(Boolean).sort((a, b) => a[0] - b[0]);
        let run = null;
        for (const span of spans) {
          if (run && /^\s*$/.test(line.slice(run[1], span[0]))) run[1] = span[1];
          else { if (run) found.push([...run, def.keywords, def]); run = [span[0], span[1]]; }
        }
        if (run) found.push([...run, def.keywords, def]);
      }
    }
  }
  // longer phrases (and defs with more fixed words) win; no overlaps
  found.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]) || b[2] - a[2]);
  const taken = [];
  for (const [start, end, , def] of found) {
    if (taken.some(t => start < t.end && t.start < end)) continue;
    taken.push({ start, end, def });
  }
  return taken.sort((a, b) => a.start - b.start);
}

// The order in which a program makes its defs: follow its `use` lines like the engine
// does (a used file runs where the line is written). Earlier defs bind looser.
function defOrder(startFiles, indexes) {
  const byFile = new Map(indexes.map(index => [index.file, index]));
  const order = new Map();
  const visited = new Set();
  function walk(file) {
    const index = byFile.get(file);
    if (!index || visited.has(file)) return;
    visited.add(file);
    for (const [kind, value] of index.sequence) {
      if (kind === 'import') walk(resolveImport(value, file));
      else order.set(file + ':' + value, order.size);
    }
  }
  for (const file of [].concat(startFiles)) walk(file);
  return order;
}

// The files whose defs `file` can use: the files its program uses (from main.def or
// init.def) and the file itself, like the engine sees them.
function visibleIndexes(file, indexes) {
  const byFile = new Map(indexes.map(index => [index.file, index]));
  const seen = new Set();
  function walk(f) {
    const index = byFile.get(f);
    if (!index || seen.has(f)) return;
    seen.add(f);
    for (const [kind, value] of index.sequence) if (kind === 'import') walk(resolveImport(value, f));
  }
  for (const start of orderStarts(file)) walk(start);
  return indexes.filter(index => seen.has(index.file));
}

// Where to start reading the order for a file: its package's main.def, the
// project's init.def, then the file itself.
function orderStarts(file) {
  const home = packageFolder(file);
  const starts = [home && path.join(home, 'main.def'), resolveImport('core', file), file].filter(Boolean);
  // A library topic (`deflang-lib/errors/main.def`) is its own engine program, but
  // while authoring it the editor should see the collection's words: its sibling
  // `core` library, which uses every topic. Otherwise the only visible defs are the
  // topic and the libraries its own libraries.toml lists.
  if (home && fs.existsSync(path.join(home, 'library.toml'))) {
    const core = path.join(path.dirname(home), 'core', 'main.def');
    if (fs.existsSync(core)) starts.push(core);
  }
  return [...new Set(starts)];
}

// How loose a def binds by itself: the order it was made in (earlier is looser).
function looseness(def, order) {
  const rank = order.get(def.file + ':' + def.group);
  return rank === undefined ? Infinity : rank;
}

function looser(a, b, order) {
  return looseness(a, order) < looseness(b, order);
}

// Whether `def` wraps the text from `start` to `end` on the line, like the engine reads it
// (core/tree.py, wraps):
//   - brackets: its fixed words surround that text (`api ... runs x is 1 and sends ...`, `is 5 > 3 ?`);
//   - a sentence (an `as written` def that starts the line with two or more fixed words)
//     wraps what follows them, except a closing word at the very end, like `?`.
function wrapsOnLine(def, start, end, line, inner) {
  if (def.alias || def.keywords < 2) return false;
  for (const m of matches(maskStrings(line), def)) {
    const spans = Object.values(m.indices.groups || {}).filter(Boolean).sort((a, b) => a[0] - b[0]);
    if (spans.length < 2) continue;
    const first = spans[0][0];
    const last = spans[spans.length - 1][1];
    if (spans.some(s => s[1] <= start) && spans.some(s => s[0] >= end)) return true;
    const sentence = def.flags && def.flags.has('as written') && first === line.search(/\S/);
    // a closing word at the very end (the `?` of a question) isn't wrapped: it takes the line itself
    const closing = inner && inner.leadingArgument && end >= line.trimEnd().length;
    if (sentence && start >= last && !closing) return true;
  }
  return false;
}

// The use of a def under the cursor: its fixed words and the parts that fill its
// arguments (with the spaces between them), as [start, end] pairs. An argument at the start or end of the pattern
// stops at the first phrase that binds looser, like the engine reads the line.
function structureAt(line, column, indexes, order) {
  const hit = findDefinitions(line, column, indexes)[0];
  if (!hit) return null;
  const keywords = hit.spans.map(span => [span[0], span[1]]);
  const parts = [];
  const add = (start, end) => {
    const text = line.slice(start, end);
    const from = start + (text.length - text.trimStart().length);
    const to = end - (text.length - text.trimEnd().length);
    if (from < to) parts.push([from, to]);
  };
  for (let i = 0; i + 1 < keywords.length; i++) add(keywords[i][1], keywords[i + 1][0]);

  const own = p => keywords.some(([s, e]) => p.start < e && s < p.end);
  // a phrase stops an argument at the start or end if it binds looser: it wraps this use of the
  // def, or it comes earlier in the order and this def doesn't wrap it
  const [from0, to0] = [keywords[0][0], keywords[keywords.length - 1][1]];
  const stops = allPhrases(line, indexes).filter(p => !own(p) && (wrapsOnLine(p.def, from0, to0, line, hit.def) ||
    (looser(p.def, hit.def, order) && !wrapsOnLine(hit.def, p.start, p.end, line, p.def))));
  const first = keywords[0][0];
  const last = keywords[keywords.length - 1][1];
  if (hit.def.leadingArgument) {
    const before = stops.filter(p => p.end <= first).map(p => p.end);
    const start = Math.max(line.search(/\S/), ...before);
    add(line[start] === '`' ? start + 1 : start, first);
  }
  if (hit.def.trailingArgument) {
    const after = stops.filter(p => p.start >= last).map(p => p.start);
    let end = Math.min(line.trimEnd().length, ...after);
    if (line[end - 1] === '`') end--;
    add(last, end);
  }
  // one continuous line: fixed words next to each other become one run ("and sends"),
  // and everything else between the first and last part, spaces included, is argument
  const runs = [];
  for (const [start, end] of keywords) {
    const last = runs[runs.length - 1];
    if (last && /^\s*$/.test(line.slice(last[1], start))) last[1] = end;
    else runs.push([start, end]);
  }
  const all = [...runs, ...parts];
  const from = Math.min(...all.map(p => p[0]));
  const to = Math.max(...all.map(p => p[1]));
  const gaps = [];
  let at = from;
  for (const [start, end] of runs) {
    if (at < start) gaps.push([at, start]);
    at = end;
  }
  if (at < to) gaps.push([at, to]);
  return { keywords: runs, parts: gaps };
}

// Every variable name a program gives a value to, for colouring.
function variableNames(indexes) {
  const names = new Set();
  const patterns = [
    /^\s*`?([\p{L}\p{N}_]+)\s+is\s/u,
    /^\s*shared\s+([\p{L}\p{N}_]+)/u,
    /^\s*`?give\s+(?:\d+\s+)?([\p{L}\p{N}_]+)/u,
    /^\s*for\s+each\s+([\p{L}\p{N}_]+)\s+in\s/u,
    /^\s*add\s+.+\s+to\s+([\p{L}\p{N}_]+)\s*$/u,
  ];
  for (const index of indexes) {
    index.lines.forEach((line, n) => {
      if (index.pythonLines.has(n) || index.commentLines.has(n) || /^\s*(def\s|argument\s+is\s|comment\s+is\s)/.test(line)) return;
      const used = /^use\s+(.+?)\s+from\s+\S+\s*$/.exec(line);
      if (used) {
        for (const part of used[1].split(',')) names.add(part.split(/\s+as\s+/).pop().trim());
        return;
      }
      for (const pattern of patterns) {
        const m = pattern.exec(maskStrings(line));
        if (m && !SYNTAX_WORDS.has(m[1])) names.add(m[1]);
      }
    });
  }
  return names;
}

// Where variables are used on a line, as [start, end]: names from variableNames(),
// outside text and outside def phrases.
function variablesIn(line, names, phrases) {
  const masked = maskStrings(line);
  const found = [];
  for (const m of masked.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const [start, end] = [m.index, m.index + m[0].length];
    if (!names.has(m[0]) || phrases.some(([s, e]) => start < e && s < end)) continue;
    found.push([start, end]);
  }
  return found;
}

// Where an entry (`modifier shared`, `statement comment`, ...) is declared. Its
// help and declaration are what a use of that word points at.
function findEntry(name, currentFile, indexes) {
  if (!/^\w+$/.test(name)) return [];
  const home = packageFolder(currentFile);
  const rank = index => index.file === currentFile ? 0 : home && index.file.startsWith(home + path.sep) ? 1 : 2;
  const ordered = [...indexes].sort((a, b) => rank(a) - rank(b));
  const found = [];
  for (const index of ordered) for (const entry of index.entries || []) {
    if (entry.name === name) found.push({ ...entry });
  }
  return found;
}

// Where a variable first gets a value: `x is ...`, `give x`, `for each x in`, `add ... to x`.
function findVariable(word, currentFile, indexes) {
  if (!/^[\p{L}\p{N}_]+$/u.test(word)) return null;
  const w = escapeRegex(word);
  const patterns = [
    new RegExp('^\\s*(?:shared\\s+)?' + w + '\\s+is\\s'),
    new RegExp('^\\s*`?give\\s+(?:\\S+\\s+)?' + w + '\\b'),
    new RegExp('^\\s*for\\s+each\\s+' + w + '\\s+in\\s'),
    new RegExp('^\\s*add\\s+.+\\s+to\\s+' + w + '\\s*$'),
  ];
  // the current file first, then the rest of its package, then everything else
  const home = packageFolder(currentFile);
  const rank = index => index.file === currentFile ? 0 : home && index.file.startsWith(home + path.sep) ? 1 : 2;
  const ordered = [...indexes].sort((a, b) => rank(a) - rank(b));
  for (const index of ordered) {
    for (let n = 0; n < index.lines.length; n++) {
      if (index.pythonLines.has(n)) continue;
      const line = maskStrings(index.lines[n]);
      if (patterns.some(p => p.test(line))) return { file: index.file, line: n };
    }
  }
  return null;
}

// `use def/web`: next to the file, then each folder above it (like the engine:
// the file's folder, the program's folder, the project folder).
function resolveImport(name, fromFile) {
  const here = path.dirname(fromFile);
  const program = programFolder(fromFile);
  for (const dir of [here, program]) {
    const candidate = path.join(dir, name + '.def');
    if (fs.existsSync(candidate)) return candidate;
  }
  // a library: `core` is its main.def, `web/server` its server.def
  const [library, ...inside] = name.split('/');
  const folders = [libraryFolder(program, library)];
  // a library's file: the libraries its own libraries.toml lists
  if (fs.existsSync(path.join(here, 'library.toml'))) folders.push(libraryFolder(here, library));
  for (const folder of folders.filter(Boolean)) {
    const candidate = path.join(folder, (inside.join('/') || 'main') + '.def');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// The program a file belongs to: the nearest folder above it with a main.def or a
// libraries.toml, else the file's own folder (like the engine's program folder).
function programFolder(file) {
  for (let d = path.dirname(file); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'main.def')) || fs.existsSync(path.join(d, 'libraries.toml'))) return d;
    if (path.dirname(d) === d) return path.dirname(file);
  }
}

// A program's libraries.toml: [{ name, from, link }].
function listedLibraries(owner) {
  // a program's or a library's libraries.toml: one table each,
  //   name = { from = "...", link = true }  or  { from = "URL#folder", version = "0.1.0", global = true }
  let text;
  try { text = fs.readFileSync(path.join(owner, 'libraries.toml'), 'utf8'); } catch { return []; }
  const found = [];
  for (const line of text.split('\n')) {
    const m = /^\s*([\w-]+)\s*=\s*\{(.*)\}\s*$/.exec(line);
    if (!m) continue;
    const from = /\bfrom\s*=\s*"([^"]*)"/.exec(m[2]);
    if (!from) continue;
    const version = /\bversion\s*=\s*"([^"]*)"/.exec(m[2]);
    found.push({ name: m[1], from: from[1], link: /\blink\s*=\s*true\b/.test(m[2]), version: version ? version[1] : null,
      global: /\bglobal\s*=\s*true\b/.test(m[2]) });
  }
  return found;
}

// Where a program's library is: its installed copy, or the folder it links to.
function libraryFolder(owner, name) {
  // like the engine (deflang/libraries.py, folder_of): a copy in libraries/, a global
  // copy, or a folder (linked, or a library's folder of the same source)
  const copy = path.join(owner, 'libraries', name);
  if (fs.existsSync(path.join(copy, 'library.toml'))) return copy;
  const entry = listedLibraries(owner).find(e => e.name === name);
  if (!entry) return null;
  let found;
  if (entry.global) found = path.join(globalFolder(), name, entry.version || '');
  else if (isGit(entry.from)) return null; // not installed yet
  else found = path.resolve(owner, entry.from);
  if (!fs.existsSync(path.join(found, 'library.toml'))) return null;
  // the real folder, not a link to it: Ctrl+click opens the file itself
  try { return fs.realpathSync(found); } catch { return found; }
}

const isGit = source => source.includes('://') || source.split('#')[0].endsWith('.git');

// Where global libraries are: $DEFLANG_GLOBAL, else `def-lang setup`'s choice, else ~/.def-lang/libraries.
function globalFolder() {
  if (process.env.DEFLANG_GLOBAL) return process.env.DEFLANG_GLOBAL.replace(/^~/, require('os').homedir());
  const home = require('os').homedir();
  try {
    const m = /^\s*global_folder\s*=\s*"([^"]*)"/m.exec(fs.readFileSync(path.join(home, '.def-lang', 'settings.toml'), 'utf8'));
    if (m) return m[1].replace(/^~/, home);
  } catch {}
  return path.join(home, '.def-lang', 'libraries');
}

// The folders of linked libraries, for indexing ones outside the workspace.
function linkedFolders(owner) {
  // the folders of the libraries it lists that aren't copies in libraries/: linked,
  // global, or a library's folder of the same source; to index ones outside the workspace
  return listedLibraries(owner).map(e => libraryFolder(owner, e.name)).filter(Boolean)
    .filter(folder => !folder.startsWith(path.join(owner, 'libraries') + path.sep));
}

// Is `line` a def-lang comment (not a line inside a Python, HTML, ... body)?
function isComment(index, line) {
  if (index.pythonLines.has(line)) return false;
  return index.commentLines.has(line);
}

// Where the language `name` is declared: { file, line }, or null.
function findLanguage(name, indexes) {
  for (const index of indexes) {
    const found = index.languageLines.find(l => l.name === name);
    if (found) return { file: index.file, line: found.line };
  }
  return null;
}

// ---- HTML views: {name}, api="/api/x", loads="/api/x" and href="/x"

const API_LINE = /^\s*api\s+"([^"]+)"\s+(?:runs\s+.+?\s+and\s+)?sends\s+(.+?)\s*$/;

// Every `api "/x" ... sends a, b` line: { file, line, path, names }.
function apiRoutes(indexes) {
  const routes = [];
  for (const index of indexes) {
    index.lines.forEach((line, n) => {
      const m = !index.pythonLines.has(n) && API_LINE.exec(line);
      if (m) routes.push({ file: index.file, line: n, path: m[1], names: m[2].split(',').map(name => name.trim()) });
    });
  }
  return routes;
}

// Every <view path="..."> of an HTML def: { file, line (the def line), path }.
function viewPaths(indexes) {
  const views = [];
  for (const index of indexes) {
    for (const [n, defLine] of index.htmlLines) {
      const m = /<view\b[^>]*\bpath="([^"]*)"/.exec(index.lines[n]);
      if (m) views.push({ file: index.file, line: defLine, path: m[1] });
    }
  }
  return views;
}

// Items of the same package as `file` first.
function samePackageFirst(items, file) {
  const home = packageFolder(file);
  const rank = item => home && item.file.startsWith(home + path.sep) ? 0 : 1;
  return [...items].sort((a, b) => rank(a) - rank(b));
}

// What is at `column` of an HTML body line: { kind: 'field' | 'api' | 'view' | 'def', value, start, end }.
function htmlReferenceAt(line, column) {
  const kinds = [
    [/\{(\w+)\}/g, 'field'],
    [/\b(?:api|loads)="([^"]*)"/g, 'api'],
    [/\bhref="(\/[^"]*)"/g, 'view'],
    [/(?<![\w-])def="([^"]+)"/g, 'def'],
  ];
  for (const [regex, kind] of kinds) {
    for (const m of line.matchAll(regex)) {
      if (m.index <= column && column < m.index + m[0].length) {
        const start = m.index + m[0].indexOf(m[1]);
        return { kind, value: m[1], start, end: start + m[1].length };
      }
    }
  }
  return null;
}

// Where an HTML reference leads: [{ file, line, label }], the most useful first.
// {name}: where the variable gets its value (or the def of that name), and the api that sends it.
function resolveHtmlReference(reference, file, indexes) {
  if (reference.kind === 'api') {
    return samePackageFirst(apiRoutes(indexes).filter(r => r.path === reference.value), file).slice(0, 1)
      .map(r => ({ file: r.file, line: r.line, label: 'the api' }));
  }
  if (reference.kind === 'def') {
    // <nav def="site nav">, <script def="web script">: the def whose result the element gets
    const def = findDefinitions(reference.value, 0, indexes)[0];
    return def ? [{ file: def.file, line: def.line, label: 'puts in' }] : [];
  }
  if (reference.kind === 'view') {
    return samePackageFirst(viewPaths(indexes).filter(v => v.path === reference.value), file).slice(0, 1)
      .map(v => ({ file: v.file, line: v.line, label: 'the view' }));
  }
  const found = [];
  // a program variable of this package; one set inside a def is that def's own
  const home = packageFolder(file);
  let variable = findVariable(reference.value, file, indexes);
  if (variable) {
    const line = indexes.find(i => i.file === variable.file).lines[variable.line];
    if (/^\s/.test(line) || (home && !variable.file.startsWith(home + path.sep))) variable = null;
  }
  if (variable) found.push({ ...variable, label: 'gets its value' });
  else {
    const def = findDefinitions(reference.value, 0, indexes)[0];
    if (def) found.push({ file: def.file, line: def.line, label: 'is the def' });
  }
  const route = samePackageFirst(apiRoutes(indexes).filter(r => r.names.includes(reference.value)), file)[0];
  if (route) found.push({ file: route.file, line: route.line, label: 'sent by' });
  return found;
}

// The package a file belongs to: the nearest folder above it with a main.def, or null.
function packageFolder(file) {
  for (let d = path.dirname(file); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'main.def'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

// `template "pages/x.html"`: relative to the program folder (the nearest folder with a main.def).
function resolveProgramFile(name, fromFile) {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null;
  const dir = packageFolder(fromFile) || path.dirname(fromFile);
  const candidate = path.join(dir, name);
  return fs.existsSync(candidate) ? candidate : null;
}

// Clickable file names on a line: [start, end, target]
function findLinks(line, fromFile) {
  const links = [];
  let m;
  if ((m = /^(use\s+(?:.+?\s+from\s+)?)(\S+)\s*$/.exec(line))) {
    const target = resolveImport(m[2], fromFile);
    if (target) links.push([m[1].length, m[1].length + m[2].length, target]);
  }
  const fileWords = /\b(?:template|assets\s+are\s+in)\s+"([^"]+)"/g;
  while ((m = fileWords.exec(line))) {
    const target = resolveProgramFile(m[1], fromFile);
    const start = m.index + m[0].length - m[1].length - 1;
    if (target) links.push([start, start + m[1].length, target]);
  }
  return links;
}

const MEANS_LINE = /^(?!(?:def|use|comment|argument|error)\s)\S.*\s+means\s+/;

// A def line is one the reader made into a definition: `def X`, but also
// `python[written] X`, `html X`, and the other ways a language is written.
function isDefLine(index, n) {
  return n >= 0 && n < index.lines.length &&
    (/^def\s/.test(index.lines[n]) || index.defs.some(d => d.line === n && !d.alias));
}

// The description of the definition on `line`: the comment lines right above it
// (above the first line of a def group, or of a run of `means` lines).
function descriptionOf(index, line) {
  const lines = index.lines;
  const same = isDefLine(index, line) ? (n => isDefLine(index, n)) : (n => MEANS_LINE.test(lines[n] || ''));
  let start = line;
  while (start > 0 && same(start - 1)) start--;
  const comment = n => {
    const marker = index.commentLines.get(n);
    return marker === undefined ? null : lines[n].trim().slice(marker.length).trim();
  };
  const found = [];
  for (let n = start - 1; n >= 0 && comment(n) !== null; n--) found.unshift(comment(n));
  return found.join('\n').trim();
}

// A description split into its text and its examples:
//   // Example: 22.857 rounded to 1 place
//   //          → 22.9
// gives { text, examples: [{ input: '22.857 rounded to 1 place', result: '22.9' }] }.
// "(not checked)" is a note for the tests and is left out.
function splitDescription(description) {
  const lines = description.split('\n');
  const text = [];
  const examples = [];
  for (let i = 0; i < lines.length; i++) {
    const example = /^Example:\s*(.*)$/.exec(lines[i]);
    if (!example) { text.push(lines[i]); continue; }
    const result = /^→\s*(.*)$/.exec(lines[i + 1] || '');
    if (result) i++;
    examples.push({ input: example[1], result: result ? result[1].replace(/\s*\(not checked\)\s*$/, '') : '' });
  }
  return { text: text.join('\n').trim(), examples };
}

// Only the def line(s) of the definition on `line`: all the lines of a def group
// (every way to write it), or the `means` line. The body is a Ctrl+click away.
function headerOf(index, line) {
  const lines = index.lines;
  const isDef = n => isDefLine(index, n);
  if (!isDef(line)) return lines[line];
  let start = line;
  while (isDef(start - 1)) start--;
  let end = line;
  while (isDef(end + 1)) end++;
  return lines.slice(start, end + 1).join('\n');
}

// The source of the definition on `line`: its group of def lines and its body
// (for a `means` line, just that line). Long bodies are cut after `limit` lines.
function sourceOf(index, line, limit = 15) {
  const lines = index.lines;
  const isDef = n => isDefLine(index, n);
  if (!isDef(line)) return lines[line];
  let start = line;
  while (isDef(start - 1)) start--;
  let end = line;
  while (isDef(end + 1)) end++;
  const body = [];
  for (let n = end + 1; n < lines.length && (!lines[n].trim() || /^\s/.test(lines[n])); n++) body.push(lines[n]);
  while (body.length && !body[body.length - 1].trim()) body.pop();
  const cut = body.length > limit;
  return [...lines.slice(start, end + 1), ...body.slice(0, limit), ...(cut ? ['    ...'] : [])].join('\n');
}

// In an HTML template, the def-lang inside {{ ... }} under the cursor: { text, start } or null.
function templateExpressionAt(line, column) {
  for (const m of line.matchAll(/\{\{(.+?)\}\}/g)) {
    const start = m.index + 2;
    if (start <= column && column < start + m[1].length) return { text: m[1], start };
  }
  return null;
}

// The word (letters, digits, _) at `column`, or null.
function wordAt(text, column) {
  for (const m of text.matchAll(/[\p{L}\p{N}_]+/gu)) {
    if (m.index <= column && column < m.index + m[0].length) return { text: m[0], start: m.index };
  }
  return null;
}

// What each def flag means, and the question that tells you when a def needs it.
const FLAG_HELP = {
  'as written': '**as written**: the def gets its arguments as they are written, not their values.\n\n' +
    'Use it when the def needs the *words* of an argument: a name to store under, or code to run later, ' +
    'many times, or maybe not at all.\n\n' +
    'For example `x is 5` (x is a name), `repeat 3 times: say "hi"` (runs 3 times), ' +
    '`"yes" if 1 < 2 otherwise nope` (only one side runs), `api "/x" runs ...` (runs on each request).',
  'regex': '**regex**: the pattern is a regular expression; alternatives are split by ` or `.',
};

// The words that are the language's own keys, not library phrases. Hover shows what
// they do; cycles and phases are meaningful only inside a `hook` field.
const KEY_HELP = {
  'language': '**language**: declares how a body written in this language runs. Its `does` is the code that turns a definition\'s body into its value.',
  'flag': '**flag**: a word in brackets on a def or `does` line, like `def[written]`. Its `does` acts on the definition as it is made.',
  'modifier': '**modifier**: a word in front of a line. Its hooks act on that one line, so declaring it never installs behavior by itself.',
  'statement': '**statement**: a word that starts a line, like `comment is //`. Its `words` say how it is written and its `does` runs where it acts.',
  'does': '**does**: the entry\'s body, in the language written after `in`. It finds what it acts on in `self["entry"]`.',
  'words': '**words**: the pattern that says how a flag or statement is written. Its `A0`, `A1`, … get the words in those places.',
  'hook': '**hook**: declares one phase of a cycle: `hook CYCLE PHASE in LANGUAGE`. Declaring it installs nothing; the entry must be applied to a line.',
  'editor': '**editor**: tells the editor which language a definition\'s body is written in, for colours and completions.',
  'reading': '**reading**: a statement whose `does` runs while the file is read, before later lines are read (also in check and compile), because it decides how they are read.',
  'replaces': '**replaces**: says this entry takes the place of one declared in another file. Without it, two declarations of the same name are an error.',
  'file': '**file** cycle: reading a used file. `start` runs before its lines, `end` after them, `error` if reading fails.',
  'line': '**line** cycle: one line being read or run. A modifier in front of the line supplies the hook.',
  'define': '**define** cycle: making a definition or naming a variable. At `end` the new definition is in `self["cycle"]["definition"]`; on a name line the variable is in `self["cycle"]["variable"]`.',
  'call': '**call** cycle: calling a definition. `start` runs before its body, `end` after it, `error` if it fails. Its hooks live on the definition.',
  'body': '**body** cycle: a definition\'s body itself, inside its call. `self["cycle"]["body"]` is the lines about to run.',
  'scope': '**scope** cycle: a statement\'s lines under it and the rest of its `does`, with the files in `self["cycle"]["scope"]`.',
  'start': '**start** phase: runs before the operation. Put scratch values in `self["cycle"]["state"][owner]` here; a name hook must register the name now, before the line runs.',
  'end': '**end** phase: runs after the operation succeeds, with the state from `start`. End and error hooks run in reverse order.',
  'error': '**error** phase: runs if the operation raises. The exception is in `self["cycle"]["error"]`, then it is re-raised.',
  'self': '**self**: the interpreter a body runs in. `self.run(text)` runs def-lang, `self.say(value)` prints, and `self["…"]` is the tree it reads and changes. In a language\'s `does` body, `self["entry"]` is what the definition acts on: its `template`, `values`, `fill` and `body`.',
};
const HOOK_CYCLES = ['file', 'line', 'define', 'call', 'body', 'scope'];
const HOOK_PHASES = ['start', 'end', 'error'];
const HOOK_LINE = new RegExp('^hook\\s+(' + HOOK_CYCLES.join('|') + ')\\s+(' + HOOK_PHASES.join('|') + ')\\s+in\\s+\\w+(\\[[^\\]]*\\])?');

// A language key under the cursor: { key, start, end }, or null. Only where the word
// is syntax: an entry declaration, one of its fields, or part of a `hook` field.
function keyAt(line, column) {
  const word = wordAt(line, column);
  if (!word) return null;
  const end = word.start + word.text.length;
  const text = line.trim();
  const offset = line.indexOf(text);
  const hit = (key, start) => ({ key, start, end: start + key.length });
  const at = span => word.start >= offset + span && end <= offset + span + word.text.length;

  const declaration = /^(language|flag|modifier|statement)\s+\w+$/.exec(text);
  if (declaration && word.start === offset) return hit(declaration[1], offset);

  const hook = HOOK_LINE.exec(text);
  if (hook) {
    if (word.text === 'hook' && at(0)) return hit('hook', offset);
    if (word.text === hook[1]) return hit(hook[1], offset + text.indexOf(hook[1]));
    if (word.text === hook[2]) return hit(hook[2], offset + text.indexOf(hook[2], text.indexOf(hook[1]) + hook[1].length));
    return null;
  }
  const field = /^(does|hook|words|editor|reading|replaces)\b/.exec(text);
  if (field && word.text === field[1] && at(0)) return hit(field[1], offset);
  return null;
}

// The flag under the cursor on a def line: { flag, start, end }, or null. `languages`
// are the language words (python, html, ...), which can stand among the flags.
function flagAt(line, column, languages = new Set(['python'])) {
  const m = /^def\s+/.exec(line);
  if (!m) return null;
  let at = m[0].length;
  for (;;) {
    const word = /^(\w+)\s+/.exec(line.slice(at));
    if (word && languages.has(word[1])) { at += word[0].length; continue; }
    const f = FLAG.exec(line.slice(at));
    if (!f) return null;
    const end = at + f[1].length;
    if (at <= column && column < end) return { flag: f[1].split(/\s+/).join(' '), start: at, end };
    at += f[0].length;
  }
}

// The body lines of the def group starting at line `start`.
function bodyOf(index, start) {
  let n = start + 1;
  while (n < index.lines.length && /^def\s/.test(index.lines[n])) n++;
  const body = [];
  for (; n < index.lines.length; n++) {
    const line = index.lines[n];
    if (line.trim() && !/^\s/.test(line)) break;
    body.push(line);
  }
  return body;
}

// Flags a def probably needs but doesn't have: [{ line, message }]. A Python body that
// runs or names an argument itself (self.run(A1), self.variables[A0]) gets values unless the
// def is `as written`.
function flagWarnings(index, indexes) {
  const warnings = [];
  const groups = new Map();
  for (const def of index.defs) if (!def.alias && def.group !== undefined && !groups.has(def.group)) groups.set(def.group, def);
  for (const [start, def] of groups) {
    const flags = def.flags || new Set();
    if (def.language === 'python' && !flags.has('as written')) {
      const body = bodyOf(index, start).join('\n');
      const m = /self\.run\(\s*(A\d+)\s*\)|self\.variables\[\s*(A\d+)\s*\]|self\.(?:alias|share)\(\s*(A\d+)/.exec(body);
      if (m) {
        const name = m[1] || m[2] || m[3];
        warnings.push({ line: start, message: `${name} is already a value here, not its words. If this def needs the words of ${name} (a name, or code to run itself), add "as written".` });
      }
    }
  }
  return warnings;
}

// ---- completions (IntelliSense)

const STATEMENTS = [
  ['def', 'def ${1:words A0}\n\t$0', 'Makes a definition: its words, then its body indented below.'],
  ['use', 'use ${1}', 'Runs another .def file, or a library, once. `use NAMES from FILE` also gives this file the shared variables NAMES of FILE (`use visits as count from counter`).'],
  ['comment is', 'comment is ${1:#}', 'Lines starting with this are comments, from here to the end of the file (`//` by default).'],
  ['argument is', 'argument is ${1:X}', 'Arguments are written X0, X1, ... from here on (A0, A1, ... by default).'],
  ['shared', 'shared ${1:name}', 'In this file, NAME is the program\'s one shared variable (to the end of the file). The rest of the line runs as usual: `shared visits is 0`.'],
  ['indent', 'indent ${1:2}', 'How many spaces make one level, to the end of the file (4 by default; a tab is always one level).'],
  ['language', 'language ${1:name}\n\t$0', 'A language: the indented Python below runs the bodies of `def NAME ...`.'],
  ['error', 'error ${1:message}', 'Stops with this message.'],
];

// What a Python body can use besides Python itself (README: Python bodies).
const PYTHON_SELF = [
  ['run', 'run(${1:text})', 'Runs def-lang text and returns its value.'],
  ['say', 'say(${1:value})', 'Prints a value.'],
  ['variables', 'variables', 'The variables of the running code: `self.variables["x"] = 5`.'],
  ['share', 'share(${1:name}, ${2:value})', 'Makes a shared program variable.'],
  ['answer', 'answer', "The last question's answer: True, False, or None before any question."],
  ['alias', 'alias(${1:phrase}, ${2:words})', 'Makes `phrase` read as `words`.'],
  ['lookup', 'lookup(${1:name})', 'A variable\'s value, or an "unknown name" error.'],
  ['file_path', 'file_path(${1:name})', "A file's path, relative to the program's folder."],
  ['store', 'store(${1:"name"})', "A dict for a library's own state: the same dict every time for the same name."],
];
// The keys a Python body reads with `self["KEY"]` (the kernel's tree).
const PYTHON_KERNEL = [
  ['aliases', "Phrases `X means Y` has added, as {phrase: words}."],
  ['answer', "The last question's answer: True, False, or None."],
  ['cycle', 'The hook cycle running now: its file, owner, state, and what it acts on.'],
  ['definitions', 'Every definition the program has made, in the order made.'],
  ['entry', 'What the entry acts on: its kind, name and fields.'],
  ['file', 'The file being read or run now.'],
  ['files', "Each file's comment marker, argument name, indent, variables and shared names."],
  ['flag', "The kernel's flags, by name."],
  ['language', "The kernel's languages, by name."],
  ['mode', "'running', 'checking' or 'reloading'."],
  ['modifier', "The kernel's modifiers, by name."],
  ['program', "The program's folder."],
  ['shared', 'Shared values, keyed by (file, name).'],
  ['statement', "The kernel's statements, by name."],
  ['store', "A library's own state, by name: the same dict each time."],
  ['variables', "This file's variables (or a def's own, while it runs)."],
];
const KERNEL_HELP = Object.fromEntries(PYTHON_KERNEL);

// What a language's `does` body acts on: self["entry"][FIELD] (README, Writing an Entry).
const ENTRY_FIELDS = [
  ['kind', 'kind', "'language', 'flag', 'modifier' or 'statement'."],
  ['definition', 'definition', 'The definition the language, flag or modifier acts on.'],
  ['template', 'template', "The definition's body, without its common indentation; argument places are marked in it."],
  ['values', 'values', "The arguments, in order: their values, or their words for a definition that keeps them."],
  ['fill', 'fill(${1:template}, ${2:values})', 'fill(template, values): the template with each argument place filled in with its value, as text.'],
  ['body', 'body', "The template filled in with the values as text; the definition's value when a language's does ends, unless it gives back another."],
  ['as written', 'as written', "True when the definition keeps its arguments' words."],
  ['in place', 'in place', "True when the definition is an entry's does: it runs where the entry acts."],
  ['name', 'name', 'The name after a modifier.'],
  ['scope', 'scope', 'A list, empty at first, of the files or folders a statement makes read first for the rest of its does and the lines under it.'],
];
// What a hook cycle carries: self["cycle"][FIELD].
const CYCLE_FIELDS = [
  ['name', 'name', "The cycle: 'file', 'line', 'define', 'call', 'body' or 'scope'."],
  ['phase', 'phase', "The phase: 'start', 'body', 'end' or 'error'."],
  ['text', 'text', 'The text of the line or definition the cycle acts on.'],
  ['definition', 'definition', 'The definition the cycle acts on, when there is one.'],
  ['variable', 'variable', "On a define cycle for a name line, the name being defined; a definition line has 'definition' instead."],
  ['file', 'file', 'The file the cycle runs in.'],
  ['owner', 'owner', 'The entry whose hook is running: file/name, like local_time/timed.'],
  ['state', 'state', 'Scratch space for one hook to pass values from start to end: self["cycle"]["state"][owner].'],
  ['error', 'error', 'The exception in an error phase, then re-raised.'],
  ['depth', 'depth', 'How many calls of this cycle are open.'],
];

// Known values in a hook body, and what their fields are. `DEFINITION` is the
// definition from `self["cycle"]["definition"]`; its modes are what a compiled
// build keeps, so a library sets those rather than relying on a local function.
const PYTHON_OBJECTS = {
  ENTRY: ENTRY_FIELDS,
  CYCLE: CYCLE_FIELDS,
  DEFINITION: [
    ['visibility', 'visibility', "'everywhere' (the default) or 'file'. A compiled build restores `seen_by` from this, so set it as well as `seen_by`."],
    ['seen_by', 'seen_by', 'A function `file → bool`: whether a line read from `file` may use this definition. File-only visibility is `lambda file: file == DEFINITION.file`; set `visibility` too for compiled builds.'],
    ['pattern_mode', 'pattern_mode', "'readable' or 'regex'; a compiled build rebuilds `read_pattern` from this."],
    ['argument_mode', 'argument_mode', "'values', 'written' or 'kept'; a compiled build rebuilds `read_argument` from this."],
    ['source', 'source', 'The definition pattern as written, e.g. `A0 is A1`.'],
    ['language', 'language', "The body's language: `def`, `python`, `html`, ..."],
    ['file', 'file', 'The `.def` file it was written in, or None for a typed-in definition.'],
    ['flags', 'flags', 'Flags from the definition line, e.g. `{"written": None}`.'],
    ['body', 'body', 'The body lines, with arguments replaced by slots.'],
    ['patterns', 'patterns', 'The compiled regexes for its patterns.'],
    ['hooks', 'hooks', 'Hooks on this definition: cycle, phase, definition and owner.'],
    ['in_place', 'in_place', 'True for an entry’s `does`: it runs where the entry acts.'],
    ['indent', 'indent', 'The indent of the file where it was written, for its body.'],
    ['comment', 'comment', 'The comment marker of the file where it was written.'],
    ['python', 'python', 'True when its body language is Python.'],
    ['reads_values', 'reads_values', 'Whether its arguments are read as expressions, for their values.'],
    ['read_pattern', 'read_pattern', 'The function that reads a pattern; a compiled build rebuilds it from `pattern_mode`.'],
    ['read_argument', 'read_argument', 'The function that reads an argument; a compiled build rebuilds it from `argument_mode`.'],
    ['add_patterns', 'add_patterns(${1:source}, ${2:argument_name})', 'Adds another def line to this definition; stacked lines share one body.'],
    ['add_line', 'add_line(${1:line})', 'Adds a line to the definition body.'],
    ['matches', 'matches(${1:text})', 'Matches text against its patterns.'],
  ],
};

// The known field under the cursor in `DEFINITION.visibility` or `ENTRY["body"]`, or null.
function objectFieldAt(line, column) {
  for (const [name, fields] of Object.entries(PYTHON_OBJECTS)) {
    for (const [re, quoted] of [
      [new RegExp('\\b' + escapeRegex(name) + '\\s*\\.\\s*(\\w+)', 'g'), false],
      [new RegExp('\\b' + escapeRegex(name) + '\\s*\\[\\s*(["\'])([^"\']+)\\1\\s*\\]', 'g'), true],
    ]) {
      for (const m of line.matchAll(re)) {
        const field = m[quoted ? 2 : 1];
        const start = m.index + m[0].lastIndexOf(field);
        if (start <= column && column < start + field.length) {
          return { object: name, field, start, end: start + field.length,
            label: quoted ? `${name}["${field}"]` : `${name}.${field}`,
            documentation: (fields.find(f => f[0] === field) || [])[2] };
        }
      }
    }
  }
  return null;
}

// A field under the cursor in `self["entry"]["body"]` or `self["cycle"]["state"]`.
function selfFieldAt(line, column) {
  const re = /\bself\s*\[\s*(["'])([^"']+)\1\s*\]\s*\[\s*(["'])([^"']+)\3\s*\]/g;
  for (const m of line.matchAll(re)) {
    const object = m[2];
    const fields = object === 'entry' ? ENTRY_FIELDS : object === 'cycle' ? CYCLE_FIELDS : null;
    if (!fields) continue;
    const field = m[4];
    const second = m[0].indexOf('[', m[0].indexOf(']') + 1);
    const start = m.index + m[0].indexOf(field, second);
    if (start <= column && column < start + field.length) {
      return { object: `self["${object}"]`, field, start, end: start + field.length,
        label: `self["${object}"]["${field}"]`,
        documentation: (fields.find(f => f[0] === field) || [])[2] };
    }
  }
  return null;
}

// The bare `self` under the cursor in a Python body, before or after its keys.
function pythonSelfAt(line, column) {
  // `self` inside text is text, not the interpreter.
  let quote = null;
  for (let i = 0; i < column; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
  }
  if (quote) return null;
  for (const m of line.matchAll(/\bself\b/g)) {
    if (m.index <= column && column < m.index + m[0].length) {
      return { start: m.index, end: m.index + m[0].length };
    }
  }
  return null;
}

// The kernel key under the cursor in `self["KEY"]`, or null.
function selfKeyAt(line, column) {
  for (const m of line.matchAll(/\bself\[\s*(?:(['"])(\w+)\1|(\w+))/g)) {
    const key = m[2] || m[3];
    const start = m.index + m[0].indexOf(key);
    if (start <= column && column < start + key.length) return { key, start, end: start + key.length };
  }
  return null;
}

const PYTHON_HELPERS = [
  ['self', 'self', 'The interpreter: self.run, self.say, self.variables, ...'],
  ['number', 'number(${1:value})', 'The value as a number, or an error.'],
  ['parse_number', 'parse_number(${1:text})', 'The text as a number, or None.'],
  ['as_text', 'as_text(${1:value})', 'The value as text a person reads (what `say` prints).'],
  ['as_code', 'as_code(${1:value})', 'The value written as def-lang code, to put in text for self.run.'],
  ['Code', 'Code(${1:text})', 'Marks text as code, so another language puts it in without escaping it.'],
  ['DefException', 'DefException(${1:message})', 'Raise it to stop with a def-lang error.'],
];
// A language's `does` body works on self["entry"]; these replace the old BODY/VAR/fill
// names, which the interpreter no longer gives to a body.
const LANGUAGE_HELPERS = [
  ['self["entry"]', 'self["entry"]', 'What the definition acts on: its kind, definition, template, values, fill, body and flags.'],
  ['self["entry"]["definition"]', 'self["entry"]["definition"]', 'The definition whose body is running.'],
  ['self["entry"]["template"]', 'self["entry"]["template"]', "The definition's body, with argument places marked in it."],
  ['self["entry"]["values"]', 'self["entry"]["values"]', 'The argument values, in order (or their words for a def that keeps them).'],
  ['self["entry"]["fill"]', 'self["entry"]["fill"](${1:template}, ${2:values})', 'Fills the argument places in a template with values, as text.'],
  ['self["entry"]["body"]', 'self["entry"]["body"]', 'The template filled in with the values; the definition’s value unless its does gives another.'],
  ['self["entry"]["as written"]', 'self["entry"]["as written"]', "True when the definition keeps its arguments' words."],
  ['self["entry"]["in place"]', 'self["entry"]["in place"]', "True when an entry's does runs where it acts, in the caller's variables."],
];

const snippetText = text => text.replace(/[$}\\]/g, ch => '\\' + ch);

// A def's pattern as parts: [{ text } | { argument: 'A0' }], with `(A0: regex)` as A0.
function patternParts(pattern, argumentName = 'A') {
  const parts = [];
  const argument = new RegExp('\\(\\s*(' + escapeRegex(argumentName) + '\\d+)\\s*:|(' + escapeRegex(argumentName) + '\\d+)', 'g');
  let at = 0;
  let m;
  while ((m = argument.exec(pattern))) {
    if (m.index > at) parts.push({ text: pattern.slice(at, m.index) });
    parts.push({ argument: m[1] || m[2] });
    at = m.index + m[0].length;
    if (m[1]) { // skip the regex of a restricted argument, up to its closing bracket
      let depth = 1;
      while (at < pattern.length && depth) { if (pattern[at] === '(') depth++; else if (pattern[at] === ')') depth--; at++; }
    }
    argument.lastIndex = at;
  }
  if (at < pattern.length) parts.push({ text: pattern.slice(at) });
  return parts;
}

// The snippet for a def: { label, insert, filter, leading } — `leading` when it starts
// with an argument (`A0 is A1`): then only the rest is inserted, after what is typed.
function defSnippet(def) {
  const parts = patternParts(def.pattern, def.argumentName);
  const leading = parts.length > 0 && parts[0].argument !== undefined;
  const rest = leading ? parts.slice(1) : parts;
  let stop = 0;
  const insert = rest.map(p => p.argument !== undefined ? '${' + (++stop) + ':' + p.argument + '}' : snippetText(p.text)).join('').trim();
  const filter = rest.filter(p => p.text).map(p => p.text.trim()).join(' ').trim();
  return { label: def.pattern, insert, filter, leading };
}

// The .def files and libraries `use ` can name from `file`: ['bmi', 'def/bmi', 'core', 'web/server', ...].
function importNames(file) {
  const names = new Set();
  const here = path.dirname(file);
  const program = programFolder(file);
  const defsIn = (folder, depth, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth > 0 && !entry.name.startsWith('.') && entry.name !== 'libraries' && entry.name !== 'node_modules') defsIn(path.join(folder, entry.name), depth - 1, prefix + entry.name + '/');
      } else if (entry.name.endsWith('.def')) {
        const full = path.join(folder, entry.name);
        if (full !== file && entry.name !== 'main.def') names.add(prefix + entry.name.slice(0, -4));
      }
    }
  };
  defsIn(here, 0, '');
  defsIn(program, 3, '');
  const library = (name, folder) => {
    names.add(name);
    let files = [];
    try { files = fs.readdirSync(folder); } catch { return; }
    for (const f of files) if (f.endsWith('.def') && f !== 'main.def') names.add(name + '/' + f.slice(0, -4));
  };
  let copies = [];
  try { copies = fs.readdirSync(path.join(program, 'libraries')); } catch {}
  for (const name of copies) if (fs.existsSync(path.join(program, 'libraries', name, 'library.toml'))) library(name, path.join(program, 'libraries', name));
  for (const entry of listedLibraries(program)) {
    const folder = libraryFolder(program, entry.name);
    if (folder) library(entry.name, folder);
  }
  // a library's file can use the libraries next to its own
  if (fs.existsSync(path.join(here, 'library.toml'))) {
    for (const name of fs.readdirSync(path.dirname(here))) {
      const folder = path.join(path.dirname(here), name);
      if (folder !== here && fs.existsSync(path.join(folder, 'library.toml'))) library(name, folder);
    }
  }
  return [...names].sort();
}

// The def or entry field whose body holds `line` (Python or def-lang), or null.
function bodyOwner(index, line) {
  if (index.entryBodies && index.entryBodies.has(line)) return index.entryBodies.get(line);
  let n = line;
  while (n > 0 && (/^\s/.test(index.lines[n]) || !index.lines[n].trim())) n--;
  if (n === line) return null;
  if (/^language\s/.test(index.lines[n])) return { language: true };
  return index.defs.find(d => d.line === n && !d.alias) || null;
}

// The language of the body that line `n` is in, when it is another language than
// def-lang (html, css, javascript, python, ...); else null.
function bodyLanguageAt(index, n) {
  if (!index.pythonLines.has(n)) return null;
  const owner = bodyOwner(index, n);
  if (!owner) return null;
  return owner.language === true ? 'python' : owner.language || null;
}

// What to suggest at `column` of line `n`: [{ label, kind, insert, filter, detail, documentation, sort }].
// kind: statement | phrase | follow | variable | flag | language | import | python.
function completionsAt(index, n, column, indexes, languages = new Set(['python'])) {
  const line = index.lines[n] || '';
  const before = line.slice(0, column);
  const items = [];
  // where the inserted text starts: the earliest word on the line from which what is
  // typed is the start of the suggestion (`sum o` for `sum of A0`), else the cursor
  const startOf = filter => {
    const lower = filter.toLowerCase();
    for (let s = 0; s < before.length; s++) {
      if (s > 0 && !/\s/.test(before[s - 1])) continue;
      const piece = before.slice(s).toLowerCase();
      if (piece.trim() && !/^\s/.test(piece) && lower.startsWith(piece)) return s;
    }
    return column;
  };
  const add = (kind, label, insert, documentation = '', more = {}) => {
    const filter = more.filter || label;
    const start = more.start ?? (kind === 'python' || (kind === 'variable' && index.pythonLines.has(n)) ? before.search(/\w*$/) : startOf(filter));
    items.push({ kind, label, insert, filter, start, detail: more.detail || '', documentation, sort: more.sort || '5' });
  };

  // a Python body (or a `language` runner)
  if (index.pythonLines.has(n)) {
    const owner = bodyOwner(index, n);
    // an HTML, CSS, JavaScript ... body: that language's own editor support, not ours
    if (owner && owner.language !== true && owner.language !== 'python') return [];
    // fields of a known value in a hook, e.g. `DEFINITION.visibility`
    const member = /\b(\w+)\s*\.\s*\w*$/.exec(before);
    const fields = member && PYTHON_OBJECTS[member[1]];
    if (fields) {
      const start = before.search(/\w*$/);
      for (const [label, insert, doc] of fields) add('python', label, insert, doc, { sort: '0', start });
      return items;
    }
    // `self["entry"]["FIELD"]` / `self["cycle"]["FIELD"]`, or `ENTRY["FIELD"]`
    const nested = /\bself\s*\[\s*(['"])(entry|cycle)\1\s*\]\s*\[\s*(['"]?[^'"\]]*)$/.exec(before);
    const bracket = nested || /\b(\w+)\s*\[\s*(['"]?[^'"\]]*)$/.exec(before);
    if (bracket) {
      const object = nested ? nested[2] : bracket[1];
      const fields = nested ? (object === 'entry' ? ENTRY_FIELDS : CYCLE_FIELDS)
        : Object.prototype.hasOwnProperty.call(PYTHON_OBJECTS, object) ? PYTHON_OBJECTS[object] : null;
      if (fields) {
        const quote = (nested ? nested[3] : bracket[2]) || '';
        const after = line.slice(column);
        const keyStart = column - (/[^'"\]\s]*$/.exec(before)?.[0].length || 0);
        for (const [label, , doc] of fields) {
          let insert = quote ? label + quote : `"${label}"`;
          if (!/^\s*(?:['"])?\s*\]/.test(after)) insert += ']';
          add('python', label, insert, doc, { sort: '0', start: keyStart });
        }
        return items;
      }
    }
    // `self["KEY"]`: the kernel's tree (entry bodies use these more than methods)
    if (/\bself\[\s*(?:['"]?\w*)$/.test(before)) {
      const quote = /self\[\s*(['"])/.exec(before)?.[1] || '';
      const after = line.slice(column);
      const keyStart = column - (/\w*$/.exec(before)?.[0].length || 0);
      for (const [label, doc] of PYTHON_KERNEL) {
        let insert = quote ? label + quote : `"${label}"`;
        if (!/^\s*(?:['"])?\s*\]/.test(after)) insert += ']';
        add('python', label, insert, doc, { sort: '0', start: keyStart });
      }
      return items;
    }
    if (/\bself\.\w*$/.test(before)) {
      for (const [label, insert, doc] of PYTHON_SELF) add('python', label, insert, doc);
      return items;
    }
    // an open text has no def-lang completions; a finished ["key"] does
    if ((before.match(/"/g) || []).length % 2 || (before.match(/'/g) || []).length % 2) return [];
    for (const [label, insert, doc] of PYTHON_HELPERS) add('python', label, insert, doc);
    if (owner && owner.language === true) for (const [label, insert, doc] of LANGUAGE_HELPERS) add('python', label, insert, doc);
    else if (owner) for (const p of patternParts(owner.pattern, owner.argumentName)) if (p.argument) add('variable', p.argument, p.argument, 'An argument of this def: its value' + (owner.flags.has('as written') ? ', as written (its words)' : ''), { sort: '0' });
    return items;
  }
  if (index.htmlLines.has(n) || isComment(index, n)) return [];
  if ((maskStrings(before).match(/"/g) || []).length % 2) return []; // inside text

  const text = before.trimStart();
  let m;
  if ((m = /^def\s+((?:(?:as\s+written|regex|\w+)\s+)*)\w*$/.exec(text)) && [...m[1].trim().split(/\s+/)].every(w => !w || w === 'as' || w === 'written' || w === 'regex' || languages.has(w))) {
    const used = m[1];
    if (!/as\s+written/.test(used)) add('flag', 'as written', 'as written ', FLAG_HELP['as written'], { sort: '0' });
    if (!/\bregex\b/.test(used)) add('flag', 'regex', 'regex ', FLAG_HELP.regex, { sort: '1' });
    if (!used.split(/\s+/).some(w => languages.has(w))) for (const name of languages) add('language', name, name + ' ', `The body is written in ${name}.`, { sort: '2' });
    return items;
  }
  if (/^def\s/.test(text)) return [];
  // the body language of an entry, or of one of its hooks: every declared language
  if (/^does\s+in\s+\w*$/.test(text) || /^hook\s+(?:\w+\s+){2}in\s+\w*$/.test(text)) {
    const start = before.length - text.length + text.search(/\w*$/);
    for (const name of languages) add('language', name, name, `The body is written in ${name}.`, { sort: '2', start });
    return items;
  }
  if (/^use\s+\S*$/.test(text) || /^use\s+.+\s+from\s+\S*$/.test(text)) {
    for (const name of importNames(index.file)) add('import', name, name, '', { detail: 'use' });
    return items;
  }

  const visible = visibleIndexes(index.file, indexes);
  const words = text.split(/\s+/);
  const first = !/\s/.test(text); // still on the line's first word
  if (first && !/^\s/.test(line)) {
    for (const [label, insert, doc] of STATEMENTS) add('statement', label, insert, doc, { sort: '1' });
  }
  const seen = new Set();
  for (const other of visible) {
    for (const def of other.defs) {
      if (def.keywords === 0 || (def.flags && def.flags.has('regex'))) continue;
      const snippet = def.alias ? { label: def.pattern, insert: snippetText(def.pattern), filter: def.pattern, leading: false } : defSnippet(def);
      if (!snippet.filter || seen.has(snippet.label)) continue;
      // `A0 is A1`: only after something is typed
      if (snippet.leading && (words.length < 2 || !text.slice(0, text.lastIndexOf(words[words.length - 1])).trim())) continue;
      seen.add(snippet.label);
      const description = splitDescription(descriptionOf(other, def.line));
      let doc = description.text;
      if (description.examples.length) doc += '\n\n' + description.examples.map(e => '`' + e.input + '`' + (e.result ? ' → `' + e.result + '`' : '')).join('  \n');
      add(snippet.leading ? 'follow' : 'phrase', snippet.label, snippet.insert, doc.trim(),
        { filter: snippet.filter, detail: path.basename(other.file) + (def.alias ? ' (means)' : ''), sort: snippet.leading ? '1' : '2' });
    }
  }
  for (const name of variableNames(visible)) add('variable', name, name, 'A variable of the program.', { sort: '0' });
  return items;
}

// ---- formatting (Format Document): layout only, never what a line means

// Spaces between words collapse to one, outside quoted text.
function collapseSpaces(content) {
  let out = '', inText = false, space = false;
  for (const ch of content) {
    if (ch === '"') inText = !inText;
    if (!inText && (ch === ' ' || ch === '\t')) { space = true; continue; }
    if (space && out) out += ' ';
    space = false;
    out += ch;
  }
  return out;
}

// The formatted text of a .def file. What it changes, and why it is safe:
// - tabs at the start of a line become `indent` spaces (a tab is one level, as in the engine);
// - in a def-lang line, runs of spaces between words become one, outside "text"
//   (patterns read words split by spaces; def lines keep their spaces: a regex may need them);
// - a body in another language (Python, HTML, ...) moves as a whole to one level under
//   its def, keeping its own layout (the engine strips a body's common indentation),
//   or formatted by that language's formatter (formatTextWith);
// - trailing spaces go, empty lines collapse to one, and the file ends with one newline.
// A line whose width isn't a whole number of levels is left as it is (the engine says why).
function formatText(text, languages = new Set(['python'])) {
  return render(formatParts(text, languages), new Map());
}

// The same, with each body in another language given to formatBody(language, text, indent),
// which returns its formatted text (from column 0), or null to keep it as it is.
async function formatTextWith(text, languages, formatBody) {
  const parts = formatParts(text, languages);
  const formatted = new Map();
  for (const [i, part] of parts.entries()) {
    if (!part.body) continue;
    try {
      const done = await formatBody(part.language, bodyText(part), part.indent);
      if (typeof done === 'string' && done.trim()) formatted.set(i, done);
    } catch {} // a formatter that fails leaves its body as it was
  }
  return render(parts, formatted);
}

// A file as parts: { line } (already formatted), or { body, language, indent } (a body in
// another language, its lines as they are).
function formatParts(text, languages) {
  const lines = text.split(/\r?\n/);
  const parts = [];
  let indent = 4;
  let comment = '//';
  let body = null;
  let bodyLanguage = null; // after a def or language line: the language of its body, or null (def-lang)
  const lead = line => line.slice(0, line.length - line.trimStart().length);
  const width = line => [...lead(line)].reduce((n, c) => n + (c === '\t' ? indent : 1), 0);
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const indented = /^\s/.test(line);
    if (body) {
      if (!line || indented) { body.body.push(line); continue; }
      parts.push(body);
      body = null;
    }
    if (!line) { parts.push({ line: '' }); continue; }
    const content = line.trim();
    if (indented && bodyLanguage) { body = { body: [line], language: bodyLanguage, indent }; continue; }
    if (!indented) {
      bodyLanguage = null;
      let m;
      if ((m = /^def\s+(.*)$/.exec(content))) {
        let rest = m[1], f;
        for (;;) {
          if ((f = FLAG.exec(rest))) rest = rest.slice(f[0].length);
          else if (!bodyLanguage && (f = /^(\w+)\s+/.exec(rest)) && languages.has(f[1])) { bodyLanguage = f[1]; rest = rest.slice(f[0].length); }
          else break;
        }
        parts.push({ line: content });
        continue;
      }
      if (LANGUAGE_LINE.test(content)) { bodyLanguage = 'python'; parts.push({ line: content }); continue; }
      if ((m = /^comment\s+is\s+(.+)$/.exec(content))) comment = m[1].trim();
      if ((m = /^indent\s+(\d+)$/.exec(content)) && Number(m[1]) > 0) indent = Number(m[1]);
    }
    if (width(line) % indent) { parts.push({ line }); continue; } // not a whole level: as it is
    const shown = content.startsWith(comment) ? content : collapseSpaces(content);
    parts.push({ line: ' '.repeat(width(line)) + shown });
  }
  if (body) parts.push(body);
  return parts;
}

// A body's own text: its lines without their common indentation (tabs as spaces).
function bodyText(part) {
  const expand = line => line.replace(/^\s+/, lead => lead.replace(/\t/g, ' '.repeat(part.indent)));
  const lines = part.body.map(expand);
  const filled = lines.filter(l => l.trim());
  const least = Math.min(...filled.map(l => l.length - l.trimStart().length));
  return lines.map(l => (l.trim() ? l.slice(least) : '')).join('\n').replace(/\n+$/, '') + '\n';
}

function render(parts, formatted) {
  const out = [];
  for (const [i, part] of parts.entries()) {
    if (!part.body) {
      if (part.line === '' && (!out.length || out[out.length - 1] === '')) continue;
      out.push(part.line);
      continue;
    }
    const text = formatted.has(i) ? formatted.get(i) : bodyText(part);
    let empty = false;
    for (const line of text.replace(/\s+$/, '').split('\n')) {
      if (!line.trim()) { empty = true; continue; }
      if (empty && out[out.length - 1] !== '') out.push('');
      empty = false;
      out.push(' '.repeat(part.indent) + line.replace(/\s+$/, ''));
    }
    // the empty lines after a body, before the next line
    if (part.body.length && !part.body[part.body.length - 1].trim()) out.push('');
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  while (out.length && out[0] === '') out.shift();
  return out.join('\n') + '\n';
}

module.exports = {
  FLAG_HELP, flagAt, KEY_HELP, keyAt, KERNEL_HELP, selfKeyAt, selfFieldAt, pythonSelfAt, PYTHON_OBJECTS, objectFieldAt, flagWarnings, wrapsOnLine,
  indexText, findDefinitions, findEntry, findVariable, findLinks, sourceOf, headerOf, descriptionOf, splitDescription, readableToRegex,
  packageFolder, programFolder, libraryFolder, linkedFolders, listedLibraries, globalFolder, resolveImport, visibleIndexes, templateExpressionAt, wordAt, phrasesIn, defOrder, orderStarts, structureAt,
  completionsAt, defSnippet, patternParts, importNames, formatText, formatTextWith, bodyLanguageAt,
  variableNames, variablesIn, languageNames, findLanguage, isComment, apiRoutes, viewPaths, htmlReferenceAt, resolveHtmlReference,
};
