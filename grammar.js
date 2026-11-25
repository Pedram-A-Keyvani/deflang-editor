// The def-lang grammar, made from what a program declares: its languages (each one's
// `editor` names the VS Code grammar for its bodies) and its modifiers. The interpreter's
// own words are the only ones written here: `python`, `use`, the entries and their
// fields, patterns, flags in brackets, text and numbers. The phrases of the libraries
// are colored from their definitions (extension.js, semantic colors).
//
// The extension writes it when the declarations change (a reload shows it);
// `node grammar.js` writes the one the extension ships with: only `python`.
'use strict';
const fs = require('fs');
const path = require('path');

const escape = text => text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

// languages: [{ name, id, scope }]: a VS Code grammar (`scope`, like source.css) colors
// its bodies; with an `id` but no grammar, its bodies are left as they are; with no `id`
// (like `def`), its bodies are def-lang lines. modifiers: the declared modifiers' names.
function makeGrammar({ languages = [], modifiers = [] } = {}) {
  const sorted = list => [...list].sort((a, b) => (a.name || a).localeCompare(b.name || b));
  languages = sorted(languages);
  modifiers = sorted(modifiers);
  const mods = modifiers.length ? '(?:(?:' + modifiers.map(escape).join('|') + ')\\s+)*' : '';
  const definition = names => `^(${mods})(${names})(\\[[^\\]]*\\])?\\s+(.*)$`;
  const captures = {
    1: { patterns: [{ include: '#modifiers' }] },
    2: { name: 'storage.type.def.def' },
    3: { patterns: [{ include: '#flags' }] },
    4: { patterns: [{ include: '#pattern' }] },
  };
  const foreign = languages.filter(l => l.id);
  const defLang = languages.filter(l => !l.id);
  const body = l => (l.scope ? [{ include: l.scope }] : []);
  const repository = {};
  const patterns = [{ include: '#entry' }];

  // a definition in a language with a grammar: its body is colored by it
  foreign.forEach((l, i) => {
    repository[`language-${i}`] = {
      name: `meta.def.${l.id}.def`,
      begin: definition(escape(l.name)),
      beginCaptures: captures,
      end: '^(?=\\S)',
      patterns: [{ name: `meta.embedded.block.${l.id}`, begin: '^(?=[ \\t])', end: '^(?=\\S)', patterns: body(l) }],
    };
    patterns.push({ include: `#language-${i}` });
  });
  // a definition in a def-lang language: its body is def-lang lines, colored as the rest
  if (defLang.length) {
    repository['definition'] = { match: definition(defLang.map(l => escape(l.name)).join('|')), captures };
    patterns.push({ include: '#definition' });
  }
  // a modifier in front of a name: `shared visits is 0`
  if (modifiers.length) {
    repository['name-modifiers'] = { match: `^((?:(?:${modifiers.map(escape).join('|')})\\s+)+)(?=\\S)`, captures: { 1: { patterns: [{ include: '#modifiers' }] } } };
    patterns.push({ include: '#name-modifiers' });
  }
  patterns.push({ include: '#use' }, { include: '#expression' });

  // an entry: its kind and name, its fields, and its `does in LANGUAGE` body in that language
  const does = l => ({
    begin: `^([ \\t]+)(does)\\s+(in)\\s+(${escape(l.name)})(\\[[^\\]]*\\])?\\s*$`,
    beginCaptures: { 2: { name: 'keyword.control.field.def' }, 3: { name: 'keyword.control.field.def' }, 4: { name: 'storage.type.def.def' }, 5: { patterns: [{ include: '#flags' }] } },
    // \1: the width of `does`; its body ends at a line that isn't deeper
    end: '^(?!\\1[ \\t]+\\S)(?=[ \\t]*\\S)',
    ...(l.id ? { contentName: `meta.embedded.block.${l.id}`, patterns: body(l) } : { patterns: [{ include: '#expression' }] }),
  });
  repository.entry = {
    name: 'meta.entry.def',
    begin: '^(language|flag|modifier|statement)\\s+([\\w-]+)\\s*$',
    beginCaptures: { 1: { name: 'storage.type.def.def' }, 2: { name: 'entity.name.type.def' } },
    end: '^(?=\\S)',
    patterns: [
      ...languages.map(does),
      { match: '^[ \\t]+(does)\\s+(in)\\s+(\\w+)(\\[[^\\]]*\\])?\\s*$', captures: { 1: { name: 'keyword.control.field.def' }, 2: { name: 'keyword.control.field.def' }, 3: { name: 'storage.type.def.def' }, 4: { patterns: [{ include: '#flags' }] } } },
      { match: '^[ \\t]+(words)\\s+(.*)$', captures: { 1: { name: 'keyword.control.field.def' }, 2: { patterns: [{ include: '#pattern' }] } } },
      { match: '^[ \\t]+(replaces)\\s+(.*)$', captures: { 1: { name: 'keyword.control.field.def' }, 2: { name: 'entity.name.namespace.def' } } },
      { match: '^[ \\t]+(editor)\\s+(.*)$', captures: { 1: { name: 'keyword.control.field.def' }, 2: { patterns: [{ include: '#flags' }] } } },
    ],
  };
  repository.modifiers = { patterns: [{ name: 'keyword.control.def', match: '[\\w-]+' }] };
  repository.flags = {
    patterns: [
      { name: 'punctuation.section.brackets.def', match: '[\\[\\],]' },
      { name: 'constant.numeric.def', match: '(?<![\\w.])\\d+(?:\\.\\d+)?\\b' },
      { name: 'storage.modifier.def', match: '[\\w-]+' },
    ],
  };
  repository.pattern = {
    patterns: [
      {
        match: '(\\()([A-Z]\\w*?\\d+)(:)\\s*(.*)(\\))',
        captures: {
          1: { name: 'punctuation.definition.parameter.def' }, 2: { name: 'variable.parameter.def' },
          3: { name: 'punctuation.separator.def' }, 4: { name: 'string.regexp.def' }, 5: { name: 'punctuation.definition.parameter.def' },
        },
      },
      { name: 'variable.parameter.def', match: '\\b[A-Z]\\d+\\b' },
      { name: 'keyword.operator.def', match: '[^\\w\\s]+' },
      { name: 'entity.name.function.def', match: '[\\w.]+' },
    ],
  };
  // `use NAME`, `use NAMES from FILE`: the interpreter's statement
  repository.use = {
    match: '^(use)\\s+(?:(.+?)\\s+(from)\\s+)?(\\S+)\\s*$',
    captures: {
      1: { name: 'keyword.control.import.def' }, 2: { name: 'variable.other.def' },
      3: { name: 'keyword.control.import.def' }, 4: { name: 'entity.name.namespace.def' },
    },
  };
  repository.expression = {
    patterns: [
      {
        name: 'string.quoted.double.def', begin: '"', end: '"',
        beginCaptures: { 0: { name: 'punctuation.definition.string.begin.def' } },
        endCaptures: { 0: { name: 'punctuation.definition.string.end.def' } },
      },
      { name: 'variable.parameter.def', match: '\\b[A-Z]\\d+\\b' },
      { name: 'constant.numeric.def', match: '(?<![\\w.])[+-]?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b' },
      { name: 'constant.language.def', match: '\\b(?:True|False|None)\\b' },
      { name: 'keyword.operator.def', match: '>=|<=|[<>=+\\-*/#:?`]' },
      { name: 'punctuation.section.brackets.def', match: '[\\[\\],]' },
    ],
  };

  const grammar = {
    $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
    name: 'def-lang',
    scopeName: 'source.def',
    // no comment rule: a file's comment marker can change, so comments are colored by
    // the extension, which knows the marker of each line
    patterns,
    repository,
  };
  const embeddedLanguages = Object.fromEntries(foreign.map(l => [`meta.embedded.block.${l.id}`, l.id]));
  return { grammar, embeddedLanguages };
}

// The grammar file and package.json's embeddedLanguages, written when they change.
// Gives whether anything changed (a window reload shows it).
function writeGrammar(folder, made) {
  const file = path.join(folder, 'syntaxes', 'def.tmLanguage.json');
  const text = JSON.stringify(made.grammar, null, 2) + '\n';
  let changed = false;
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    changed = true;
  }
  const packageFile = path.join(folder, 'package.json');
  const json = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const grammars = json.contributes.grammars[0];
  if (JSON.stringify(grammars.embeddedLanguages || {}) !== JSON.stringify(made.embeddedLanguages)) {
    grammars.embeddedLanguages = made.embeddedLanguages;
    fs.writeFileSync(packageFile, JSON.stringify(json, null, 2) + '\n');
    changed = true;
  }
  return changed;
}

module.exports = { makeGrammar, writeGrammar };

// `node grammar.js`: the grammar the extension ships with, for the interpreter's `python`
if (require.main === module) {
  const made = makeGrammar({ languages: [{ name: 'python', id: 'python', scope: 'source.python' }], modifiers: [] });
  console.log(writeGrammar(__dirname, made) ? 'wrote syntaxes/def.tmLanguage.json' : 'no change');
}
