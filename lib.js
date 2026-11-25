// Reading .def files: definitions, phrases, variables, libraries. No VS Code here;
// extension.js connects it to the editor.
'use strict';
const fs = require('fs');
const path = require('path');

// The kernel (deflang/kernel.py): the interpreter has only `python` and `use` built in.
// Everything else is declared, each kind the same way (`language css`, `modifier shared`,
// ...), and the editor learns it from the declarations, like the interpreter.
const KINDS = ['language', 'flag', 'modifier', 'statement'];
const BUILT_IN = { languages: ['python'], flags: [], modifiers: [], statements: ['use'] };
const ENTRY_LINE = /^(language|flag|modifier|statement)\s+([\w-]+)\s*$/;
// an entry's field, one level in (`does in LANGUAGE` and `replaces` are every kind's)
const FIELDS = {
  language: ['does', 'editor', 'replaces'], flag: ['does', 'words', 'replaces'],
  modifier: ['does', 'replaces'], statement: ['does', 'words', 'replaces'],
};
const FIELD_LINE = /^\s+(does|words|editor|replaces)(?:\s+(.*?))?\s*$/;
// the language of a `does in LANGUAGE` field's value, or null
const doesLanguage = value => ((/^in\s+(\w+)(?:\[[^\]]*\])?$/.exec(value || '') || [])[1]) || null;

// The kernel as the editor knows it: the built-in entries, those of `base`, and what
// these texts declare, read from the declarations themselves (nothing about a library
// is written here):
//   languages, flags, modifiers, statements   the entries' names (Sets)
//   editors           a language -> its `editor` field (VS Code's language id)
//   wordsFlags        the flags that keep a definition's arguments' words (and
//                     wordsModifiers, the modifiers that do)
//   regexFlags        the flags that read a pattern as a raw regex (regexModifiers)
//   hidingFlags       the flags that let only a definition's own file see it (hidingModifiers)
//   statementEffects  the statements that set the file's comment marker, argument name
//                     or indent, or the scope of the lines under them: { words, effects:
//                     { comment: N, ... } } (from their `does`)
//   variableMakers    the definitions that give a variable its value: their argument N
//                     names it (from their Python, like `def-lang check`)
//   aliasMakers       the definitions that make an alias (`X means Y`)
//   fixedVariables    variables a definition sets by name (`them`, `it`)
function kernelNames(texts, base = null) {
  const kernel = {
    editors: new Map(base ? base.editors : []),
    wordsFlags: new Set(base ? base.wordsFlags : []), regexFlags: new Set(base ? base.regexFlags : []),
    hidingFlags: new Set(base ? base.hidingFlags : []), wordsModifiers: new Set(base ? base.wordsModifiers : []),
    regexModifiers: new Set(base ? base.regexModifiers : []), hidingModifiers: new Set(base ? base.hidingModifiers : []),
    statementEffects: base ? [...base.statementEffects] : [],
    variableMakers: base ? [...base.variableMakers] : [], aliasMakers: base ? [...base.aliasMakers] : [],
    fixedVariables: new Set(base ? base.fixedVariables : []),
  };
  for (const kind of KINDS) kernel[kind + 's'] = new Set(base ? base[kind + 's'] : BUILT_IN[kind + 's']);
  const all = [...texts];
  for (const text of all) readEntries(text, kernel);
  for (const text of all) readMakers(text, kernel);
  return kernel;
}

// The entries of a text: their names and editors, and what their `does` sets.
function readEntries(text, kernel) {
  let entry = null;
  let does = null;
  const width = line => line.length - line.trimStart().length;
  const finish = () => {
    if (!entry) return;
    const body = entry.body.join('\n');
    if (entry.kind === 'flag' || entry.kind === 'modifier') {
      const kind = entry.kind === 'flag' ? 'Flags' : 'Modifiers';
      // its arguments are words: as written, or lines kept to run later (`set arguments to kept`)
      if (/set\s+arguments\s+to\s+(?:as\s+written|kept)|\.read_argument\s*=\s*lambda\s+(\w+)\s*,\s*\w+\s*:\s*(?:Line\(\s*)?\1\b/.test(body)) kernel['words' + kind].add(entry.name);
      if (/set\s+pattern\s+to\s+regex|\.read_pattern\s*=/.test(body)) kernel['regex' + kind].add(entry.name);
      if (/set\s+seen\s+by\s+to\s+the\s+file|\.seen_by\s*=/.test(body)) kernel['hiding' + kind].add(entry.name);
    }
    if (entry.kind === 'statement' && entry.words) {
      const effects = {};
      const names = { 'comment marker': 'comment', 'argument name': 'argument', 'indent': 'indent', 'scope': 'scope' };
      for (const m of body.matchAll(/set\s+(comment\s+marker|argument\s+name|indent|scope)\s+to\s+[\p{L}_]+?(\d+)/gu)) effects[names[m[1].split(/\s+/).join(' ')]] = Number(m[2]);
      for (const m of body.matchAll(/\[\s*["'](comment|argument|indent)["']\s*\]\s*=\s*(?:int\(\s*)?a\[(\d+)\]/g)) effects[m[1]] = Number(m[2]);
      if (Object.keys(effects).length) kernel.statementEffects.push({ name: entry.name, words: entry.words, effects });
    }
  };
  for (const line of text.split(/\r?\n/)) {
    let m;
    if ((m = ENTRY_LINE.exec(line))) {
      finish();
      entry = { kind: m[1], name: m[2], body: [], words: null };
      does = null;
      kernel[m[1] + 's'].add(m[2]);
      continue;
    }
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) { finish(); entry = null; continue; }
    if (!entry) continue;
    if (does !== null && width(line) > does) { entry.body.push(line); continue; }
    does = null;
    if (entry.kind === 'language' && (m = /^\s+editor\s+(\S+)\s*$/.exec(line))) kernel.editors.set(entry.name, m[1]);
    if ((m = /^\s+words\s+(.+?)\s*$/.exec(line))) entry.words = m[1];
    if (/^\s+does\b/.test(line)) does = width(line);
  }
  finish();
}

// The definitions of a text that make variables or aliases: their Python stores into
// self["variables"][...] or self["aliases"][...] with an argument (like `check`).
function readMakers(text, kernel) {
  const lines = text.split(/\r?\n/);
  let argumentName = 'A';
  for (let n = 0; n < lines.length; n++) {
    const effect = statementEffect(lines[n], kernel);
    if (effect && effect.argument) argumentName = effect.argument;
    const first = definitionLine(lines[n], kernel);
    if (!first) continue;
    const group = [first];
    while (n + 1 < lines.length && definitionLine(lines[n + 1], kernel)) group.push(definitionLine(lines[++n], kernel));
    const body = [];
    while (n + 1 < lines.length && (/^\s/.test(lines[n + 1]) || !lines[n + 1].trim())) body.push(lines[++n]);
    if (first.language !== 'python') continue;
    const code = body.join('\n');
    const argument = new RegExp('(?<![\\p{L}\\p{N}_])' + escapeRegex(argumentName) + '(\\d+)(?![\\p{L}\\p{N}_])', 'gu');
    const used = (pattern) => [...code.matchAll(pattern)].flatMap(m => [...m[1].matchAll(argument)].map(a => Number(a[1])));
    const variables = used(/self\[\s*["']variables["']\s*\]\s*(?:\[|\.setdefault\(|\.get\()([^\]\),]*)/g);
    const aliases = used(/self\[\s*["']aliases["']\s*\]\s*\[([^\]]*)\]/g);
    for (const m of code.matchAll(/self\[\s*["']variables["']\s*\]\s*\[\s*["']([\p{L}\p{N}_]+)["']\s*\]/gu)) kernel.fixedVariables.add(m[1]);
    if (!variables.length && !aliases.length) continue;
    const regex = group[0].flags.some(f => kernel.regexFlags.has(f.name));
    for (const line of group) {
      for (const one of regex ? line.pattern.split(' or ') : [line.pattern]) {
        const made = compile(regex ? rawRegex(one.trim(), argumentName) : readableToRegex(one.trim(), argumentName));
        if (!made) continue;
        if (variables.length) kernel.variableMakers.push({ ...made, args: [...new Set(variables)] });
        if (aliases.length) kernel.aliasMakers.push({ ...made, args: [...new Set(aliases)] });
      }
    }
  }
}

// What a statement line sets for its file, by the statements' `does` (kernel.statementEffects):
// { comment, argument, indent, scope } (the words in those places, and where they are, in
// `at`), or null if it is no such line. Only a scope may be set by an indented line.
function statementEffect(line, kernel, indented = false) {
  if (!kernel.statementEffects || !line.trim() || (!indented && /^\s/.test(line))) return null;
  const masked = maskStrings(line);
  for (const statement of kernel.statementEffects) {
    if (statement.regex === undefined) {
      const made = readableToRegex(statement.words, 'A');
      statement.regex = made ? new RegExp('^\\s*(?:' + made.source + ')\\s*$', 'du') : null;
    }
    const m = statement.regex && statement.regex.exec(masked);
    if (!m) continue;
    const found = {};
    Object.defineProperty(found, 'at', { value: {} });
    for (const [effect, n] of Object.entries(statement.effects)) {
      const span = m.indices.groups && m.indices.groups['a' + n];
      if (span) { found[effect] = line.slice(span[0], span[1]).trim(); found.at[effect] = span; }
    }
    if (indented && /^\s/.test(line) && !found.scope) return null;
    return found;
  }
  return null;
}

// The words in argument N's place, for each match of `def` on a line: ['x', ...].
function argumentTexts(line, def, n) {
  const found = [];
  for (const m of matches(maskStrings(line), def)) {
    const span = m.indices.groups && m.indices.groups['a' + n];
    if (span && !found.includes(line.slice(span[0], span[1]).trim())) found.push(line.slice(span[0], span[1]).trim());
  }
  return found;
}

// Whether a language's bodies are def-lang lines: one without an `editor` (like `def`);
// `python` and a language with an editor (html, css, ...) have bodies of their own.
function isDefLanguage(name, kernel) {
  return !!name && name !== 'python' && !kernel.editors.has(name);
}

// The spans of a match's fixed words (its groups k0, k1, ...), in order.
function keywordSpans(m) {
  return Object.entries(m.indices.groups || {}).filter(([name, span]) => name[0] === 'k' && span).map(([, span]) => span).sort((a, b) => a[0] - b[0]);
}

// A definition line, `[modifiers] language[flags] pattern`, like the engine reads it:
// { modifiers: [{ name, start }], language, languageStart, flags: [{ name, value, start, end }],
// pattern, patternStart }, or null. The pattern comes after a space, so a `[` there is
// the pattern's (`def [ A0 ] first`).
function definitionLine(line, kernel = kernelNames([])) {
  if (/^\s/.test(line)) return null;
  const modifiers = [];
  let at = 0;
  let m;
  while ((m = /^([\w-]+)\s+/.exec(line.slice(at))) && kernel.modifiers.has(m[1])) {
    modifiers.push({ name: m[1], start: at });
    at += m[0].length;
  }
  if (!(m = /^(\w+)(\[[^\]]*\])?(\s+)(\S.*)$/.exec(line.slice(at))) || !kernel.languages.has(m[1])) return null;
  const flags = [];
  if (m[2]) {
    let p = at + m[1].length + 1;
    for (const piece of m[2].slice(1, -1).split(',')) {
      const words = piece.trim().split(/\s+/);
      const start = p + piece.length - piece.trimStart().length;
      if (words[0]) flags.push({ name: words[0], value: words.slice(1).join(' ') || null, start, end: start + words[0].length });
      p += piece.length + 1;
    }
  }
  const patternStart = at + m[1].length + (m[2] || '').length + m[3].length;
  return { modifiers, language: m[1], languageStart: at, flags, pattern: m[4].trimEnd(), patternStart };
}

// The kernel word under `column` at the start of a line: a modifier (`internal`,
// `shared`), a definition's language (`css`) or one of its flags (`written`), or the
// language of an entry's `does in LANGUAGE`:
// { kind, name, start, end }, or null.
function kernelWordAt(line, column, kernel) {
  return kernelWordsIn(line, kernel).find(w => w.start <= column && column < w.end) || null;
}

// Every kernel word of a line, as kernelWordAt finds them: [{ kind, name, start, end }].
function kernelWordsIn(line, kernel) {
  const words = [];
  // an entry's `does in LANGUAGE[FLAGS]`: that language, and its flags
  const does = /^(\s+does\s+in\s+)(\w+)(\[[^\]]*\])?\s*$/.exec(line);
  if (does) {
    const start = does[1].length;
    words.push({ kind: 'language', name: does[2], start, end: start + does[2].length });
    let at = start + does[2].length + 1;
    for (const piece of (does[3] || '[]').slice(1, -1).split(',')) {
      const first = piece.trim().split(/\s+/)[0];
      const from = at + piece.length - piece.trimStart().length;
      if (first) words.push({ kind: 'flag', name: first, start: from, end: from + first.length });
      at += piece.length + 1;
    }
    return words;
  }
  const definition = definitionLine(line, kernel);
  if (definition) {
    for (const m of definition.modifiers) words.push({ kind: 'modifier', name: m.name, start: m.start, end: m.start + m.name.length });
    words.push({ kind: 'language', name: definition.language, start: definition.languageStart, end: definition.languageStart + definition.language.length });
    for (const f of definition.flags) words.push({ kind: 'flag', name: f.name, start: f.start, end: f.end });
  } else {
    let at = 0;
    let m;
    while ((m = /^([\w-]+)\s+/.exec(line.slice(at))) && kernel.modifiers.has(m[1])) {
      words.push({ kind: 'modifier', name: m[1], start: at, end: at + m[1].length });
      at += m[0].length;
    }
  }
  return words;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
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
  const tokens = []; // [isSymbol, regex, isArgument, kind]
  const fixed = [];   // the fixed words as they are written: a line without one of them can't match
  let keywords = 0;
  let pos = 0;
  // each argument's place is a group, a0, a1, ... (the first time it appears)
  const named = new Set();
  const group = (number, regex) => (named.has(number) ? regex : (named.add(number), '(?<a' + number + '>' + regex + ')'));
  while (pos < text.length) {
    if (/\s/.test(text[pos])) { pos++; continue; }
    const m = restricted.exec(text.slice(pos));
    if (m) {
      const end = closingParen(text, pos + m[0].length);
      if (end < 0) return null;
      const number = /\d+/.exec(m[0])[0];
      tokens.push([false, group(number, '(?:' + text.slice(pos + m[0].length, end).trim() + ')'), true, 'restricted']);
      pos = end + 1;
      continue;
    }
    let end = pos;
    while (end < text.length && !/\s/.test(text[end])) end++;
    let word = text.slice(pos, end);
    pos = end;
    // an argument with a symbol right after it, like `A1,` in `A0 and A1, as A2`: the symbol is the next word
    const trailing = new RegExp('^(' + escapeRegex(argumentName) + '\\d+)([^\\p{L}\\p{N}_\\s"]+)$', 'u').exec(word);
    if (trailing) { word = trailing[1]; pos = end - trailing[2].length; }
    if (argument.test(word)) tokens.push([false, group(/\d+$/.exec(word)[0], '[\\s\\S]+'), true, 'any']);
    // "A0": a text stands there (strings are masked as \u0001)
    else if (word.length > 2 && word[0] === '"' && word[word.length - 1] === '"' && argument.test(word.slice(1, -1))) tokens.push([true, group(/\d+(?="$)/.exec(word)[0], '\u0001+'), true, 'text']);
    else {
      // a fixed word only matches a whole word, like the engine reads it: `place` not inside `places`
      const letter = /[\p{L}\p{N}_]/u;
      const before = letter.test(word[0]) ? '(?<![\\p{L}\\p{N}_])' : '';
      const after = letter.test(word[word.length - 1]) ? '(?![\\p{L}\\p{N}_])' : '';
      tokens.push([!letter.test(word), before + '(?<k' + keywords++ + '>' + escapeRegex(word) + ')' + after, false]);
      fixed.push(word);
    }
  }
  let source = '';
  tokens.forEach(([isSymbol, part], i) => {
    if (i) source += (isSymbol || tokens[i - 1][0]) ? '\\s*' : '\\s+';
    source += part;
  });
  // only arguments and texts (like joined text, `A0 "A1"`): no words to show
  if (!source || tokens.every(([, , , kind]) => kind === 'any' || kind === 'text')) return null;
  const isArgument = token => token[2];
  const edges = { leadingArgument: isArgument(tokens[0]), trailingArgument: isArgument(tokens[tokens.length - 1]) };
  // no fixed words at all (like the number-words def): the whole match counts, as whole words only,
  // so `ten` isn't found inside `written`
  return keywords ? { source, keywords, words: fixed, ...edges }
    : { source: '(?<![\\p{L}\\p{N}_])(?<k0>' + source + ')(?![\\p{L}\\p{N}_])', keywords: 0 };
}

// `def regex ...`: every plain group is a fixed word
function rawRegex(text, argumentName) {
  let keywords = 0;
  const named = new Set();
  const group = number => (named.has(number) ? '(?:' : (named.add(number), '(?<a' + number + '>'));
  let source = text
    .replace(new RegExp('\\(' + escapeRegex(argumentName) + '(\\d+):\\s*', 'g'), (all, number) => group(number))
    .replace(new RegExp(escapeRegex(argumentName) + '(\\d+)', 'g'), (all, number) => group(number) + '[\\s\\S]+)')
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

// Everything a file defines: def lines, `X means Y` lines, and which lines are Python.
function indexText(file, text, kernel = kernelNames([text])) {
  const defs = [];
  const lines = text.split(/\r?\n/);
  let argumentName = 'A';
  // `comment is X` makes X the comment marker from that line to the end of the file,
  // like the engine; each file starts with //
  let comment = '//';
  const commentLines = new Map(); // comment line -> its marker
  let inPython = false;
  let inHtml = null;           // the definition line of the HTML body being read
  const pythonLines = new Set(); // lines in another language: Python or HTML bodies, an entry's `does`
  const htmlLines = new Map();   // HTML body line -> its definition line
  const languageLines = [];      // { name, line } of each `language NAME`
  const entries = [];            // { kind, name, line, fields: { field: { value, line } } } of each entry
  const entryLines = new Set();  // the indented lines of the entries: their fields and their `does`
  const definitionLines = new Set(); // the lines `[modifiers] language[flags] pattern`
  const aliasLines = new Set();      // the lines that make an alias (`X means Y`)
  const doesLines = new Set();       // the def-lang lines of an entry's `does in def`
  const sequence = []; // ['import', file] (a `use` line) and ['def', group] in file order, for defOrder()
  let group = null;    // first line of the definition group being written, until its body starts
  let entry = null;    // the entry whose fields are being read
  let does = null;     // the width of its `does in LANGUAGE` line, while its body is read
  const width = line => line.length - line.trimStart().length;
  lines.forEach((line, number) => {
    if (entry && /^\s/.test(line) && line.trim()) {
      if (does !== null && width(line) > does) {
        // `does in def`: def-lang lines (phrases); another language: its lines
        if (!entry.defLang) { entryLines.add(number); pythonLines.add(number); }
        else if (line.trim().startsWith(comment)) commentLines.set(number, comment);
        else doesLines.add(number);
        return;
      }
      entryLines.add(number);
      does = null;
      let f;
      if (line.trim().startsWith(comment)) commentLines.set(number, comment);
      else if ((f = FIELD_LINE.exec(line))) {
        const field = f[1].split(/\s+/).join(' ');
        entry.fields[field] = { value: f[2] || '', line: number };
        if (field === 'does') { does = width(line); entry.does = doesLanguage(f[2]); entry.defLang = isDefLanguage(entry.does, kernel); }
        // a statement's words are found like a def's pattern, and lead to the entry
        if (field === 'words' && entry.kind === 'statement' && f[2]) {
          const pattern = compile(readableToRegex(f[2], argumentName));
          if (pattern) defs.push({ file, line: entry.line, text: line.trim(), pattern: f[2], argumentName, statement: entry.name, flags: new Set(), keepsWords: true, language: null, ...pattern });
        }
      }
      return;
    }
    if (/^\s/.test(line) && line.trim()) {
      if (inPython) pythonLines.add(number);
      if (inHtml !== null) htmlLines.set(number, inHtml);
      // like the engine: an indented comment is a comment, except inside a Python/HTML body
      else if (!inPython && line.trim().startsWith(comment)) commentLines.set(number, comment);
      group = null;
      return;
    }
    if (!line.trim()) return;
    if (line.trim().startsWith(comment)) { commentLines.set(number, comment); return; }
    inPython = false;
    inHtml = null;
    entry = null;
    does = null;
    let m;
    const definition = definitionLine(line, kernel);
    if (!definition) group = null;
    // `use FILE`, or `use NAMES from FILE`: either way FILE runs
    if ((m = /^use\s+(.+?)\s*$/.exec(line))) { const from = /\s+from\s+(\S+)$/.exec(m[1]); sequence.push(['import', from ? from[1] : m[1]]); return; }
    // an entry: `language css`, `modifier shared`, ...; its fields follow, one level in
    if ((m = ENTRY_LINE.exec(line))) {
      entry = { kind: m[1], name: m[2], line: number, fields: {}, does: null };
      entries.push(entry);
      if (m[1] === 'language') languageLines.push({ name: m[2], line: number });
      return;
    }
    // a statement that sets the file's comment marker or argument name (by its `does`)
    const effect = statementEffect(line, kernel);
    if (effect) {
      if (effect.argument) argumentName = effect.argument;
      if (effect.comment) comment = effect.comment;
      return;
    }
    if (definition) {
      definitionLines.add(number);
      const flags = new Set(definition.flags.map(f => f.name));
      // a language without an editor (like `def`) has def-lang bodies; python and the others don't
      const language = isDefLanguage(definition.language, kernel) ? null : definition.language;
      const modifiers = definition.modifiers.map(x => x.name);
      const rawPattern = [...flags].some(f => kernel.regexFlags.has(f)) || modifiers.some(x => kernel.regexModifiers.has(x));
      const keepsWords = [...flags].some(f => kernel.wordsFlags.has(f)) || modifiers.some(x => kernel.wordsModifiers.has(x));
      const internal = [...flags].some(f => kernel.hidingFlags.has(f)) || modifiers.some(x => kernel.hidingModifiers.has(x));
      // a body in another language (Python, HTML, ...): no def-lang phrases or variables in it
      inPython = language !== null;
      if (group === null) { group = number; sequence.push(['def', group]); }
      if (language && kernel.editors.get(definition.language) === 'html') inHtml = group;
      const texts = rawPattern ? definition.pattern.split(' or ') : [definition.pattern];
      for (const t of texts) {
        const pattern = compile(rawPattern ? rawRegex(t.trim(), argumentName) : readableToRegex(t.trim(), argumentName));
        if (pattern) defs.push({ file, line: number, text: line.trim(), pattern: t.trim(), argumentName, group, flags, language, modifiers, rawPattern, keepsWords, internal, ...pattern });
      }
      return;
    }
    // an alias, by a definition that makes one (`X means Y`): its words are a phrase
    for (const maker of kernel.aliasMakers) {
      for (const phrase of argumentTexts(line, maker, maker.args[0])) {
        const words = phrase.split(/\s+/).map(escapeRegex).join('\\s+');
        const pattern = compile({ source: '(?<!\\S)(?<k0>' + words + ')(?!\\S)', keywords: phrase.split(/\s+/).length });
        if (pattern) { defs.push({ file, line: number, text: line.trim(), pattern: phrase, alias: true, ...pattern }); aliasLines.add(number); }
      }
    }
  });
  // the scope of each line (`in the scope of web/http`): the names a statement's `does`
  // sets it to, for that line and the lines under it, like the engine
  const scopes = new Map(); // line -> [names, as `use` names them]
  const open = [];          // { width, names } of the scope lines still open
  lines.forEach((line, number) => {
    if (!line.trim() || pythonLines.has(number) || htmlLines.has(number) || commentLines.has(number)) return;
    while (open.length && open[open.length - 1].width >= width(line)) open.pop();
    const effect = statementEffect(line, kernel, true);
    const own = effect && effect.scope ? effect.scope.split(/\s+and\s+/).map(n => n.trim()).filter(Boolean) : [];
    const names = [...open.flatMap(o => o.names), ...own];
    if (names.length) scopes.set(number, names);
    if (own.length) open.push({ width: width(line), names: own });
  });
  return { file, defs, lines, pythonLines, htmlLines, languageLines, entries, entryLines, definitionLines, aliasLines, doesLines, commentLines, sequence, scopes };
}

// The files and folders a line is in the scope of: each name the way `use` names it (a
// file), or a library's name (its folder: all its files), like the engine's scope_of.
function scopeAt(index, n) {
  const names = index && index.scopes && index.scopes.get(n);
  return names ? scopePlaces(names, index.file) : null;
}

function scopePlaces(names, fromFile) {
  const here = path.dirname(fromFile);
  const program = programFolder(fromFile);
  const places = [];
  for (const name of names) {
    const local = [here, program].map(d => path.join(d, name + '.def')).find(f => fs.existsSync(f));
    const folder = !local && !name.includes('/') &&
      (libraryFolder(program, name) || (fs.existsSync(path.join(here, 'library.toml')) && libraryFolder(here, name)));
    const place = local || folder || resolveImport(name, fromFile);
    if (place) places.push(path.resolve(place));
  }
  return places;
}

// Whether a file is in a scope: it is one of its files, or in one of its folders.
function inScope(file, scope) {
  const full = path.resolve(file);
  return scope.some(place => full === place || full.startsWith(place + path.sep));
}

// Every match of a def on a line, with greedy and with lazy arguments.
function* matches(text, def) {
  // a quick look first: a line without one of its fixed words can't match
  if (def.words && !def.words.every(word => text.includes(word))) return;
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
// like the engine's "a longer phrase wins"). Where files define the same phrase, the
// ones in `scope` (scopeAt), if any are.
function findDefinitions(line, column, indexes, scope = null) {
  const masked = maskStrings(line);
  if (masked[column] === '\u0001') return [];
  const hits = [];
  for (const index of indexes) {
    for (const def of index.defs) {
      for (const m of matches(masked, def)) {
        const spans = keywordSpans(m);
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
  const most = Math.max(...hits.map(h => h.score));
  let best = hits.filter(h => h.score === most);
  if (scope && new Set(best.map(h => h.file)).size > 1) {
    const scoped = best.filter(h => inScope(h.file, scope));
    if (scoped.length) best = scoped;
  }
  // one result per definition: stacked def lines of one def share a body, so they
  // show once, pointing at the def's first line
  const seen = new Set();
  return best
    .map(h => ({ ...h, line: h.group ?? h.line }))
    .filter(h => !seen.has(h.file + ':' + h.line) && seen.add(h.file + ':' + h.line));
}

// Every phrase on a line, as [start, end, kind], to color: the fixed words of a
// definition that sit next to each other ("count the visit"). Its kind comes from its
// definition: 'keyword' when it keeps its arguments' words (`repeat … times :`, `A0 is
// A1`), or is a statement or an alias (`plus`); 'number' for a word list (number words);
// else 'function'. Symbols alone (`+`) keep the grammar's color.
function phrasesIn(line, indexes) {
  const kind = def => (def.statement || def.keepsWords ? 'keyword' : 'function');
  const found = allPhrases(line, indexes).filter(p => /[\p{L}\p{N}_]/u.test(line.slice(p.start, p.end))).map(p => [p.start, p.end, kind(p.def)]);
  const masked = maskStrings(line);
  const lists = [];
  for (const index of indexes) {
    for (const def of index.defs) {
      if (def.alias) {
        for (const m of matches(masked, def)) {
          for (const [start, end] of keywordSpans(m)) if (!found.some(([s, e]) => start < e && s < end)) found.push([start, end, 'keyword']);
        }
      } else if (!def.keywords) lists.push(def);
    }
  }
  // a word list matches a whole value: each stretch between the phrases is tried
  if (lists.length) {
    const taken = [...found].sort((a, b) => a[0] - b[0]);
    let at = 0;
    for (const [from, to] of [...taken.map(([s, e]) => [at, (at = e, s)]), [at, line.length]]) {
      const text = masked.slice(from, to);
      const start = from + text.length - text.trimStart().length;
      const end = from + text.trimEnd().length;
      if (end <= start) continue;
      for (const def of lists) {
        def.whole = def.whole || new RegExp('^(?:' + def.regex.source + ')$', 'u');
        if (def.whole.test(masked.slice(start, end))) { found.push([start, end, 'number']); break; }
      }
    }
  }
  return found.sort((a, b) => a[0] - b[0]);
}

// The fixed words of a library's statement on a line that is that statement (`greet`
// in `greet Sam`), as [start, end]: they are colored like `use`.
function statementWordsIn(line, indexes) {
  const first = line.search(/\S/);
  const found = allPhrases(line, indexes).filter(p => p.def.statement);
  return found.length && found[0].start === first ? found.map(p => [p.start, p.end]) : [];
}

// Like phrasesIn, with syntax words too, and the def of each phrase: { start, end, def }.
function allPhrases(line, indexes) {
  const masked = maskStrings(line);
  const found = [];
  for (const index of indexes) {
    for (const def of index.defs) {
      if (def.alias || !def.keywords) continue;
      for (const m of matches(masked, def)) {
        const spans = keywordSpans(m);
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
  // an `internal` def is seen only by its own file
  return indexes.filter(index => seen.has(index.file))
    .map(index => index.file === file || !index.defs.some(d => d.internal) ? index : { ...index, defs: index.defs.filter(d => !d.internal) });
}

// Where to start reading the order for a file: its package's main.def, the
// project's init.def, then the file itself.
function orderStarts(file) {
  const home = packageFolder(file);
  return [home && path.join(home, 'main.def'), resolveImport('core', file), file].filter(Boolean);
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
//   - a sentence (a `written` def that starts the line with two or more fixed words)
//     wraps what follows them, except a closing word at the very end, like `?`.
function wrapsOnLine(def, start, end, line, inner) {
  if (def.alias || def.keywords < 2) return false;
  for (const m of matches(maskStrings(line), def)) {
    const spans = keywordSpans(m);
    if (spans.length < 2) continue;
    const first = spans[0][0];
    const last = spans[spans.length - 1][1];
    if (spans.some(s => s[1] <= start) && spans.some(s => s[0] >= end)) return true;
    const sentence = def.keepsWords && first === line.search(/\S/);
    // a closing word at the very end (the `?` of a question) isn't wrapped: it takes the line itself
    const closing = inner && inner.leadingArgument && end >= line.trimEnd().length;
    if (sentence && start >= last && !closing) return true;
  }
  return false;
}

// The use of a def under the cursor: its fixed words and the parts that fill its
// arguments (with the spaces between them), as [start, end] pairs. An argument at the start or end of the pattern
// stops at the first phrase that binds looser, like the engine reads the line.
// The phrase whose argument holds `column`: the words there fill its A0, A1, ...
// { hit, part: [start, end], structure }, the innermost one, or null.
function argumentAt(line, column, indexes, order, scope = null) {
  let best = null;
  for (const phrase of allPhrases(line, indexes)) {
    const hit = findDefinitions(line, phrase.start, indexes, scope)[0];
    const structure = hit && structureAt(line, phrase.start, indexes, order, scope);
    const part = structure && structure.parts.find(([start, end]) => start <= column && column < end);
    if (part && (!best || part[1] - part[0] < best.part[1] - best.part[0])) best = { hit, part, structure };
  }
  return best;
}

function structureAt(line, column, indexes, order, scope = null) {
  const hit = findDefinitions(line, column, indexes, scope)[0];
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

// The variable a definition's argument names: the words when they are one name, or a
// count and a name (`give 2 numbers ...` names `numbers`).
function variableOf(text) {
  if (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(text)) return text;
  const counted = /^\d+\s+([\p{L}_][\p{L}\p{N}_]*)\b/u.exec(text);
  return counted ? counted[1] : null;
}

// Every variable name a program gives a value to, for coloring: what the definitions
// that make variables name (kernel.variableMakers), and `use NAMES from FILE`.
function variableNames(indexes, kernel) {
  const names = new Set(kernel ? kernel.fixedVariables : []);
  for (const index of indexes) {
    index.lines.forEach((line, n) => {
      if (index.pythonLines.has(n) || index.commentLines.has(n) || index.definitionLines.has(n) || index.entryLines.has(n) || index.doesLines.has(n)) return;
      const used = /^use\s+(.+?)\s+from\s+\S+\s*$/.exec(line);
      if (used) {
        for (const part of used[1].split(',')) names.add(part.split(/\s+as\s+/).pop().trim());
        return;
      }
      for (const maker of kernel ? kernel.variableMakers : []) {
        for (const n of maker.args) for (const text of argumentTexts(line, maker, n)) { const name = variableOf(text); if (name) names.add(name); }
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

// Where a variable first gets a value: a line where a definition that makes variables
// names it (`x is ...`, `for each x in ...`).
function findVariable(word, currentFile, indexes, kernel) {
  if (!/^[\p{L}\p{N}_]+$/u.test(word) || !kernel) return null;
  // the current file first, then the rest of its package, then everything else
  const home = packageFolder(currentFile);
  const rank = index => index.file === currentFile ? 0 : home && index.file.startsWith(home + path.sep) ? 1 : 2;
  const ordered = [...indexes].sort((a, b) => rank(a) - rank(b));
  for (const index of ordered) {
    for (let n = 0; n < index.lines.length; n++) {
      if (index.pythonLines.has(n) || index.commentLines.has(n) || index.definitionLines.has(n) || index.entryLines.has(n) || index.doesLines.has(n)) continue;
      for (const maker of kernel.variableMakers) {
        if (maker.args.some(arg => argumentTexts(index.lines[n], maker, arg).some(text => variableOf(text) === word))) return { file: index.file, line: n };
      }
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

// The folders of every library a program uses, outside its libraries/ copies: those it
// lists (linked, global), and those their own libraries.toml lists, and so on.
function libraryFoldersOf(owner) {
  const found = [];
  const walk = from => {
    for (const entry of listedLibraries(from)) {
      const folder = libraryFolder(from, entry.name);
      if (!folder || found.includes(folder)) continue;
      found.push(folder);
      walk(folder);
    }
  };
  walk(owner);
  return found.filter(folder => !folder.startsWith(path.join(owner, 'libraries') + path.sep));
}

// ---- uses: Find All References, and the count above each definition and entry

// What a use is a use of: 'def FILE:LINE' (a definition, by its first line; a statement
// is the definition of its words, on its entry's line), 'language NAME', 'flag NAME',
// 'modifier NAME', or 'file PATH'.
function defId(file, line) {
  return 'def ' + path.resolve(file) + ':' + line;
}

// The uses in one file: Map id -> [{ file, line, start, end }]. A phrase is a use of the
// definition the editor reads it with, as hover and Ctrl+click do (scopes too); an
// element's def="name" in an HTML body, of that def. Python bodies aren't read.
function usesIn(index, indexes, kernel) {
  const uses = new Map();
  const add = (id, n, start, end) => {
    if (!uses.has(id)) uses.set(id, []);
    uses.get(id).push({ file: index.file, line: n, start, end });
  };
  const visible = visibleIndexes(index.file, indexes);
  index.lines.forEach((text, n) => {
    if (index.htmlLines.has(n)) {
      for (const m of text.matchAll(/(?<![\w-])def="([^"]+)"/g)) {
        const start = m.index + m[0].indexOf(m[1]);
        for (const hit of findDefinitions(m[1], 0, visible)) add(defId(hit.file, hit.line), n, start, start + m[1].length);
      }
      return;
    }
    if (index.pythonLines.has(n) || index.commentLines.has(n) || !text.trim()) return;
    // a definition line's modifiers, language and flags; modifiers in front of a line; `does in LANGUAGE[FLAGS]`
    for (const w of kernelWordsIn(text, kernel)) add(w.kind + ' ' + w.name, n, w.start, w.end);
    // the files of `use` and `in the scope of`
    for (const [start, end, target] of findLinks(text, index.file, kernel)) add('file ' + path.resolve(target), n, start, end);
    if (index.entryLines.has(n) || index.definitionLines.has(n)) return;
    // the phrases, each with the definition it is read with: one use per definition and line
    const scope = scopeAt(index, n);
    const found = new Map();
    for (const phrase of allPhrases(text, visible)) {
      for (const hit of findDefinitions(text, phrase.start, visible, scope)) {
        const id = defId(hit.file, hit.line);
        const [start, end] = found.get(id) || [phrase.start, phrase.end];
        found.set(id, [Math.min(start, phrase.start), Math.max(end, phrase.end)]);
      }
    }
    for (const [id, [start, end]] of found) add(id, n, start, end);
  });
  return uses;
}

// What gets a count of its uses above it, in a file: [{ line, id }]: each definition (its
// first line) and each entry.
function countedIn(index) {
  const items = new Map();
  for (const d of index.defs) if (!d.alias && !d.statement) items.set(d.group ?? d.line, defId(index.file, d.group ?? d.line));
  for (const e of index.entries) items.set(e.line, e.kind === 'statement' ? defId(index.file, e.line) : e.kind + ' ' + e.name);
  return [...items].sort((a, b) => a[0] - b[0]).map(([line, id]) => ({ line, id }));
}

// What Find All References looks for, at `column` of line `n`: the id of a file a `use`
// line names there, or null (the rest comes from what Ctrl+click finds).
function fileIdAt(index, n, column, kernel) {
  const link = findLinks(index.lines[n] || '', index.file, kernel).find(([start, end]) => start <= column && column < end);
  return link ? 'file ' + path.resolve(link[2]) : null;
}

// Whether `line` gives the variable `name` a value (`name is ...`, `for each name in ...`),
// also after modifiers (`shared visits is 0`).
function givesValue(line, name, kernel) {
  const modifiers = kernelWordsIn(line, kernel).filter(w => w.kind === 'modifier');
  const rest = modifiers.length ? line.slice(modifiers[modifiers.length - 1].end).trimStart() : line;
  return kernel.variableMakers.some(maker => maker.args.some(arg => argumentTexts(rest, maker, arg).some(text => variableOf(text) === name)));
}

// The uses of the variable `name` that line `n` of `index` reads: inside a definition's
// body, when only that body gives it a value, the body's; otherwise those of the file it
// belongs to (`owner`), and of the files that use it from there (`use NAME from FILE`,
// `use NAME as OTHER from FILE`: under that name). [{ file, line, start, end }].
function variableUses(name, owner, index, n, indexes, kernel) {
  const found = [];
  const scan = (at, local, from = 0, to = Infinity) => {
    const visible = visibleIndexes(at.file, indexes);
    const names = new Set([local]);
    at.lines.forEach((text, k) => {
      if (k < from || k > to) return;
      if (at.htmlLines.has(k)) {
        for (const m of text.matchAll(/\{(\w+)\}/g)) if (m[1] === local) found.push({ file: at.file, line: k, start: m.index + 1, end: m.index + 1 + local.length });
        return;
      }
      if (at.pythonLines.has(k) || at.commentLines.has(k) || at.entryLines.has(k) || at.definitionLines.has(k)) return;
      const phrases = phrasesIn(text, visible).map(([start, end]) => [start, end]);
      for (const [start, end] of variablesIn(text, names, phrases)) found.push({ file: at.file, line: k, start, end });
    });
  };
  // a definition's own: its body gives it a value, and no line of its file outside a body does
  const owning = bodyOwner(index, n);
  if (owning && !owning.language) {
    const start = owning.group ?? owning.line;
    let from = start + 1;
    while (index.definitionLines.has(from)) from++;
    const body = bodyOf(index, start);
    const used = new RegExp('^use\\s+(?:.*[\\s,])?' + escapeRegex(name) + '(?:[\\s,].*)?\\s+from\\s');
    const outside = index.lines.some(line => !/^\s/.test(line) && (givesValue(line, name, kernel) || used.test(line)));
    if (body.some(line => givesValue(line, name, kernel)) && !outside) {
      scan(index, name, from, from + body.length - 1);
      return found;
    }
  }
  const home = indexes.find(i => path.resolve(i.file) === path.resolve(owner)) || index;
  scan(home, name);
  for (const other of indexes) {
    other.lines.forEach((line, k) => {
      const m = /^use\s+(.+?)\s+from\s+(\S+)\s*$/.exec(line);
      if (!m) return;
      const target = resolveImport(m[2], other.file);
      if (!target || path.resolve(target) !== path.resolve(home.file)) return;
      for (const part of m[1].split(',')) {
        const [theirs, mine] = part.trim().split(/\s+as\s+/).map(s => s.trim());
        if (theirs !== name) continue;
        if (mine) {
          // `use visits as total from counter`: `visits` here, then `total` in this file
          const at = line.indexOf(theirs, 4);
          if (at >= 0) found.push({ file: other.file, line: k, start: at, end: at + theirs.length });
        }
        if (other !== home) scan(other, mine || theirs);
      }
    });
  }
  return found;
}

// Is `line` a def-lang comment (not a line inside a Python, HTML, ... body)?
function isComment(index, line) {
  if (index.pythonLines.has(line)) return false;
  return index.commentLines.has(line);
}

// Where the entry `kind name` is declared (`language css`, `modifier shared`): { file, line },
// or null. One that replaces another (`replaces FILE`) is the one used, so it comes first.
function findEntry(kind, name, indexes) {
  const found = [];
  for (const index of indexes) {
    for (const e of index.entries) if (e.kind === kind && e.name === name) found.push({ file: index.file, line: e.line, replaces: !!e.fields.replaces });
  }
  const best = found.find(f => f.replaces) || found[0];
  return best ? { file: best.file, line: best.line } : null;
}

// For the entry on `line`: the entry it replaces (`replaces FILE`), and those that replace
// it: { replaces: { file, line } | null, replacedBy: [{ file, line }] }.
function replacementsOf(index, line, indexes) {
  const entry = entryOn(index, line);
  if (!entry) return { replaces: null, replacedBy: [] };
  const real = file => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
  const named = (e, from) => e.fields.replaces && resolveImport(e.fields.replaces.value, from);
  const others = [];
  for (const other of indexes) {
    for (const e of other.entries) {
      if (e.kind === entry.kind && e.name === entry.name && !(other.file === index.file && e.line === line)) others.push({ file: other.file, line: e.line, e });
    }
  }
  const replaced = named(entry, index.file);
  const found = replaced && others.find(o => real(o.file) === real(replaced));
  return {
    replaces: found ? { file: found.file, line: found.line } : null,
    replacedBy: others.filter(o => { const t = named(o.e, o.file); return t && real(t) === real(index.file); }).map(o => ({ file: o.file, line: o.line })),
  };
}

// Where the language `name` is declared: { file, line }, or null.
function findLanguage(name, indexes) {
  return findEntry('language', name, indexes);
}

// The entry declared on `line`, or undefined.
function entryOn(index, line) {
  return index.entries.find(e => e.line === line);
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
function findLinks(line, fromFile, kernel = null) {
  const links = [];
  let m;
  if ((m = /^(use\s+(?:.+?\s+from\s+)?)(\S+)\s*$/.exec(line))) {
    const target = resolveImport(m[2], fromFile);
    if (target) links.push([m[1].length, m[1].length + m[2].length, target]);
  }
  // the files of a scope (`in the scope of web/http and io/audio`): each name leads to its
  // file (a library's name, to its folder)
  const effect = kernel && statementEffect(line, kernel, true);
  if (effect && effect.scope) {
    const [from] = effect.at.scope;
    for (const name of effect.scope.matchAll(/\S+/g)) {
      if (name[0] === 'and') continue;
      const [place] = scopePlaces([name[0]], fromFile);
      const start = from + line.slice(from).indexOf(effect.scope) + name.index;
      if (place && fs.existsSync(place) && fs.statSync(place).isFile()) links.push([start, start + name[0].length, place]);
    }
  }
  const fileWords = /\b(?:template|assets\s+are\s+in)\s+"([^"]+)"/g;
  while ((m = fileWords.exec(line))) {
    const target = resolveProgramFile(m[1], fromFile);
    const start = m.index + m[0].length - m[1].length - 1;
    if (target) links.push([start, start + m[1].length, target]);
  }
  return links;
}


// The description of the definition or entry on `line`: the comment lines right above it
// (above the first line of a definition group, or of a run of `means` lines).
function descriptionOf(index, line) {
  const lines = index.lines;
  const same = entryOn(index, line) ? (() => false)
    : index.definitionLines.has(line) ? (n => index.definitionLines.has(n)) : (n => index.aliasLines.has(n));
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

// Only the definition line(s) on `line`: all the lines of a definition group (every
// way to write it), an entry with its fields but not its `does`, or the `means` line.
// The body is a Ctrl+click away.
function headerOf(index, line) {
  const lines = index.lines;
  const entry = entryOn(index, line);
  if (entry) return [lines[line], ...Object.entries(entry.fields).filter(([name]) => name !== 'does').map(([, f]) => lines[f.line])].join('\n');
  const isDef = n => index.definitionLines.has(n);
  if (!isDef(line)) return lines[line];
  let start = line;
  while (isDef(start - 1)) start--;
  let end = line;
  while (isDef(end + 1)) end++;
  return lines.slice(start, end + 1).join('\n');
}

// The source of the definition on `line`: its group of definition lines and its body,
// or an entry and its fields (for a `means` line, just that line). Long bodies are cut
// after `limit` lines.
function sourceOf(index, line, limit = 15) {
  const lines = index.lines;
  const isDef = n => index.definitionLines.has(n);
  const entry = entryOn(index, line);
  if (!isDef(line) && !entry) return lines[line];
  let start = line;
  let end = line;
  if (!entry) {
    while (isDef(start - 1)) start--;
    while (isDef(end + 1)) end++;
  }
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

// The help of the interpreter's own language; every other language, flag, modifier and
// statement has its entry's comment lines.
const FLAG_HELP = {};
const LANGUAGE_HELP = {
  'python': '**python**: the body is Python. It gets `self` (the kernel: `self["variables"]`, `self.run`, ...) and the arguments.',
};

// What each reserved word of an entry means, and `use`: shown on hover.
const MORE = '\n\n[Writing languages, flags, modifiers and statements](https://github.com/Pedram-A-Keyvani/deflang-lib/blob/main/ENTRIES.md)';
const RESERVED_HELP = {
  'language': '**language NAME** declares a language for the bodies of definitions: `NAME greeting for A0` then makes a definition whose body is in it.\n\n' +
    'Its `does` runs when such a definition runs, and acts on it: its value is `body` when `does` ends (`set body to upper-case`). Its definitions may have any flag.\n\nFields: `does in`, `editor`, `replaces`.' + MORE,
  'flag': '**flag NAME** declares a flag, written in brackets right after a definition\'s language: `python[NAME] ...`, or by its `words`: `python[cache 60 seconds] ...`.\n\n' +
    'Its `does` runs when the definition is made, before its pattern is read, and acts on the definition (`set arguments to as written`); it gets the words in their places, `A0`, `A1`, ...\n\nFields: `words`, `does in`, `replaces`.' + MORE,
  'modifier': '**modifier NAME** declares a word in front of a line.\n\n' +
    'In front of a definition (`NAME python ...`), its `does` acts on the definition, right after it is made (`set seen by to the file`). ' +
    'In front of a name (`NAME visits is 0`), it acts on the name (`set name to shared`), and then the rest of the line runs.\n\nFields: `does in`, `replaces`.' + MORE,
  'statement': '**statement NAME** declares a whole line the reader knows, by its `words`. They are matched before anything else on a line, so they never read as part of an expression.\n\n' +
    'Its `does` runs when the line is read, and acts on the file of its line (`set comment marker to A0`); it gets the words in their places, `A0`, `A1`, ... (as they are written with `does in def[written]`).\n\nFields: `words`, `does in`, `replaces`.' + MORE,
  'does': '**does in LANGUAGE[FLAGS]**: what the entry does, in that language; its body is one level deeper. It runs when the entry acts, where it acts: in the variables of that line. ' +
    'Flags may follow, as on a definition line: `does in def[written]` gets its arguments\' words, not text.\n\n' +
    '`does in def`: commands with no subject, acting on what the entry acts on (`set arguments to as written`, `set body to upper-case`). ' +
    '`does in python`: the same through `self["entry"]`, and a statement\'s words as `a[0]`, `a[1]`, ...' + MORE,
  'words': '**words PATTERN**: how the entry is written, like a pattern. A statement: the words of its line, `words comment is A0`. A flag: its words in the brackets, `words cache A0 seconds` for `[cache 60 seconds]` (without `words`, a flag is its name). ' +
    'Its `A0`, `A1`, ... are the words in their places; its `does` gets them.' + MORE,
  'editor': '**editor ID**: the editor\'s language for the bodies, for coloring and formatting them: `editor css`.' + MORE,
  'replaces': '**replaces FILE**: this entry replaces the one of the same kind and name that `FILE` declared, named the way `use` names it: `replaces language/css`. ' +
    'From then on, the new one is used, also by definitions made before it. Without `replaces`, declaring an entry another file declared is an error.' + MORE,
  'use': '**use NAME** runs `NAME.def`, or the library `NAME`, once: next to this file, in the program\'s folder, then in the program\'s libraries. ' +
    '`use NAME/FILE` is a library\'s file; `use NAMES from FILE` also gives this file the shared variables `NAMES` of `FILE`, and `use NAME as OTHER from FILE` calls one `OTHER` here.',
};

// The reserved word under `column` of line `n`: an entry's kind (`modifier`), one of its
// fields (`does in`, `words`, ...), or `use`: { word, start, end }, or null.
function reservedWordAt(index, n, column) {
  const line = index.lines[n] || '';
  const at = (start, shown, word = shown) => (column >= start && column < start + shown.length ? { word, start, end: start + shown.length } : null);
  let m;
  if ((m = ENTRY_LINE.exec(line))) return at(0, m[1]);
  if (/^use\s/.test(line)) return at(0, 'use');
  for (const entry of index.entries) {
    for (const [field, value] of Object.entries(entry.fields)) {
      if (value.line !== n) continue;
      const start = line.search(/\S/);
      const shown = field === 'does' ? ((/^does\s+in\b/.exec(line.slice(start)) || ['does'])[0]) : field;
      return at(start, shown, field);
    }
  }
  return null;
}

// The flag under the cursor on a definition line (`python[written] ...`): { flag, start, end }, or null.
function flagAt(line, column, kernel = kernelNames([])) {
  const definition = definitionLine(line, kernel);
  const flag = definition && definition.flags.find(f => f.start <= column && column < f.end);
  return flag ? { flag: flag.name, start: flag.start, end: flag.end } : null;
}

// The body lines of the definition group starting at line `start`.
function bodyOf(index, start) {
  let n = start + 1;
  while (index.definitionLines.has(n)) n++;
  const body = [];
  for (; n < index.lines.length; n++) {
    const line = index.lines[n];
    if (line.trim() && !/^\s/.test(line)) break;
    body.push(line);
  }
  return body;
}

// Flags a def probably needs but doesn't have: [{ line, message }]. A Python body that
// runs or names an argument itself (self.run(A1), self["variables"][A0]) gets values unless the
// def is `written`.
function flagWarnings(index, indexes, kernel = null) {
  const warnings = [];
  const groups = new Map();
  for (const def of index.defs) if (!def.alias && def.group !== undefined && !groups.has(def.group)) groups.set(def.group, def);
  for (const [start, def] of groups) {
    const flags = def.flags || new Set();
    if (def.language === 'python' && !def.keepsWords) {
      const body = bodyOf(index, start).join('\n');
      const m = /self\.run\(\s*(A\d+)\s*\)|self\[\s*["']variables["']\s*\]\[\s*(A\d+)\s*\]|self\[\s*["'](?:aliases|files)["']\s*\].*?\[\s*(A\d+)\s*\]/.exec(body);
      if (m) {
        const name = m[1] || m[2] || m[3];
        const keep = kernel && [...kernel.wordsFlags][0];
        warnings.push({ line: start, message: `${name} is already a value here, not its words. If this definition needs the words of ${name} (a name, or code to run itself), ` +
          (keep ? `add a flag that keeps them: python[${keep}].` : 'give it a flag that keeps them (one whose does says `set arguments to as written`).') });
      }
    }
  }
  return warnings;
}

// ---- completions (IntelliSense)

const STATEMENTS = [
  ['python', 'python ${1:words A0}\n\t$0', 'Makes a definition in Python: its pattern, then its Python body indented below.'],
  ['use', 'use ${1}', 'Runs another .def file, or a library, once. `use NAMES from FILE` also gives this file the shared variables NAMES of FILE (`use visits as count from counter`).'],
  ['language', 'language ${1:name}\n\tdoes in ${2|def,python|}\n\t\t$0', 'Declares a language: definitions `NAME pattern` then have bodies in it. Fields: `does in LANGUAGE` (runs when a definition runs; acts on its body: `set body to upper-case`), `editor` (VS Code\'s language id). Its definitions may have any flag.'],
  ['modifier', 'modifier ${1:name}\n\tdoes in ${2|def,python|}\n\t\t$0', 'Declares a modifier, a word in front of a line. `does in LANGUAGE` acts on the definition or the name after it: `set seen by to the file`, `set name to shared`.'],
  ['flag', 'flag ${1:name}\n\tdoes in ${2|def,python|}\n\t\t$0', 'Declares a flag, written in brackets right after a language. `does in LANGUAGE` acts on the definition when it is made: `set arguments to as written`. `words`: how it is written, with words of its own: `cache A0 seconds`.'],
  ['statement', 'statement ${1:name}\n\twords ${2:words A0}\n\tdoes in ${3|def[written],def,python|}\n\t\t$0', 'Declares a statement, a whole line. Fields: `words` (its words, like a pattern), `does in LANGUAGE` (gets its words: A0, A1, ...; as written with `does in def[written]`).'],
];

// An entry's fields, as they are offered on its indented lines.
const FIELD_SNIPPETS = {
  'does': ['does in ${1|def,def[written],python|}\n\t$0', 'What the entry does, in that language, one level deeper, with its flags. It acts on what the entry acts on: self["entry"].'],
  'words': ['words ${1:words A0}', 'How the entry is written, like a pattern: a statement\'s line, or a flag\'s words in the brackets.'],
  'editor': ['editor ${1:id}', "VS Code's language id, for coloring and formatting the bodies."],
  'replaces': ['replaces ${1:language/css}', 'Replaces the entry of the same kind and name that another file declared: that file, named the way `use` names it.'],
};

// What a Python body can use besides Python itself (the guide's Appendix D): what the
// interpreter does, self.run(...), and what it has, the kernel's tree, self["..."].
const PYTHON_SELF = [
  ['run', 'run(${1:text})', 'Runs def-lang text and returns its value.'],
  ['say', 'say(${1:value})', 'Prints a value.'],
  ['own_variables', 'own_variables(${1:file})', "In a `with` block, lines get variables of their own, on top of the file's (a web request)."],
  ['changed_files', 'changed_files()', 'The files saved since they were read.'],
  ['reload', 'reload(${1:path})', 'Reads a file again, in place of its old defs.'],
];
const KERNEL_KEYS = [
  ['variables', 'The variables of the running code: its def call\'s own, its file\'s, and the shared ones its file names: `self["variables"]["x"] = 5`.'],
  ['answer', 'Whether the lines one level below run: they run if it is True; None makes them an error. The only part that is set: `self["answer"] = True`.'],
  ['aliases', '`{phrase: words}`: phrase reads as words, longer phrases first.'],
  ['store', 'A library\'s own state: `self["store"]["web"]`, a dict made on first use.'],
  ['file', 'The file running now.'],
  ['program', 'The program\'s folder: `self["program"] / "data.txt"`.'],
  ['files', 'A file\'s place: `self["files"][FILE]`: its "comment", "argument", "indent", "variables", and "names" (the shared variables it uses).'],
  ['shared', 'The shared variables\' values: `{(FILE, NAME): value}`.'],
  ['definitions', 'Every definition, in the order made.'],
  ['entry', 'What the entry whose `does` runs acts on: its definition, name, value, body, ... (by kind).'],
  ['mode', '"running", "checking" (def-lang check) or "reloading" (a changed file read again).'],
  ['language', 'The language entries: `self["language"]["python"]`.'],
  ['flag', 'The flag entries.'],
  ['modifier', 'The modifier entries.'],
  ['statement', 'The statement entries.'],
];
const PYTHON_HELPERS = [
  ['self', 'self', 'The kernel: what it has, self["variables"], self["answer"], ...; what it does, self.run, self.say.'],
  ['number', 'number(${1:value})', 'The value as a number, or an error.'],
  ['parse_number', 'parse_number(${1:text})', 'The text as a number, or None.'],
  ['as_text', 'as_text(${1:value})', 'The value as text a person reads (what `say` prints).'],
  ['as_code', 'as_code(${1:value})', 'The value written as def-lang code, to put in text for self.run.'],
  ['Code', 'Code(${1:text})', 'Marks text as code, so another language puts it in without escaping it.'],
  ['DefException', 'DefException(${1:message})', 'Raise it to stop with a def-lang error.'],
];
// what an entry's `does` acts on, self["entry"][...], by kind (the guide's 5.1)
const ENTRY_KEYS = {
  language: [['definition', 'The definition that runs.'], ['template', 'Its body, without its common indentation; the places of its arguments are marked, for fill.'],
    ['values', 'The arguments: their values, or their words for a definition that keeps them.'], ['fill', 'fill(template, values): the template with the values in, as text.'],
    ['body', "The template filled in with the values as text; the definition's value when `does` ends, unless it gives back another."],
    ['as written', "True when the definition keeps its arguments' words."], ['in place', "True when the definition is an entry's does: it runs where the entry acts."]],
  flag: [['definition', 'The definition being made, before its pattern is read.'], ['value', "The flag's value as written (`60` for `[cache 60]`), or None."]],
  modifier: [['definition', 'The definition just made, when it stands in front of one.'], ['name', 'The name after it, when it stands in front of one.']],
  statement: [],
};
// ... and, in Python, a statement's words
const ENTRY_HELPERS = {
  language: [], flag: [], modifier: [],
  statement: [['a', 'a', 'Its words in the places of A0, A1, ...: a[0], a[1], ..., as they are written.']],
};

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
    if (fs.existsSync(path.join(folder, 'main.def'))) names.add(name); // `use language/html`, not `use language`
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

// The def whose body holds `line` (Python or def-lang), or null. For the body of an
// entry's `does in LANGUAGE`: { language: true, entry }.
function bodyOwner(index, line) {
  let n = line;
  while (n > 0 && (/^\s/.test(index.lines[n]) || !index.lines[n].trim())) n--;
  if (n === line) return null;
  const entry = entryOn(index, n);
  if (entry) return { language: true, entry };
  return index.defs.find(d => d.line === n && !d.alias && !d.statement) || null;
}

// The language of the body that line `n` is in, when it is another language than
// def-lang (html, css, javascript, python, ...); else null.
function bodyLanguageAt(index, n) {
  if (!index.pythonLines.has(n)) return null;
  const owner = bodyOwner(index, n);
  if (!owner) return null;
  if (owner.language === true) return owner.entry.does && !owner.entry.defLang ? owner.entry.does : null;
  return owner.language || null;
}

// The line an indented line belongs to: the first line above it that isn't indented.
function ownerLine(index, n) {
  while (n > 0 && (/^\s/.test(index.lines[n]) || !index.lines[n].trim())) n--;
  return n;
}

// What to suggest at `column` of line `n`: [{ label, kind, insert, filter, detail, documentation, sort }].
// kind: statement | phrase | follow | variable | flag | language | import | python.
function completionsAt(index, n, column, indexes, kernel = kernelNames([])) {
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
    const start = kind === 'python' || (kind === 'variable' && index.pythonLines.has(n)) ? before.search(/\w*$/) : startOf(filter);
    items.push({ kind, label, insert, filter, start, detail: more.detail || '', documentation, sort: more.sort || '5' });
  };

  // a Python body (or an entry's `does`)
  if (index.pythonLines.has(n)) {
    const owner = bodyOwner(index, n);
    // an HTML, CSS, JavaScript ... body: that language's own editor support, not ours
    if (owner && owner.language !== true && owner.language !== 'python') return [];
    if (/\bself\.\w*$/.test(before)) {
      for (const [label, insert, doc] of PYTHON_SELF) add('python', label, insert, doc);
      return items;
    }
    // what an entry acts on: self["entry"]["body"], ...
    if (owner && owner.entry && /\bself\[\s*["']entry["']\s*\]\[\s*["'][\w ]*$/.test(before)) {
      for (const [label, doc] of ENTRY_KEYS[owner.entry.kind]) add('python', label, label, doc);
      add('python', 'kind', 'kind', 'The kind of the entry: "language", "flag", "modifier" or "statement".');
      return items;
    }
    // the kernel's tree: self["variables"], ...
    if (/\bself\[\s*["']\w*$/.test(before)) {
      for (const [label, doc] of KERNEL_KEYS) add('python', label, label, doc);
      return items;
    }
    if (/["'][^"']*$/.test(before)) return [];
    for (const [label, insert, doc] of PYTHON_HELPERS) add('python', label, insert, doc);
    if (owner && owner.entry) for (const [label, insert, doc] of ENTRY_HELPERS[owner.entry.kind]) add('python', label, insert, doc);
    else if (owner) for (const p of patternParts(owner.pattern, owner.argumentName)) if (p.argument) add('variable', p.argument, p.argument, 'An argument of this def: its value' + (owner.keepsWords ? ', as written (its words)' : ''), { sort: '0' });
    return items;
  }
  if (index.htmlLines.has(n) || isComment(index, n)) return [];
  if ((maskStrings(before).match(/"/g) || []).length % 2) return []; // inside text

  const text = before.trimStart();
  let m;
  // an entry's fields: the ones it doesn't have yet
  if (!index.doesLines.has(n) && (index.entryLines.has(n) || (/^\s/.test(line) && !text.includes(' ') && entryOn(index, ownerLine(index, n)) &&
    !(index.entries.find(e => e.line === ownerLine(index, n)) || {}).defLang))) {
    const entry = entryOn(index, ownerLine(index, n));
    if (!entry || /\s/.test(text)) return [];
    for (const field of FIELDS[entry.kind]) {
      if (entry.fields[field] && entry.fields[field].line !== n) continue;
      add('statement', field, FIELD_SNIPPETS[field][0], FIELD_SNIPPETS[field][1], { sort: '0' });
    }
    return items;
  }
  // the flags in the brackets right after a language: `python[wri`
  if ((m = /^((?:[\w-]+\s+)*)(\w+)\[([^\]]*)$/.exec(before)) && kernel.languages.has(m[2]) && m[1].split(/\s+/).every(w => !w || kernel.modifiers.has(w))) {
    // every declared flag: by its name, or by its words (`cache ${1:A0} seconds`)
    const used = m[3].split(',').map(f => f.trim().split(/\s+/)[0]);
    for (const name of kernel.flags) {
      if (used.slice(0, -1).includes(name)) continue;
      const declared = findEntry('flag', name, indexes);
      const index = declared && indexes.find(i => i.file === declared.file);
      const entry = index && entryOn(index, declared.line);
      const help = FLAG_HELP[name] || (index ? descriptionOf(index, declared.line) : '');
      const snippet = entry && entry.fields.words ? defSnippet({ pattern: entry.fields.words.value, argumentName: 'A' }) : null;
      add('flag', snippet ? snippet.label : name, snippet ? snippet.insert : name, help, { sort: '0', filter: name });
    }
    return items;
  }
  // a definition's pattern
  if (definitionLine(before + 'x', kernel)) return [];
  if (/^use\s+\S*$/.test(text) || /^use\s+.+\s+from\s+\S*$/.test(text)) {
    for (const name of importNames(index.file)) add('import', name, name, '', { detail: 'use' });
    return items;
  }

  const visible = visibleIndexes(index.file, indexes);
  const words = text.split(/\s+/);
  const first = !/\s/.test(text); // still on the line's first word
  if (first && !/^\s/.test(line)) {
    for (const [label, insert, doc] of STATEMENTS) add('statement', label, insert, doc, { sort: '1' });
    // the declared languages and modifiers start a line too
    const help = (kind, name) => {
      const found = findEntry(kind, name, indexes);
      return found ? descriptionOf(indexes.find(i => i.file === found.file), found.line) : '';
    };
    for (const name of kernel.languages) {
      if (!BUILT_IN.languages.includes(name)) add('language', name, name + ' ${1:words A0}\n\t$0', help('language', name) || `Makes a definition whose body is ${name}.`, { sort: '1' });
    }
    for (const name of kernel.modifiers) add('statement', name, name + ' ', help('modifier', name), { sort: '1', detail: 'modifier' });
    // the declared statements, by their words
    for (const other of indexes) {
      for (const entry of other.entries) {
        if (entry.kind !== 'statement' || !entry.fields.words) continue;
        const snippet = defSnippet({ pattern: entry.fields.words.value, argumentName: 'A' });
        add('statement', snippet.label, snippet.insert, descriptionOf(other, entry.line), { sort: '1', detail: 'statement', filter: snippet.filter });
      }
    }
  }
  const seen = new Set();
  for (const other of visible) {
    for (const def of other.defs) {
      if (def.keywords === 0 || def.rawPattern || def.statement) continue;
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
  for (const name of variableNames(visible, kernel)) add('variable', name, name, 'A variable of the program.', { sort: '0' });
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
function formatText(text, kernel = kernelNames([text])) {
  return render(formatParts(text, kernel), new Map());
}

// The same, with each body in another language given to formatBody(language, text, indent),
// which returns its formatted text (from column 0), or null to keep it as it is.
async function formatTextWith(text, kernel, formatBody) {
  const parts = formatParts(text, kernel);
  const formatted = new Map();
  for (const [i, part] of parts.entries()) {
    if (!part.body || !part.body.some(line => line.trim())) continue;
    try {
      const done = await formatBody(part.language, bodyText(part), part.indent);
      if (typeof done === 'string' && done.trim()) formatted.set(i, done);
    } catch {} // a formatter that fails leaves its body as it was
  }
  return render(parts, formatted);
}

// A file as parts: { line } (already formatted), or { body, language, indent, at } (a body
// in another language, its lines as they are, to go `at` spaces in).
function formatParts(text, kernel) {
  const lines = text.split(/\r?\n/);
  const parts = [];
  let indent = 4;
  let comment = '//';
  let body = null;
  let bodyLanguage = null; // after a definition line: the language of its body, or null (def-lang)
  let entry = false;       // after an entry line: its fields, and the Python of its `does`
  let does = null;         // the width of the entry's `does in LANGUAGE` line
  let doesIn = null;       // ... and its language: a body in def is formatted as def-lang lines
  const lead = line => line.slice(0, line.length - line.trimStart().length);
  const width = line => [...lead(line)].reduce((n, c) => n + (c === '\t' ? indent : 1), 0);
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const indented = /^\s/.test(line);
    if (body) {
      if (!line || (indented && width(line) > body.above)) { body.body.push(line); continue; }
      parts.push(body);
      body = null;
    }
    if (!line) { parts.push({ line: '' }); continue; }
    const content = line.trim();
    if (indented && bodyLanguage) { body = { body: [line], language: bodyLanguage, indent, at: indent, above: 0 }; continue; }
    if (indented && entry) {
      // the Python of `does` goes one level under it
      if (does !== null && width(line) > does && !isDefLanguage(doesIn, kernel)) { body = { body: [line], language: doesIn, indent, at: does + indent, above: does }; continue; }
      if (does === null || width(line) <= does) {
        const m = /^does\s+in\s+(\w+)(?:\[[^\]]*\])?$/.exec(content);
        does = m ? width(line) : null;
        doesIn = m ? m[1] : null;
      }
    }
    if (!indented) {
      bodyLanguage = null;
      entry = false;
      does = null;
      let m;
      const definition = definitionLine(content, kernel);
      if (definition) {
        bodyLanguage = isDefLanguage(definition.language, kernel) ? null : definition.language;
        parts.push({ line: content });
        continue;
      }
      if (ENTRY_LINE.test(content)) { entry = true; parts.push({ line: collapseSpaces(content) }); continue; }
      const effect = statementEffect(content, kernel);
      if (effect && effect.comment) comment = effect.comment;
      if (effect && /^\d+$/.test(effect.indent || '') && Number(effect.indent) > 0) indent = Number(effect.indent);
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
      out.push(' '.repeat(part.at) + line.replace(/\s+$/, ''));
    }
    // the empty lines after a body, before the next line
    if (part.body.length && !part.body[part.body.length - 1].trim()) out.push('');
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  while (out.length && out[0] === '') out.shift();
  return out.join('\n') + '\n';
}

module.exports = {
  FLAG_HELP, LANGUAGE_HELP, RESERVED_HELP, isDefLanguage, reservedWordAt, argumentAt, flagAt, statementEffect, argumentTexts, flagWarnings, wrapsOnLine, kernelNames, definitionLine, kernelWordAt, findEntry, entryOn, replacementsOf, statementWordsIn,
  kernelWordsIn, defId, usesIn, countedIn, fileIdAt, variableUses,
  indexText, findDefinitions, findVariable, findLinks, scopeAt, scopePlaces, sourceOf, headerOf, descriptionOf, splitDescription, readableToRegex,
  packageFolder, programFolder, libraryFolder, linkedFolders, libraryFoldersOf, listedLibraries, globalFolder, resolveImport, visibleIndexes, templateExpressionAt, wordAt, phrasesIn, defOrder, orderStarts, structureAt,
  completionsAt, defSnippet, patternParts, importNames, formatText, formatTextWith, bodyLanguageAt,
  variableNames, variablesIn, findLanguage, isComment, apiRoutes, viewPaths, htmlReferenceAt, resolveHtmlReference,
};
