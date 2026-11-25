// Ctrl+click and hover in .def files and in the {{ ... }} of a package's HTML templates:
// phrases go to (and show) their def, variables to where they get a value, and
// use / template / assets are in names open the file.
'use strict';
const vscode = require('vscode');
const lib = require('./lib');

let cache = null; // file path -> index of every .def file in the workspace
let texts = null; // file path -> text, to learn the kernel's entries (`language css`, `modifier shared`) first
let kernelBase = null; // the kernel's names from every .def file (lib.kernelNames)
let kernel = null;     // ... and from the open file as it is now, saved or not
let log = null;   // the "def-lang" panel in View > Output

// Hover marks its text with a faint background that is hard to see in dark themes,
// so the hovered use of a def is underlined, spaces included: its fixed words in
// one color, the parts that fill its arguments in another (settings
// "def-lang.underline.wordColor" and "def-lang.underline.argumentColor").
let underline = null;
let dotted = null; // the argument line
let underlined = null; // the editor that has the underline now

function showUnderline(document, solidRanges, dottedRanges = []) {
  clearUnderline();
  const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
  if (!editor) return;
  editor.setDecorations(underline, solidRanges);
  editor.setDecorations(dotted, dottedRanges);
  underlined = editor;
}

function clearUnderline() {
  if (underlined) {
    underlined.setDecorations(underline, []);
    underlined.setDecorations(dotted, []);
  }
  underlined = null;
}

async function indexes(document) {
  const open = document.languageId === 'def-lang' ? document.getText() : '';
  if (!cache) {
    texts = new Map();
    for (const uri of await vscode.workspace.findFiles('**/*.def', '**/node_modules/**', 5000)) {
      try {
        texts.set(uri.fsPath, Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
      } catch (error) { log.appendLine(`could not read ${uri.fsPath}: ${error}`); }
    }
    // the libraries a program uses, wherever they are (global, linked), and the ones
    // they use in turn: what they declare is what the editor knows
    for (const uri of await vscode.workspace.findFiles('**/libraries.toml', '**/node_modules/**', 500)) {
      for (const folder of lib.libraryFoldersOf(require('path').dirname(uri.fsPath))) {
        for (const name of require('fs').readdirSync(folder).filter(n => n.endsWith('.def'))) {
          const file = require('path').join(folder, name);
          if (!texts.has(file)) {
            try { texts.set(file, require('fs').readFileSync(file, 'utf8')); } catch (error) { log.appendLine(`could not read ${file}: ${error}`); }
          }
        }
      }
    }
    kernelBase = lib.kernelNames(texts.values());
    cache = new Map([...texts].map(([file, text]) => [file, lib.indexText(file, text, kernelBase)]));
    updateGrammar(kernelBase);
    log.appendLine(`found ${cache.size} .def files, ${[...cache.values()].reduce((n, i) => n + i.defs.length, 0)} definitions, languages: ${[...kernelBase.languages].join(', ')}, modifiers: ${[...kernelBase.modifiers].join(', ')}`);
  }
  // an open .def file as it is now, saved or not
  kernel = open ? lib.kernelNames([open], kernelBase) : kernelBase;
  const all = new Map(cache);
  if (open) all.set(document.uri.fsPath, lib.indexText(document.uri.fsPath, open, kernel));
  return [...all.values()];
}

// The grammar, from what the programs declare: their languages (each one's `editor`
// gives the VS Code grammar for its bodies) and their modifiers (grammar.js). VS Code
// reads a grammar when a window opens, so a change is offered with a reload, once.
let reloadOffered = false;
function updateGrammar(declared) {
  if (!extensionContext) return;
  try {
    const scopes = new Map(); // VS Code language id -> its grammar's scope
    for (const extension of vscode.extensions.all) {
      for (const grammar of ((extension.packageJSON || {}).contributes || {}).grammars || []) {
        if (grammar.language && grammar.scopeName && grammar.language !== 'def-lang' && !scopes.has(grammar.language)) scopes.set(grammar.language, grammar.scopeName);
      }
    }
    const languages = [...declared.languages].map(name => {
      const id = name === 'python' ? 'python' : declared.editors.get(name) || null;
      return { name, id, scope: id ? scopes.get(id) || null : null };
    });
    const made = require('./grammar').makeGrammar({ languages, modifiers: [...declared.modifiers] });
    if (!require('./grammar').writeGrammar(extensionContext.extensionPath, made) || reloadOffered) return;
    reloadOffered = true;
    log.appendLine(`the grammar now has the languages ${languages.map(l => l.name).join(', ')} and the modifiers ${[...declared.modifiers].join(', ') || '(none)'}`);
    const reload = 'Reload window';
    vscode.window.showInformationMessage('def-lang: the colors of the declared languages and modifiers are ready after a reload.', reload)
      .then(choice => { if (choice === reload) vscode.commands.executeCommand('workbench.action.reloadWindow'); });
  } catch (error) {
    log.appendLine(`the grammar couldn't be written: ${error.message}`);
  }
}

// What is under the mouse: a phrase with its defs, or a variable with its first value.
// In a .def file that is the whole line; in an HTML template of a package, the
// def-lang inside {{ ... }}.
async function lookup(document, position) {
  const line = document.lineAt(position.line).text;
  let text = line;
  let shift = 0;
  if (document.languageId === 'html') {
    if (!lib.packageFolder(document.uri.fsPath)) return null;
    const inside = lib.templateExpressionAt(line, position.character);
    if (!inside) return null;
    text = inside.text;
    shift = inside.start;
  }
  const all = await indexes(document);
  const current = all.find(i => i.file === document.uri.fsPath);
  // comments (descriptions and examples) get no hover, underline or Ctrl+click
  if (current && lib.isComment(current, position.line)) return null;
  if (current && current.htmlLines.has(position.line)) {
    // in a view's HTML: {name}, api="/api/x", loads="/api/x", href="/x", def="name"
    const reference = lib.htmlReferenceAt(line, position.character);
    if (!reference) return null;
    const targets = lib.resolveHtmlReference(reference, document.uri.fsPath, all);
    if (!targets.length) return null;
    const where = new vscode.Range(position.line, reference.start, position.line, reference.end);
    return { all, html: reference, targets, range: where, solid: [where], dotted: [] };
  }
  if (current && current.pythonLines.has(position.line)) return null;

  // a modifier, the language or a flag of a definition line (`internal css[x] ...`):
  // where that entry is declared
  // the name of an entry where it is declared (`language css`): that entry itself
  const own = current && document.languageId === 'def-lang' && lib.entryOn(current, position.line);
  if (own) {
    const start = line.indexOf(own.name, own.kind.length);
    if (position.character < start || position.character >= start + own.name.length) return null;
    const where = new vscode.Range(position.line, start, position.line, start + own.name.length);
    return { all, html: { kind: own.kind, value: own.name }, targets: [{ file: current.file, line: position.line, label: 'the ' + own.kind }], range: where, solid: [where], dotted: [] };
  }
  const entry = document.languageId === 'def-lang' && lib.kernelWordAt(line, position.character, kernel);
  if (entry) {
    const declared = lib.findEntry(entry.kind, entry.name, all);
    if (!declared) return null;
    const where = new vscode.Range(position.line, entry.start, position.line, entry.end);
    return { all, html: { kind: entry.kind, value: entry.name }, targets: [{ ...declared, label: 'the ' + entry.kind }], range: where, solid: [where], dotted: [] };
  }

  const range = (start, end) => new vscode.Range(position.line, shift + start, position.line, shift + end);
  // only the defs of the files this file's program uses, like the engine
  const visible = lib.visibleIndexes(document.uri.fsPath, all);
  // where files define the same phrase: the one in the line's scope (`in the scope of …`)
  const scope = lib.scopeAt(current, position.line);
  const hits = lib.findDefinitions(text, position.character - shift, visible, scope);
  if (hits.length) {
    const order = lib.defOrder(lib.orderStarts(document.uri.fsPath), all);
    const structure = lib.structureAt(text, position.character - shift, visible, order, scope);
    const spans = list => list.map(([start, end]) => range(start, end));
    return {
      all, hits, range: range(...hits[0].range),
      solid: structure ? spans(structure.keywords) : [range(...hits[0].range)],
      dotted: structure ? spans(structure.parts) : [],
    };
  }

  const word = lib.wordAt(text, position.character - shift);
  const found = word && lib.findVariable(word.text, document.uri.fsPath, visible, kernel);
  if (found) {
    const wordRange = range(word.start, word.start + word.text.length);
    return { all, found, name: word.text, range: wordRange, solid: [wordRange], dotted: [] };
  }
  // words that fill a phrase's argument, and are no phrase or variable themselves
  // (`arguments` in `set arguments to as written`): that phrase, about those words
  const inside = lib.argumentAt(text, position.character - shift, visible, lib.defOrder(lib.orderStarts(document.uri.fsPath), all), scope);
  if (!inside) return null;
  const spans = list => list.map(([start, end]) => range(start, end));
  return {
    all, hits: [inside.hit], range: range(...inside.part), focus: text.slice(...inside.part).trim(),
    solid: spans(inside.structure.keywords), dotted: spans(inside.structure.parts),
  };
}

function lineRange(all, file, line) {
  return new vscode.Range(line, 0, line, all.find(i => i.file === file).lines[line].length);
}

// Any error in a provider goes to the panel instead of failing silently.
function logged(name, provide) {
  return async (...args) => {
    try { return await provide(...args); } catch (error) { log.appendLine(`${name} failed: ${error && error.stack || error}`); return undefined; }
  };
}

// A definition in a hover: its description, its examples (input → result), only its
// def line(s) (the body is a Ctrl+click away), and a link to it.
function describe(text, index, line, all = null, focus = null) {
  const description = lib.splitDescription(lib.descriptionOf(index, line));
  let lines = description.text ? description.text.split('\n') : [];
  // hovering words that fill an argument: the lines about them first, in bold
  if (focus) {
    const words = focus.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    const edge = '(?![\\p{L}\\p{N}_-])';
    // the line that starts with them (a row of a table), else one with them in backticks, else any
    const tiers = [new RegExp('^' + words + edge, 'u'), new RegExp('`' + words + '`', 'u'),
      new RegExp('(?<![\\p{L}\\p{N}_-])' + words + edge, 'u')];
    const tier = tiers.find(about => lines.some(l => about.test(l.trim())));
    const lead = tier ? lines.filter(l => tier.test(l.trim())) : [];
    if (lead.length) {
      text.appendMarkdown(lead.map(l => '**' + l.trim() + '**').join('  \n') + '\n\n');
      lines = lines.filter(l => !lead.includes(l));
    }
  }
  // each comment line is its own line in the hover
  if (lines.length) text.appendMarkdown(lines.join('  \n') + '\n\n');
  for (const example of description.examples) {
    text.appendCodeblock(example.result ? `${example.input}\n→ ${example.result}` : example.input, 'def-lang');
  }
  text.appendCodeblock(lib.headerOf(index, line), 'def-lang');
  text.appendMarkdown(where(index.file, line));
  // an entry that replaces another (`replaces FILE`), or is replaced
  if (all) {
    const { replaces, replacedBy } = lib.replacementsOf(index, line, all);
    if (replaces) text.appendMarkdown(`\n\nReplaces the one in ${where(replaces.file, replaces.line)}.`);
    for (const by of replacedBy) text.appendMarkdown(`\n\nReplaced in ${where(by.file, by.line)}: that one is used.`);
  }
}

function where(file, line) {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
  const name = folder ? require('path').relative(folder.uri.fsPath, file) : file;
  const target = vscode.Uri.file(file).with({ fragment: `L${line + 1}` });
  return `[${name}:${line + 1}](${target})`;
}

let extensionContext; // for what runs outside activate (installing, updating)

function activate(context) {
  setTimeout(() => watchFlags(context), 0);
  setTimeout(() => watchErrors(context), 0);
  registerCommands(context);
  serveBodies(context);
  extensionContext = context;
  setTimeout(() => startChecks(context), 5000);
  setTimeout(() => setUp(context), 2000);
  log = vscode.window.createOutputChannel('def-lang');
  context.subscriptions.push(log);
  moveFolderSetting();
  // the palette's colors for light and dark themes (palette.json, from make_palette.py),
  // unless a setting gives one color
  const palette = require('./palette.json').underline;
  const line = (setting, part) => {
    const value = vscode.workspace.getConfiguration('def-lang.underline').get(setting);
    // a theme color id like charts.yellow is the CSS variable --vscode-charts-yellow
    const css = color => color.startsWith('#') ? color : `var(--vscode-${color.replace(/\./g, '-')})`;
    const style = color => part === 'word'
      ? { borderStyle: 'none none solid none', borderWidth: '0 0 1px 0', borderColor: color }
      // arguments: 4px dashes with 5px gaps. VS Code has no option for dash spacing, so the
      // dashes are a background drawn through textDecoration (works, but isn't an official API)
      : { textDecoration: `none; background-image: linear-gradient(to right, ${color} 4px, transparent 4px); `
          + 'background-size: 9px 1px; background-repeat: repeat-x; background-position: left bottom' };
    if (value) return vscode.window.createTextEditorDecorationType(style(css(value)));
    return vscode.window.createTextEditorDecorationType({
      light: style(palette[part].light), dark: style(palette[part].dark),
    });
  };
  const makeLines = () => {
    clearUnderline();
    if (underline) underline.dispose();
    if (dotted) dotted.dispose();
    underline = line('wordColor', 'word');
    dotted = line('argumentColor', 'argument');
  };
  makeLines();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('def-lang.underline')) makeLines();
  }));
  context.subscriptions.push({ dispose: () => { underline.dispose(); dotted.dispose(); } });
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(clearUnderline),
    vscode.window.onDidChangeActiveTextEditor(clearUnderline),
    vscode.window.onDidChangeTextEditorVisibleRanges(clearUnderline),
    vscode.workspace.onDidChangeTextDocument(clearUnderline),
  );
  log.appendLine(`def-lang ${context.extension.packageJSON.version} started: Ctrl+click and hover are on`);
  const selector = { language: 'def-lang' };
  // .def files, and the {{ ... }} parts of HTML templates
  const withTemplates = [selector, { language: 'html' }];
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.def');
  const recolor = new vscode.EventEmitter();
  const forget = () => { cache = null; recolor.fire(); };
  context.subscriptions.push(recolor);
  watcher.onDidChange(forget);
  watcher.onDidCreate(forget);
  watcher.onDidDelete(forget);
  context.subscriptions.push(watcher);

  context.subscriptions.push(vscode.languages.registerDefinitionProvider(withTemplates, {
    provideDefinition: logged('Ctrl+click', async (document, position) => {
      const found = await lookup(document, position);
      if (!found) return undefined;
      // the whole phrase ("home page") is underlined, not just the word under the mouse
      const targets = found.html ? found.targets.map(t => [t.file, t.line])
        : found.hits ? found.hits.map(h => [h.file, h.line]) : [[found.found.file, found.found.line]];
      return targets.map(([file, line]) => {
        const target = lineRange(found.all, file, line);
        return { originSelectionRange: found.range, targetUri: vscode.Uri.file(file), targetRange: target, targetSelectionRange: target };
      });
    }),
  }));

  context.subscriptions.push(vscode.languages.registerHoverProvider(withTemplates, {
    provideHover: logged('hover', async (document, position) => {
      clearUnderline();
      // a flag or language on a definition line (`python[written]`): the entry that
      // declares it (lookup); else, for `python`, `def`, `written` and `regex`, a short help
      const all = document.languageId === 'def-lang' ? await indexes(document) : null;
      // a reserved word of an entry (`modifier`, `does in`, `words`, ...) or `use`: what it means
      const here = all && all.find(i => i.file === document.uri.fsPath);
      const reserved = here && lib.reservedWordAt(here, position.line, position.character);
      if (reserved) {
        const where = new vscode.Range(position.line, reserved.start, position.line, reserved.end);
        showUnderline(document, [where]);
        return new vscode.Hover(new vscode.MarkdownString(lib.RESERVED_HELP[reserved.word]), where);
      }
      const word = all && lib.kernelWordAt(document.lineAt(position.line).text, position.character, kernel);
      const help = word && !lib.findEntry(word.kind, word.name, all) &&
        (word.kind === 'flag' ? lib.FLAG_HELP : word.kind === 'language' ? lib.LANGUAGE_HELP : {})[word.name];
      if (help) {
        const where = new vscode.Range(position.line, word.start, position.line, word.end);
        showUnderline(document, [where]);
        return new vscode.Hover(new vscode.MarkdownString(help), where);
      }
      const found = await lookup(document, position);
      if (!found) return document.languageId === 'def-lang' ? embeddedHover(document, position) : undefined;
      const text = new vscode.MarkdownString();
      if (found.html) {
        // a def (a script, a view, a language, a {name} that is a def) is shown with its
        // description; a variable or an api line is shown as that line
        const isDef = target => ['puts in', 'the view', 'is the def', 'the language', 'the modifier', 'the flag'].includes(target.label);
        const intro = {
          field: `**${found.html.value}** is filled in from the api's answer, as text.`,
          api: `The api at **${found.html.value}**:`,
          def: `This element's content is the result of **${found.html.value}**:`,
        }[found.html.kind];
        if (intro) text.appendMarkdown(intro + '\n\n');
        found.targets.forEach((target, i) => {
          const index = found.all.find(x => x.file === target.file);
          if (found.html.kind === 'field') text.appendMarkdown(`${i ? '\n\n' : ''}It ${target.label}:\n\n`);
          if (isDef(target)) describe(text, index, target.line, found.all);
          else {
            text.appendCodeblock(index.lines[target.line].trim(), 'def-lang');
            text.appendMarkdown(where(target.file, target.line));
          }
        });
      } else if (found.hits) {
        found.hits.forEach((hit, i) => {
          if (i) text.appendMarkdown('\n\n---\n\n');
          describe(text, found.all.find(x => x.file === hit.file), hit.line, found.all, found.focus);
        });
      } else {
        const index = found.all.find(x => x.file === found.found.file);
        text.appendMarkdown(`**${found.name}** gets its first value here:\n\n`);
        text.appendCodeblock(index.lines[found.found.line].trim(), 'def-lang');
        text.appendMarkdown(where(found.found.file, found.found.line));
      }
      showUnderline(document, found.solid, found.dotted);
      return new vscode.Hover(text, found.range);
    }),
  }));

  // Color each def phrase as one item ("count the visit"), from the real defs,
  // on top of the grammar's colors.
  // def phrases are "function" (blue), your variables "variable" (yellow), lines that
  // start with a `comment is` marker "comment" (the grammar only knows //), and the
  // modifiers a library declares "keyword", like `shared`
  // phrases are "function", or "keyword" (a definition that keeps its arguments' words,
  // a statement, an alias) or "number" (a word list, like the number words), by their
  // definition; modifiers are "keyword" too
  const legend = new vscode.SemanticTokensLegend(['function', 'variable', 'comment', 'keyword', 'number'], []);
  context.subscriptions.push(vscode.languages.registerDocumentSemanticTokensProvider(selector, {
    onDidChangeSemanticTokens: recolor.event,
    provideDocumentSemanticTokens: logged('colors', async document => {
      const all = await indexes(document);
      const current = all.find(i => i.file === document.uri.fsPath);
      const tokens = new vscode.SemanticTokensBuilder(legend);
      // only the defs and variables of the files this file's program uses, like the engine
      const visible = lib.visibleIndexes(document.uri.fsPath, all);
      const names = lib.variableNames(visible, kernel);
      for (let n = 0; n < document.lineCount; n++) {
        const line = document.lineAt(n).text;
        // in a view's HTML, {name} is a variable
        if (current.htmlLines.has(n)) {
          for (const m of line.matchAll(/\{(\w+)\}/g)) tokens.push(n, m.index + 1, m[1].length, 1, 0);
          continue;
        }
        if (lib.isComment(current, n)) {
          const start = line.length - line.trimStart().length;
          tokens.push(n, start, line.trimEnd().length - start, 2, 0);
          continue;
        }
        // modifiers at the start of a line (`internal def ...`, `shared visits is 0`)
        let after = 0;
        for (;;) {
          const word = lib.kernelWordAt(line, after, kernel);
          if (!word || word.kind !== 'modifier' || word.start !== after) break;
          tokens.push(n, word.start, word.end - word.start, 3, 0);
          const next = line.slice(word.end).search(/\S/);
          after = next < 0 ? line.length : word.end + next;
        }
        // definition lines, entries and `use` lines are colored by the grammar; Python
        // bodies by Python; everything else from the definitions (statements, aliases too)
        if (current.pythonLines.has(n) || current.definitionLines.has(n) || current.entryLines.has(n) || lib.entryOn(current, n) ||
          /^\s*use\s/.test(line)) continue;
        const phrases = lib.phrasesIn(line.slice(after), visible).map(([s, e, kind]) => [s + after, e + after, kind]);
        // a library's statement: its words colored like `use`
        const type = { function: 0, keyword: 3, number: 4 };
        const items = [...phrases.map(([s, e, kind]) => [s, e, type[kind]]),
          ...lib.variablesIn(line, names, phrases).filter(([s]) => s >= after).map(v => [...v, 1])];
        for (const [start, end, type] of items.sort((a, b) => a[0] - b[0])) tokens.push(n, start, end - start, type, 0);
      }
      return tokens.build();
    }),
  }, legend));

  // IntelliSense: def phrases (with tab stops for their arguments), variables,
  // statements, flags in the brackets after a language, an entry's fields, names after
  // `use`, and in Python bodies what `self` and the helpers give (lib.completionsAt)
  const KINDS = {
    statement: vscode.CompletionItemKind.Keyword, phrase: vscode.CompletionItemKind.Function,
    follow: vscode.CompletionItemKind.Operator, variable: vscode.CompletionItemKind.Variable,
    flag: vscode.CompletionItemKind.Keyword, language: vscode.CompletionItemKind.Module,
    import: vscode.CompletionItemKind.File, python: vscode.CompletionItemKind.Method,
  };
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(selector, {
    provideCompletionItems: logged('completions', async (document, position, token, completion) => {
      const all = await indexes(document);
      const current = all.find(i => i.file === document.uri.fsPath);
      if (!current) return [];
      const language = lib.bodyLanguageAt(current, position.line);
      // in def-lang, the extra trigger characters (for HTML and CSS) open nothing
      if (!language && completion.triggerCharacter && completion.triggerCharacter !== '.') return [];
      const theirs = language ? await embeddedCompletions(document, position, language, completion.triggerCharacter, current) : [];
      if (language && language !== 'python') return theirs;
      return theirs.concat(lib.completionsAt(current, position.line, position.character, all, kernel).map(found => {
        const made = new vscode.CompletionItem(found.label, KINDS[found.kind]);
        made.insertText = new vscode.SnippetString(found.insert);
        made.filterText = found.filter;
        made.sortText = found.sort + found.label;
        made.range = new vscode.Range(position.line, found.start, position.line, position.character);
        if (found.detail) made.detail = found.detail;
        if (found.documentation) made.documentation = new vscode.MarkdownString(found.documentation);
        return made;
      }));
    }),
  }, '.', '<', ':', '"', '/'));

  // Format Document (Shift+Alt+F, or on save with editor.formatOnSave): layout only
  // (lib.formatText), and each body in another language by VS Code's formatter for that
  // language (def-lang.formatBodies). The languages come from every file, like the colors.
  context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(selector, {
    provideDocumentFormattingEdits: logged('format', async document => {
      const all = await indexes(document);
      const text = document.getText();
      const formatted = vscode.workspace.getConfiguration('def-lang').get('formatBodies', true)
        ? await lib.formatTextWith(text, kernel, formatBody)
        : lib.formatText(text, kernel);
      if (formatted === text) return [];
      const whole = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
      return [vscode.TextEdit.replace(whole, formatted)];
    }),
  }));

  context.subscriptions.push(vscode.languages.registerDocumentLinkProvider(selector, {
    provideDocumentLinks(document) {
      const links = [];
      for (let n = 0; n < document.lineCount; n++) {
        for (const [start, end, target] of lib.findLinks(document.lineAt(n).text, document.uri.fsPath, kernel)) {
          links.push(new vscode.DocumentLink(new vscode.Range(n, start, n, end), vscode.Uri.file(target)));
        }
      }
      return links;
    },
  }));
}

// Warnings for flags a def probably needs (lib.flagWarnings), shown under the def line.
function watchFlags(context) {
  const diagnostics = vscode.languages.createDiagnosticCollection('def-lang');
  context.subscriptions.push(diagnostics);
  const timers = new Map();
  const check = logged('flag warnings', async document => {
    if (document.languageId !== 'def-lang') return;
    const all = await indexes(document);
    const current = all.find(i => i.file === document.uri.fsPath);
    if (!current) return;
    diagnostics.set(document.uri, lib.flagWarnings(current, all, kernel).map(w => {
      const range = new vscode.Range(w.line, 0, w.line, document.lineAt(w.line).text.length);
      const warning = new vscode.Diagnostic(range, w.message, vscode.DiagnosticSeverity.Warning);
      warning.source = 'def-lang';
      return warning;
    }));
  });
  // while typing: once it pauses for half a second
  const later = document => {
    clearTimeout(timers.get(document.uri.toString()));
    timers.set(document.uri.toString(), setTimeout(() => check(document), 500));
  };
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidSaveTextDocument(check),
    vscode.workspace.onDidChangeTextDocument(event => later(event.document)),
    vscode.workspace.onDidCloseTextDocument(document => diagnostics.delete(document.uri)),
  );
  vscode.workspace.textDocuments.forEach(check);
}

// Errors from the interpreter itself (`def-lang check`), which reads a program without
// running it: unknown names, files it can't find, Python syntax errors, ... An open
// file is checked as part of its program (its package's main.def), with its text as it
// is now, saved or not; a file its program doesn't use is checked on its own.
function watchErrors(context) {
  const diagnostics = vscode.languages.createDiagnosticCollection('def-lang errors');
  context.subscriptions.push(diagnostics);
  const timers = new Map();
  const latest = new Map(); // file -> number of its newest check, so an old answer is dropped
  const run = (target, file, text) => new Promise(resolve => {
    const env = interpreterEnv();
    const child = childProcess.execFile(pythonCommand(), ['-m', 'deflang', 'check', target, '--json', '--text', file],
      { env, cwd: lib.programFolder(file), timeout: 10000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
        try { resolve(JSON.parse(stdout)); } catch {
          log.appendLine(`check ${target} gave no answer${error ? ': ' + error.message : ''}`);
          resolve(null);
        }
      });
    child.stdin.end(text);
  });
  const check = logged('errors', async document => {
    if (document.languageId !== 'def-lang' || document.uri.scheme !== 'file') return;
    const file = document.uri.fsPath;
    const number = (latest.get(file) || 0) + 1;
    latest.set(file, number);
    // a file of a package is part of its program; a library's own files have no main.def
    const home = lib.packageFolder(file);
    const main = home ? pathNode.join(home, 'main.def') : null;
    let answer = await run(main && main !== file ? main : file, file, document.getText());
    if (answer && !answer.read.includes(file)) answer = await run(file, file, document.getText());
    if (!answer || latest.get(file) !== number) return;
    const byFile = new Map(answer.read.map(f => [f, []]));
    byFile.set(file, byFile.get(file) || []);
    for (const problem of answer.problems) {
      if (!byFile.has(problem.file)) byFile.set(problem.file, []);
      byFile.get(problem.file).push(problem);
    }
    for (const [f, problems] of byFile) {
      // only files open in the editor: the others' errors show when they are opened
      const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === f);
      if (!open) continue;
      diagnostics.set(open.uri, problems.map(problem => {
        const n = Math.min(problem.line - 1, open.lineCount - 1);
        const text = open.lineAt(n).text;
        const range = new vscode.Range(n, text.length - text.trimStart().length, n, text.length);
        const error = new vscode.Diagnostic(range, problem.message, vscode.DiagnosticSeverity.Error);
        error.source = 'def-lang';
        return error;
      }));
    }
  });
  const later = document => {
    clearTimeout(timers.get(document.uri.toString()));
    timers.set(document.uri.toString(), setTimeout(() => check(document), 500));
  };
  // a libraries.toml says where a program's libraries are: when one changes, the open
  // files are checked again, since what they `use` may be found, or lost, now. The
  // workspace's, and the ones next to an open file and in its program's folder (a
  // library outside the workspace, like a global one)
  const watched = new Set();
  const again = () => vscode.workspace.textDocuments.forEach(later);
  const watch = pattern => {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange(again);
    watcher.onDidCreate(again);
    watcher.onDidDelete(again);
    context.subscriptions.push(watcher);
  };
  watch('**/libraries.toml');
  const watchNear = document => {
    if (document.languageId !== 'def-lang' || document.uri.scheme !== 'file') return;
    for (const folder of [pathNode.dirname(document.uri.fsPath), lib.programFolder(document.uri.fsPath)]) {
      if (watched.has(folder)) continue;
      watched.add(folder);
      watch(new vscode.RelativePattern(folder, 'libraries.toml'));
    }
  };
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(document => { watchNear(document); check(document); }),
    vscode.workspace.onDidSaveTextDocument(check),
    vscode.workspace.onDidChangeTextDocument(event => later(event.document)),
    vscode.workspace.onDidCloseTextDocument(document => diagnostics.delete(document.uri)),
  );
  vscode.workspace.textDocuments.forEach(document => { watchNear(document); check(document); });
}

// ---- running programs and installing libraries, with your own def-lang interpreter
// (the folder that holds deflang: setting def-lang.interpreterFolder) and your own Python

const childProcess = require('child_process');
const fsNode = require('fs');
const pathNode = require('path');

function pythonCommand() {
  const setting = vscode.workspace.getConfiguration('def-lang').inspect('python');
  const chosen = setting.workspaceFolderValue ?? setting.workspaceValue ?? setting.globalValue;
  if (chosen) return chosen;
  // left at its default (python3): the alias's Python, else python3 (python on Windows)
  return (fromAlias() || {}).python || (process.platform === 'win32' ? 'python' : 'python3');
}

// The `def-lang` alias of your shell, as the def-lang guide sets it up:
//   alias def-lang='PYTHONPATH=FOLDER python3 -m deflang'
// gives { folder, python }. The shell is asked once (it reads ~/.bashrc or ~/.zshrc);
// a change to the alias counts after "Reload Window". null: no alias.
let aliasFound;
function fromAlias() {
  if (aliasFound !== undefined) return aliasFound;
  aliasFound = null;
  if (process.platform === 'win32') return null;
  const shell = process.env.SHELL || '/bin/bash';
  const asked = childProcess.spawnSync(shell, ['-ic', 'alias def-lang'], { encoding: 'utf8', timeout: 2000 });
  // bash prints  alias def-lang='...';  zsh prints  def-lang='...'
  const m = /def-lang=(['"])([\s\S]*?)\1\s*$/m.exec(asked.stdout || '');
  if (!m) return null;
  const words = m[2].replace(/'\\''/g, "'");
  const folder = /PYTHONPATH=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(words);
  const python = /(?:^|\s)(\S*python[\d.]*)\s+-m\s+deflang\b/.exec(words);
  aliasFound = { folder: folder ? expandPath(folder[1] ?? folder[2] ?? folder[3]) : '', python: python ? python[1] : '' };
  log.appendLine(`the def-lang alias: folder ${aliasFound.folder || '(none)'}, python ${aliasFound.python || '(none)'}`);
  return aliasFound;
}

// ~, $HOME, ${HOME} and other $VARIABLES in a path, the way the shell would read them.
function expandPath(text) {
  const home = require('os').homedir();
  return text.replace(/^~(?=$|[\/])/, home)
    .replace(/\$\{(\w+)\}|\$(\w+)/g, (all, a, b) => (a || b) === 'HOME' ? home : (process.env[a || b] ?? all));
}

// The folder that holds deflang: the def-lang.interpreterFolder setting (or the old
// def-lang.folder, until it has moved), else the folder of the `def-lang` alias; empty:
// deflang is installed (pip, pipx).
function deflangFolder() {
  const config = vscode.workspace.getConfiguration('def-lang');
  const chosen = config.get('interpreterFolder') || config.get('folder') || '';
  if (chosen) return expandPath(chosen);
  return (fromAlias() || {}).folder || '';
}

// def-lang.folder is now def-lang.interpreterFolder (0.39.0): its value moves over, in
// the same place (user or workspace settings), and the old one is removed.
async function moveFolderSetting() {
  const config = vscode.workspace.getConfiguration('def-lang');
  const old = config.inspect('folder') || {};
  const now = config.inspect('interpreterFolder') || {};
  for (const [key, target] of [['globalValue', vscode.ConfigurationTarget.Global], ['workspaceValue', vscode.ConfigurationTarget.Workspace]]) {
    if (old[key] === undefined) continue;
    try {
      if (now[key] === undefined) await config.update('interpreterFolder', old[key], target);
      await config.update('folder', undefined, target);
      log.appendLine(`def-lang.folder moved to def-lang.interpreterFolder: ${old[key]}`);
    } catch (error) {
      log.appendLine(`def-lang.folder couldn't be moved: ${error.message}`);
    }
  }
}

// The environment that runs `python -m deflang`: that folder on PYTHONPATH.
function interpreterEnv() {
  const separator = process.platform === 'win32' ? ';' : ':';
  return { ...process.env, PYTHONPATH: [deflangFolder(), process.env.PYTHONPATH].filter(Boolean).join(separator) };
}

// Whether that Python can run def-lang (3.11 or newer, and deflang found); says what to do if not.
function pythonIsReady() {
  const python = pythonCommand();
  const found = childProcess.spawnSync(python, ['-c', 'import sys; print(sys.version_info >= (3, 11))'], { encoding: 'utf8' });
  if (found.error || found.status !== 0) {
    vscode.window.showErrorMessage(`def-lang needs Python 3.11 or newer, and "${python}" wasn't found. Install it from python.org, or set "def-lang.python" to the Python you have.`);
    return false;
  }
  if (found.stdout.trim() !== 'True') {
    vscode.window.showErrorMessage(`def-lang needs Python 3.11 or newer; "${python}" is older. Set "def-lang.python" to a newer one.`);
    return false;
  }
  const deflang = childProcess.spawnSync(python, ['-c', 'import deflang'], { encoding: 'utf8', env: interpreterEnv() });
  if (deflang.status !== 0) {
    const folder = deflangFolder();
    const install = 'Install', choose = 'I have it: choose its folder…', setting = 'Open setting';
    vscode.window.showErrorMessage(folder
      ? `The def-lang interpreter isn't in ${folder}.`
      : 'The def-lang interpreter isn\'t installed.', install, choose, setting).then(choice => {
      if (choice === install) vscode.commands.executeCommand('def-lang.installInterpreter');
      else if (choice === choose) chooseInterpreterFolder();
      else if (choice === setting) vscode.commands.executeCommand('workbench.action.openSettings', 'def-lang.interpreterFolder');
    });
    return false;
  }
  return true;
}

// ---- installing the interpreter: git clone (or GitHub's zip, without git), then
// def-lang.interpreterFolder, and if you want the `def-lang` alias in your shell's startup file

const DEFLANG_REPO = 'https://github.com/Pedram-A-Keyvani/deflang.git';
const DEFLANG_ZIP = 'https://github.com/Pedram-A-Keyvani/deflang/archive/refs/heads/main.zip';

// Python that puts GitHub's zip of deflang at sys.argv[1] (FOLDER/deflang), replacing what is there.
const UNZIP = [
  'import io, shutil, sys, urllib.request, zipfile, pathlib',
  'target = pathlib.Path(sys.argv[1])',
  'data = urllib.request.urlopen(sys.argv[2], timeout=60).read()',
  'new = target.with_name(target.name + ".new")',
  'shutil.rmtree(new, ignore_errors=True)',
  'zipfile.ZipFile(io.BytesIO(data)).extractall(new)',
  'inner = next(new.iterdir())',
  'shutil.rmtree(target, ignore_errors=True)',
  'inner.rename(target)',
  'shutil.rmtree(new)',
].join('\n');

function runQuietly(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(command, args, { timeout: 120000, ...options }, (error, stdout, stderr) =>
      error ? reject(new Error((stderr || error.message).trim().split('\n').pop())) : resolve(stdout));
  });
}

const hasGit = () => !childProcess.spawnSync('git', ['--version']).error;

// `I have it`: the user picks their deflang folder; def-lang.interpreterFolder becomes the folder that holds it.
async function chooseInterpreterFolder() {
  const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'This is the deflang folder' });
  if (!picked || !picked.length) return;
  const deflang = picked[0].fsPath;
  if (!fsNode.existsSync(pathNode.join(deflang, '__main__.py')) || pathNode.basename(deflang) !== 'deflang') {
    return vscode.window.showErrorMessage(`${deflang} isn't the def-lang interpreter: pick the folder named deflang (with __main__.py in it).`);
  }
  await finishSetUp(pathNode.dirname(deflang), true);
}

async function installInterpreter() {
  // Python first: def-lang needs 3.11 or newer, and the zip download needs it too
  const python = pythonCommand();
  const version = childProcess.spawnSync(python, ['-c', 'import sys; print(sys.version_info >= (3, 11))'], { encoding: 'utf8' });
  if (version.error || version.stdout.trim() !== 'True') {
    return vscode.window.showErrorMessage(`def-lang needs Python 3.11 or newer, and "${python}" isn't. Install it from python.org, or set "def-lang.python".`);
  }
  const home = require('os').homedir();
  let folder = deflangFolder();
  const present = folder && fsNode.existsSync(pathNode.join(folder, 'deflang', '__main__.py'));
  if (!present) {
    const where = await vscode.window.showQuickPick([
      { label: '~/.def-lang', description: 'next to the global libraries (recommended)', folder: pathNode.join(home, '.def-lang') },
      { label: 'Choose a folder…', folder: null },
    ], { placeHolder: 'Install the def-lang interpreter in FOLDER/deflang' });
    if (!where) return;
    folder = where.folder;
    if (!folder) {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Install deflang in here' });
      if (!picked || !picked.length) return;
      folder = picked[0].fsPath;
    }
  }
  const target = pathNode.join(folder, 'deflang');
  // one that is there already, installed by the extension: updated like at every start
  if (present && installedInterpreter(extensionContext) === target) return updateInterpreter(extensionContext, false);
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: present ? 'Updating def-lang' : 'Installing def-lang' }, async () => {
      fsNode.mkdirSync(folder, { recursive: true });
      if (present && fsNode.existsSync(pathNode.join(target, '.git')) && hasGit()) {
        await runQuietly('git', ['-C', target, 'pull', '--ff-only', '--quiet']);
      } else if (!present && hasGit()) {
        await runQuietly('git', ['clone', '--quiet', DEFLANG_REPO, target]);
      } else {
        const commit = await latestCommit().catch(() => null);
        await runQuietly(python, ['-c', UNZIP, target, DEFLANG_ZIP]);
        if (commit) extensionContext.globalState.update('def-lang.installedCommit', commit);
      }
      if (!present) extensionContext.globalState.update('def-lang.installedInterpreter', target);
      const env = { ...process.env, PYTHONPATH: [folder, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':') };
      await runQuietly(python, ['-c', 'import deflang.execute'], { env });
    });
  } catch (error) {
    return vscode.window.showErrorMessage(`def-lang wasn't ${present ? 'updated' : 'installed'}: ${error.message}`);
  }
  if (present) return vscode.window.showInformationMessage(`def-lang is updated in ${target}.`);
  await finishSetUp(folder, true);
}

// Setting up, at the first start and whenever the interpreter isn't found: find it (the
// setting, the alias, or an installed deflang); if it's found in a folder, fill in
// def-lang.interpreterFolder and add the `def-lang` alias to the shell's startup file, without asking.
// If it isn't found, say so once, with Install and "I have it".
async function setUp(context) {
  const python = pythonCommand();
  const works = folder => childProcess.spawnSync(python, ['-c', 'import deflang'],
    { env: { ...process.env, PYTHONPATH: [folder, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':') } }).status === 0;
  const folder = deflangFolder();
  if (folder && works(folder)) return finishSetUp(folder, false);
  if (!folder && works('')) return; // installed with pip or pipx: nothing to fill in
  const version = context.extension.packageJSON.version;
  if (!shouldAskSetUp(context.globalState.get('def-lang.dontAskSetUp'), version)) return;
  const install = 'Install', choose = 'I have it: choose its folder…', never = "Don't ask again";
  const choice = await vscode.window.showInformationMessage('def-lang: to run programs and check them, the extension needs the def-lang interpreter.', install, choose, 'Not now', never);
  if (choice === install) vscode.commands.executeCommand('def-lang.installInterpreter');
  else if (choice === choose) chooseInterpreterFolder();
  else if (choice === never) context.globalState.update('def-lang.dontAskSetUp', version);
}

// Whether to ask for the interpreter at this start: always, unless "Don't ask again" was
// chosen with this very version (a new version, from an update or a reinstall, asks again).
function shouldAskSetUp(dontAskVersion, version) {
  return dontAskVersion !== version;
}

// The interpreter is in FOLDER/deflang: def-lang.interpreterFolder says so (if it's empty), and
// the `def-lang` alias is added if there is none. One message for what changed.
async function finishSetUp(folder, announce) {
  const home = require('os').homedir();
  const done = [];
  const config = vscode.workspace.getConfiguration('def-lang');
  const shown = folder.startsWith(home + pathNode.sep) ? '~' + folder.slice(home.length) : folder;
  if (announce || !config.get('interpreterFolder')) {
    if (config.get('interpreterFolder') !== shown) {
      await config.update('interpreterFolder', shown, vscode.ConfigurationTarget.Global);
      done.push(`the interpreter in ${shown}/deflang`);
    }
  }
  const rc = addAlias(folder, pythonCommand());
  if (rc) done.push(`the def-lang command added to ${rc} (open a new terminal to use it)`);
  aliasFound = undefined;
  if (done.length || announce) vscode.window.showInformationMessage('def-lang is set up: ' + (done.join('; ') || `the interpreter in ${shown}/deflang`) + '.');
}

// Adds `alias def-lang='PYTHONPATH=FOLDER python3 -m deflang'` to the shell's startup file,
// so `def-lang` works in the terminal too, unless a def-lang alias is there already.
// The file's name (like ~/.bashrc), or null when nothing was added.
function addAlias(folder, python) {
  if (process.platform === 'win32') return null;
  const home = require('os').homedir();
  const rc = pathNode.join(home, (process.env.SHELL || '').endsWith('zsh') ? '.zshrc' : '.bashrc');
  let text = '';
  try { text = fsNode.readFileSync(rc, 'utf8'); } catch {}
  if (/^\s*alias\s+def-lang=/m.test(text)) return null;
  const where = folder.startsWith(home + pathNode.sep) ? '$HOME' + folder.slice(home.length) : folder;
  fsNode.appendFileSync(rc, `${text.endsWith('\n') || !text ? '' : '\n'}\n# def-lang (added by the def-lang extension for VS Code)\nalias def-lang='PYTHONPATH=${where} ${python} -m deflang'\n`);
  return '~' + rc.slice(home.length);
}

const quote = text => '"' + text.replace(/(["\\$`])/g, '\\$1') + '"';

// A terminal that runs your def-lang interpreter; one per name, a new run replaces it.
function terminal(context, name, cwd) {
  for (const old of vscode.window.terminals) if (old.name === name) old.dispose();
  const made = vscode.window.createTerminal({ name, cwd, env: { PYTHONPATH: interpreterEnv().PYTHONPATH } });
  made.show();
  return made;
}

// The program of the open file, or the first workspace folder.
function currentProgram() {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') return lib.programFolder(editor.document.uri.fsPath);
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  return folder ? folder.uri.fsPath : null;
}

function registerCommands(context) {
  context.subscriptions.push(vscode.commands.registerCommand('def-lang.run', logged('run', async uri => {
    const file = (uri && uri.fsPath) || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.fsPath);
    if (!file || !file.endsWith('.def')) return vscode.window.showInformationMessage('Open a .def file to run it.');
    const document = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file);
    if (document && document.isDirty) await document.save();
    if (!pythonIsReady()) return;
    // a file of a package runs the package (its main.def); a library's file isn't a program
    const home = lib.packageFolder(file);
    const target = home && !fsNode.existsSync(pathNode.join(home, 'library.toml')) ? home : file;
    terminal(context, 'def-lang: ' + pathNode.basename(target), lib.programFolder(file))
      .sendText(`${pythonCommand()} -m deflang run ${quote(target)}`);
  })));

  context.subscriptions.push(vscode.commands.registerCommand('def-lang.checkForUpdates', logged('check for updates', () => checkForUpdates(context, true))));
  context.subscriptions.push(vscode.commands.registerCommand('def-lang.installInterpreter', logged('install interpreter', installInterpreter)));
  context.subscriptions.push(vscode.commands.registerCommand('def-lang.console', logged('console', async () => {
    if (!pythonIsReady()) return;
    terminal(context, 'def-lang console', currentProgram() || undefined).sendText(`${pythonCommand()} -m deflang`);
  })));

  context.subscriptions.push(vscode.commands.registerCommand('def-lang.installLibrary', logged('install', async () => {
    const program = currentProgram();
    if (!program) return vscode.window.showInformationMessage('Open a program folder first.');
    const from = await vscode.window.showQuickPick([
      { label: 'From a git repository…', description: 'URL#folder, like https://example.com/libs.git#web', kind: 'git' },
      { label: 'A local library…', description: 'a folder of this project (with a library.toml), used where it is', kind: 'folder' },
    ], { placeHolder: `Install a library into ${program}` });
    if (!from) return;
    let source;
    let flag = '';
    if (from.kind === 'folder') {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, defaultUri: vscode.Uri.file(program), openLabel: 'Use this library' });
      if (!picked || !picked.length) return;
      source = picked[0].fsPath;
      flag = ' --link'; // a local library is never copied
    } else {
      source = await vscode.window.showInputBox({ prompt: 'Git URL of the library, with #folder if it is in one', placeHolder: 'https://example.com/libs.git#web' });
      if (!source) return;
      const where = await vscode.window.showQuickPick([
        { label: 'Into this project', description: 'a copy in libraries/ (git leaves it out)', flag: '' },
        { label: 'Global', description: 'one copy for every program, by version', flag: ' --global' },
      ]);
      if (!where) return;
      flag = where.flag;
    }
    if (!pythonIsReady()) return;
    terminal(context, 'def-lang install', program)
      .sendText(`${pythonCommand()} -m deflang install ${quote(source)}${flag} --into ${quote(program)}`);
  })));
}

function deactivate() {}

module.exports = { activate, deactivate };

// ---- updates: VS Code only updates extensions from the Marketplace, so this one looks
// at its own GitHub releases: at most once a day (or when asked), and only GitHub sees it

const RELEASES = 'https://api.github.com/repos/Pedram-A-Keyvani/deflang-editor/releases/latest';
const DAY = 24 * 60 * 60 * 1000;

// GET a URL, following redirects (a release's file is served from another host): a Buffer.
function download(url, redirects = 5) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'def-lang-vscode', Accept: 'application/vnd.github+json, application/octet-stream' }, timeout: 15000 }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects > 0) {
        response.resume();
        return resolve(download(new URL(response.headers.location, url).toString(), redirects - 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(response.statusCode === 404 ? 'no release yet' : `GitHub answered ${response.statusCode}`));
      }
      const parts = [];
      response.on('data', part => parts.push(part));
      response.on('end', () => resolve(Buffer.concat(parts)));
    });
    request.on('timeout', () => request.destroy(new Error('GitHub did not answer')));
    request.on('error', reject);
  });
}

// Whether version a (like "0.31.0", or "v0.31.0") is newer than b.
function isNewer(a, b) {
  const parts = v => String(v).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

// At start: the interpreter and the extension are checked once a day, and at once after
// the extension was installed or updated (a version that hasn't run here before).
async function startChecks(context) {
  const mine = context.extension.packageJSON.version;
  const newHere = context.globalState.get('def-lang.lastVersion') !== mine;
  context.globalState.update('def-lang.lastVersion', mine);
  if (!vscode.workspace.getConfiguration('def-lang').get('checkForUpdates', true)) return;
  if (!newHere && Date.now() - context.globalState.get('def-lang.lastUpdateCheck', 0) < DAY) return;
  context.globalState.update('def-lang.lastUpdateCheck', Date.now());
  await updateInterpreter(context, true);
  await checkForUpdates(context, false);
}

async function checkForUpdates(context, asked) {
  const settings = vscode.workspace.getConfiguration('def-lang');
  context.globalState.update('def-lang.lastUpdateCheck', Date.now());
  const mine = context.extension.packageJSON.version;
  let release;
  try {
    release = JSON.parse((await download(RELEASES)).toString('utf8'));
  } catch (error) {
    log.appendLine(`no update check: ${error.message}`);
    if (asked) vscode.window.showWarningMessage(`def-lang couldn't look for updates: ${error.message}.`);
    return;
  }
  const latest = String(release.tag_name || '').replace(/^v/, '');
  const asset = (release.assets || []).find(a => a.name.endsWith('.vsix'));
  if (!latest || !asset || !isNewer(latest, mine)) {
    if (asked) vscode.window.showInformationMessage(`def-lang ${mine} is the latest.`);
    return;
  }
  const update = 'Update', never = "Don't ask again";
  const choice = await vscode.window.showInformationMessage(`def-lang ${latest} is out (you have ${mine}).`, update, 'Not now', never);
  if (choice === never) return settings.update('checkForUpdates', false, vscode.ConfigurationTarget.Global);
  if (choice !== update) return;
  try {
    const file = pathNode.join(require('os').tmpdir(), asset.name);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Updating def-lang to ${latest}` }, async () => {
      fsNode.writeFileSync(file, await download(asset.browser_download_url));
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
    });
    const reload = 'Reload Window';
    if (await vscode.window.showInformationMessage(`def-lang ${latest} is installed: reload the window to use it.`, reload) === reload) {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } catch (error) {
    vscode.window.showErrorMessage(`def-lang wasn't updated: ${error.message}`);
  }
}

// ---- formatting a body in another language with VS Code's own formatter for it

// A def-lang language's VS Code language id: its entry's `editor` field (`python` is VS
// Code's own); and the file extension VS Code gives that language, for a body's document
const languageId = language => (kernel && kernel.editors.get(language)) || language;
function extensionOf(id) {
  for (const extension of vscode.extensions.all) {
    for (const language of ((extension.packageJSON || {}).contributes || {}).languages || []) {
      if (language.id === id && (language.extensions || []).length) return language.extensions[0].replace(/^\./, '');
    }
  }
  return 'txt';
}

// Bodies being formatted, served read-only at def-lang-body:/N.EXT: a document there is
// never an editor tab, can't be saved, and VS Code drops it when it's done.
const BODY_SCHEME = 'def-lang-body';
const bodies = new Map();
let bodyCount = 0;

function serveBodies(context) {
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(BODY_SCHEME, {
    provideTextDocumentContent: uri => bodies.get(uri.path) || '',
  }));
}

// The body's text formatted by the formatter VS Code has for its language, from column 0;
// null when there is none, or it changed nothing.
async function formatBody(language, text, indent) {
  const id = languageId(language);
  const path = `/${++bodyCount}.${extensionOf(id)}`;
  bodies.set(path, text);
  try {
    let document = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: BODY_SCHEME, path }));
    if (document.languageId !== id) document = await vscode.languages.setTextDocumentLanguage(document, id);
    const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', document.uri, { tabSize: indent, insertSpaces: true });
    if (!edits || !edits.length) return null;
    // apply the edits, last first, so the earlier offsets stay right
    let result = text;
    for (const edit of [...edits].sort((a, b) => document.offsetAt(b.range.start) - document.offsetAt(a.range.start))) {
      result = result.slice(0, document.offsetAt(edit.range.start)) + edit.newText + result.slice(document.offsetAt(edit.range.end));
    }
    return result;
  } finally {
    bodies.delete(path);
  }
}

// ---- hover and IntelliSense inside a body in another language: VS Code's own, for that
// language. The body is served as a document at def-lang-body: (never shown, read-only):
// the whole file with everything outside the body as spaces, so every position is the
// same, and that language's providers are asked there.

async function embeddedDocument(document, position, language, index) {
  const lines = document.getText().split(/\r?\n/);
  // the body's own lines (not an entry's fields, above its `does`)
  const inBody = n => n >= 0 && n < lines.length && (index.pythonLines.has(n) || !lines[n].trim());
  let start = position.line, end = position.line;
  while (inBody(start - 1)) start--;
  while (inBody(end + 1)) end++;
  const content = lines.map((line, n) => (n >= start && n <= end ? line : ' '.repeat(line.length))).join('\n');
  const id = languageId(language);
  const path = `/${++bodyCount}.${extensionOf(id)}`;
  bodies.set(path, content);
  let embedded = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: BODY_SCHEME, path }));
  if (embedded.languageId !== id) embedded = await vscode.languages.setTextDocumentLanguage(embedded, id);
  return { embedded, done: () => bodies.delete(path) };
}

async function embeddedHover(document, position) {
  const all = await indexes(document);
  const current = all.find(i => i.file === document.uri.fsPath);
  const language = current && lib.bodyLanguageAt(current, position.line);
  if (!language) return undefined;
  const { embedded, done } = await embeddedDocument(document, position, language, current);
  try {
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', embedded.uri, position);
    if (!hovers || !hovers.length) return undefined;
    return new vscode.Hover(hovers.flatMap(hover => hover.contents), hovers.find(hover => hover.range)?.range);
  } finally {
    done();
  }
}

async function embeddedCompletions(document, position, language, trigger, index) {
  const { embedded, done } = await embeddedDocument(document, position, language, index);
  try {
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', embedded.uri, position, trigger);
    return list ? list.items : [];
  } finally {
    done();
  }
}

// ---- keeping the interpreter the extension installed up to date (never one you set up
// yourself, like a working copy of deflang)

const COMMITS = 'https://api.github.com/repos/Pedram-A-Keyvani/deflang/commits/main';

async function latestCommit() {
  return JSON.parse((await download(COMMITS)).toString('utf8')).sha.slice(0, 7);
}

// The deflang folder the extension installed: as it remembers it, or ~/.def-lang/deflang
// (where earlier versions installed it, before they remembered); null if none.
function installedInterpreter(context) {
  const remembered = context.globalState.get('def-lang.installedInterpreter');
  const earlier = pathNode.join(require('os').homedir(), '.def-lang', 'deflang');
  const target = remembered || earlier;
  return fsNode.existsSync(pathNode.join(target, '__main__.py')) ? target : null;
}

// Brings the extension's interpreter up to date: a git clone fast-forwards to GitHub's, a
// zip install is downloaded again when GitHub has a newer commit. Only the one in use.
async function updateInterpreter(context, quiet) {
  const target = installedInterpreter(context);
  const folder = deflangFolder();
  if (!target || !folder || pathNode.resolve(folder) !== pathNode.dirname(target)) {
    if (!quiet) vscode.window.showInformationMessage('The interpreter in use was set up by you, not installed by the extension: update it yourself (git pull).');
    return;
  }
  const say = text => vscode.window.showInformationMessage(text);
  try {
    if (fsNode.existsSync(pathNode.join(target, '.git')) && hasGit()) {
      const git = (...args) => runQuietly('git', ['-C', target, ...args]).then(out => out.trim());
      await git('fetch', '--quiet');
      const [head, upstream] = [await git('rev-parse', '--short', 'HEAD'), await git('rev-parse', '--short', '@{u}')];
      if (head === upstream) return quiet ? undefined : say(`def-lang's interpreter is up to date (${head}).`);
      if (await git('status', '--porcelain', '--untracked-files=no')) {
        return vscode.window.showWarningMessage(`def-lang's interpreter in ${target} has changes of its own, so it isn't updated (${head}; GitHub has ${upstream}).`);
      }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Updating def-lang' },
        () => git('merge', '--ff-only', '--quiet', '@{u}'));
      say(`def-lang's interpreter is updated: ${head} → ${upstream}.`);
    } else {
      const latest = await latestCommit();
      const mine = context.globalState.get('def-lang.installedCommit');
      if (mine === latest) return quiet ? undefined : say(`def-lang's interpreter is up to date (${latest}).`);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Updating def-lang' },
        () => runQuietly(pythonCommand(), ['-c', UNZIP, target, DEFLANG_ZIP]));
      context.globalState.update('def-lang.installedCommit', latest);
      say(`def-lang's interpreter is updated${mine ? `: ${mine} → ${latest}` : ` (${latest})`}.`);
    }
  } catch (error) {
    log.appendLine(`interpreter not updated: ${error.message}`);
    if (!quiet) vscode.window.showWarningMessage(`def-lang's interpreter wasn't updated: ${error.message}`);
  }
}
