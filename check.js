// Checks lib.js against real .def files: the libraries (deflang-lib) and the samples
// (deflang-sample), next to this repo, or where $DEFLANG_LIB and $DEFLANG_SAMPLE say.
// Run without Node installed, using VS Code's:
//   ELECTRON_RUN_AS_NODE=1 code check.js
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const LIB = path.resolve(process.env.DEFLANG_LIB || path.join(__dirname, '..', 'deflang-lib'));
const SAMPLE = path.resolve(process.env.DEFLANG_SAMPLE || path.join(__dirname, '..', 'deflang-sample'));
for (const [name, folder] of [['DEFLANG_LIB', LIB], ['DEFLANG_SAMPLE', SAMPLE]]) {
  if (!fs.existsSync(folder)) { console.log(`no ${folder}: put it next to this repo, or set ${name}`); process.exit(2); }
}
// the samples install their libraries globally: unless $DEFLANG_GLOBAL says where, a
// global folder of links to LIB's libraries stands in, so the checks run on LIB
if (!process.env.DEFLANG_GLOBAL) {
  const os = require('os');
  const global = fs.mkdtempSync(path.join(os.tmpdir(), 'deflang-global-'));
  (function find(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) find(path.join(dir, entry.name));
      else if (entry.name === 'library.toml') {
        const text = fs.readFileSync(path.join(dir, entry.name), 'utf8');
        const name = /^name\s*=\s*"([^"]+)"/m.exec(text), version = /^version\s*=\s*"([^"]+)"/m.exec(text);
        if (!name || !version) continue;
        fs.mkdirSync(path.join(global, name[1]), { recursive: true });
        fs.symlinkSync(dir, path.join(global, name[1], version[1]), 'dir');
      }
    }
  })(LIB);
  process.env.DEFLANG_GLOBAL = global;
  process.on('exit', () => fs.rmSync(global, { recursive: true, force: true }));
}
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // a sample's libraries/ holds installed copies: the libraries are read from LIB
    if (entry.isDirectory() && !entry.name.startsWith('.') && !['node_modules', 'libraries'].includes(entry.name)) walk(full);
    else if (entry.name.endsWith('.def')) files.push(full);
  }
}
walk(LIB);
walk(SAMPLE);
// languages (`language NAME`) are read from all files first, like the extension does
const fileTexts = files.map(f => [f, fs.readFileSync(f, 'utf8')]);
const languages = lib.languageNames(fileTexts.map(([, text]) => text));
const indexes = fileTexts.map(([f, text]) => lib.indexText(f, text, languages));
// a file's path in its repo: core/values.def, website/main.def
const rel = f => path.relative(f.startsWith(LIB + path.sep) ? LIB : SAMPLE, f);

let failed = 0;
function expect(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : `\n     got ${JSON.stringify(actual)}\n     expected ${JSON.stringify(expected)}`));
}
// where Ctrl+click on `word` in `line` goes: "file:line-text"
function click(line, word, nth = 0) {
  let column = -1;
  for (let i = 0; i <= nth; i++) column = line.indexOf(word, column + 1);
  return lib.findDefinitions(line, column, indexes).map(h => rel(h.file) + ': ' + h.text);
}

expect('squared', click('x is 3 squared', 'squared'), ['core/math.def: def A0 squared']);
expect('+ symbol', click('x is 2 + 3', '+'), ['core/math.def: def python A0 + A1']);
expect('is (assignment)', click('x is 2 + 3', 'is'), ['core/values.def: def python as written A0 is A1']);
expect('longest phrase wins', click('is x between 1 and 10?', 'between'), ['core/comparison.def: def A0 between A1 and A2']);
expect('means line', click('x greater than 3', 'greater'), ['core/comparison.def: greater than means >']);
expect('longer means wins', click('x is less than or equal to 3', 'equal'), ['core/comparison.def: is less than or equal to means <=']);
expect('package def', click('api "/api/visit" runs count the visit and sends visits', 'count'), ['website/def/app.api.def: def count the visit']);
expect('shared is a statement, not a def', click('shared visits is 0', 'shared'), []);
expect('api def', click('api "/api/bmi" runs work out the bmi and sends bmi, verdict', 'sends'), ['web/server.def: def python as written api A0 runs A1 and sends A2']);
expect('page def', click('page "/" shows home page', 'shows'), ['web/server.def: def python as written page A0 shows A1']);
expect('nothing inside text', click('say "x squared"', 'squared'), []);
expect('stacked header', click('it becomes 1', 'becomes'), ['core/lists.def: def python it becomes A0']);
expect('number words', click('x is twenty one', 'twenty').length, 1);
expect('loop', click('repeat 3 times: say "hi"', 'repeat'), ['core/loops.def: def python as written repeat A0 times : A1']);

// the text that is underlined / hovered as one item
function phrase(line, word, nth = 0) {
  let column = -1;
  for (let i = 0; i <= nth; i++) column = line.indexOf(word, column + 1);
  const hit = lib.findDefinitions(line, column, indexes)[0];
  return hit && line.slice(hit.range[0], hit.range[1]);
}
expect('phrase: count the visit', phrase('api "/x" runs count the visit and sends visits', 'the'), 'count the visit');
expect('phrase: last word of it', phrase('api "/x" runs count the visit and sends visits', 'visit '), 'count the visit');
expect('phrase: stops at a value', phrase('x is 5 is between 1 and 10', 'between'), 'is between');
expect('phrase: and on its own', phrase('x is 5 is between 1 and 10', 'and'), 'and');
expect('phrase: means', phrase('x is less than or equal to 3', 'equal'), 'is less than or equal to');
expect('phrase: one word', phrase('x is 3 squared', 'squared'), 'squared');
expect('phrase: symbols', phrase('x is 2 + 3', '+'), '+');
expect('phrase: number words', phrase('x is twenty one', 'one'), 'twenty one');

const website = path.join(SAMPLE, 'website', 'main.def');
const bmiIndex = indexes.find(i => i.file.endsWith(path.join('bmi', 'main.def')));
const variable = lib.findVariable('bmi', bmiIndex.file, indexes);
expect('variable', variable && bmiIndex.lines[variable.line], 'bmi is bmi of weight and height');
const given = lib.findVariable('weight', bmiIndex.file, indexes);
expect('given variable', given && bmiIndex.lines[given.line], 'give weight');

const links = (line, file) => lib.findLinks(line, file).map(([s, e, t]) => [line.slice(s, e), rel(t)]);
expect('use from package', links('use def/app.api', website), [['def/app.api', 'website/def/app.api.def']]);
expect('use from a library', links('use web/server', website), [['web/server', 'web/server.def']]);
expect('use a library', links('use core', website), [['core', 'core/main.def']]);
expect('template', links('    template "def/site.page.def"', path.join(SAMPLE, 'website', 'def', 'app.api.def')),
  [['def/site.page.def', 'website/def/site.page.def']]);
expect('assets folder', links('the assets are in "def"', website), [['def', 'website/def']]);

// core is one topic per file now: lists.def has `it becomes`, math.def `rounded`
const core = indexes.find(i => i.file.endsWith(path.join('core', 'lists.def')));
const math = indexes.find(i => i.file.endsWith(path.join('core', 'math.def')));
const squaredLine = math.lines.findIndex(l => l === 'def A0 squared');
expect('hover source', lib.sourceOf(math, squaredLine), 'def A0 squared\n    A0 * A0');
const becomes = core.lines.findIndex(l => l === 'def python it becomes A0');
expect('hover source shows the whole group', lib.sourceOf(core, becomes).split('\n').slice(0, 3),
  ['def python it should be converted to A0', 'def python it becomes A0', '    if self.store("core").get("it") is None:']);
const server = indexes.find(i => i.file === path.join(LIB, 'web', 'server.def'));
const start = server.lines.findIndex(l => l === 'def python start the server');
expect('long bodies are cut', lib.sourceOf(server, start).split('\n').length, 17);
const comparison = indexes.find(i => i.file.endsWith(path.join('core', 'comparison.def')));
expect('means line source', lib.sourceOf(comparison, comparison.lines.indexOf('greater than means >')), 'greater than means >');
const coreFile = name => indexes.find(i => i.file === path.join(LIB, 'core', name + '.def'));
expect('python body lines are known', indexes.filter(i => i.file.startsWith(path.join(LIB, 'core') + path.sep)).reduce((n, i) => n + i.pythonLines.size, 0) > 50, true);

// descriptions: the comments right above a def (or above its group / run of means lines)
const describe = (index, text) => lib.descriptionOf(index, index.lines.indexOf(text));
expect('description', lib.splitDescription(describe(math, 'def A0 squared')),
  { text: 'A0 multiplied by itself.', examples: [{ input: '3 squared', result: '9' }] });
expect('description of a stacked line', describe(core, 'def python it becomes A0').startsWith('Replaces "it"'), true);
expect('description of a means run', lib.splitDescription(describe(comparison, 'less than means <')).text, 'Words for the comparison symbols. Longer phrases are replaced first.');
expect('example lines', lib.splitDescription(describe(coreFile('loops'), 'def python as written repeat A0 times : A1')),
  { text: 'Runs the line after the colon A0 times.', examples: [{ input: 'repeat 3 times: say "hi"', result: 'prints hi, hi, hi' }] });
expect('"(not checked)" is left out of the hover', lib.splitDescription(describe(coreFile('time'), 'def python today')).examples,
  [{ input: 'today', result: '"2026-11-21", today\'s date' }]);
const longText = lib.splitDescription(describe(core, 'def python as written give A0'));
expect('a description over several lines', longText.text.split('\n').length, 1);
expect('every def has an example', indexes.flatMap(i => i.defs.filter(d => !d.alias || true)
  .filter(d => !lib.splitDescription(lib.descriptionOf(i, d.line)).examples.length).map(d => rel(i.file) + ': ' + d.text)), []);
const basic = coreFile('phrases');
expect('a section header is not a description', describe(coreFile('questions'), 'def python is not ?').startsWith('Flips'), true);
expect('description in a package', describe(indexes.find(i => i.file.endsWith('app.api.def')), 'def count the visit'),
  'Counts a visit to the home view.\nExample: count the visit\n→ visits is 3, when visits was 2');
const undocumented = indexes.flatMap(i => i.defs.filter(d => !lib.descriptionOf(i, d.line)).map(d => rel(i.file) + ': ' + d.text));
expect('every library and package def has a description', undocumented, []);

// HTML templates: the def-lang inside {{ ... }}
// a template anywhere in the website package (the file doesn't have to exist)
const page = path.join(SAMPLE, 'website', 'static', 'result.html');
const index = page;
const htmlLine = '<p>It is {{ the time }} on {{ today }}.</p>';
expect('template expression', lib.templateExpressionAt(htmlLine, htmlLine.indexOf('time')), { text: ' the time ', start: htmlLine.indexOf('{{') + 2 });
expect('outside {{ }}', lib.templateExpressionAt(htmlLine, htmlLine.indexOf('It')), null);
expect('template phrase', click(' the time ', 'time'), ['core/time.def: def python time']);
const inPackage = (word, file) => { const f = lib.findVariable(word, file, indexes); return f && rel(f.file) + ': ' + indexes.find(i => i.file === f.file).lines[f.line].trim(); };
expect('template variable uses its own package', inPackage('visits', page), 'website/def/app.api.def: shared visits is 0');
expect('variable set in a condition', inPackage('name', page), 'website/def/app.api.def: name is query "name"');
expect('html files belong to their package', lib.packageFolder(page), path.join(SAMPLE, 'website'));

// colours: each def phrase is one item
const coloured = line => lib.phrasesIn(line, indexes).map(([s, e]) => line.slice(s, e));
expect('one item', coloured('api "/api/visit" runs count the visit and sends visits, time, today'),
  ['api', 'runs', 'count the visit', 'and sends', 'time', 'today']);
expect('syntax words keep their colour', coloured('x is 3 squared'), ['squared']);
expect('a phrase with a syntax word', coloured('x is 5 is between 1 and 10'), ['is between']);
expect('nothing in text', coloured('say "count the visit"'), ['say']);
expect('library phrases', coloured('one of the numbers is 11?'), ['one of', 'the']);

// the underline: fixed words ("solid") and the parts that fill the arguments, spaces included ("dotted": the other colour)
const order = lib.defOrder(lib.orderStarts(website), indexes);
function structure(line, word, nth = 0) {
  let column = -1;
  for (let i = 0; i <= nth; i++) column = line.indexOf(word, column + 1);
  const found = lib.structureAt(line, column, indexes, order);
  const text = spans => spans.map(([s, e]) => line.slice(s, e));
  return found && { solid: text(found.keywords), dotted: text(found.parts) };
}
expect('order follows imports', order.size > 60, true);
expect('assignment takes the whole right side', structure('x is 2 + 3', 'is'), { solid: ['is'], dotted: ['x ', ' 2 + 3'] });
expect('math stops at a looser phrase', structure('for each n in numbers from 1 to 10: say n * 7', '*'), { solid: ['*'], dotted: ['n ', ' 7'] });
expect('stops at the loop colon', structure('for each n in numbers from 1 to 10: say n * 7', 'from'),
  { solid: ['numbers from', 'to'], dotted: [' 1 ', ' 10'] });
expect('api line', structure('api "/api/visit" runs count the visit and sends visits, time, today', 'runs'),
  { solid: ['api', 'runs', 'and sends'], dotted: [' "/api/visit" ', ' count the visit ', ' visits, time, today'] });
expect('a phrase on its own', structure('api "/api/visit" runs count the visit and sends visits', 'visit', 1),
  { solid: ['count the visit'], dotted: [] });
expect('stops at the question', structure('is name empty?', 'empty'), { solid: ['empty'], dotted: ['name '] });
expect('stops at an assignment', structure('x is 5 is between 1 and 10', 'between'),
  { solid: ['is between', 'and'], dotted: ['5 ', ' 1 ', ' 10'] });
expect('backtick lines', structure('`give 2 numbers less than or equal to 14`', 'give'), { solid: ['give'], dotted: [' 2 numbers less than or equal to 14'] });

// a file inside the library reads the order from its main.def
const coreOrder = lib.defOrder(lib.orderStarts(core.file), indexes);
const inCore = lib.structureAt('x is 2 + 3', 2, indexes, coreOrder);
expect('order outside a package', inCore && inCore.parts.map(([s, e]) => 'x is 2 + 3'.slice(s, e)), ['x ', ' 2 + 3']);

// variables are coloured too
// in the bmi package: only what its main.def imports, so the website's def bmi isn't a phrase there
const bmiVisible = lib.visibleIndexes(bmiIndex.file, indexes);
expect('a package sees its own defs only', bmiVisible.some(i => i.file.includes(path.join('website', ''))), false);
expect('it sees the library', bmiVisible.some(i => i.file === core.file), true);
const names = lib.variableNames(bmiVisible);
expect('variable names', ['bmi', 'weight', 'height'].every(n => names.has(n)), true);
expect('syntax words are not variables', names.has('is'), false);
const varLine = 'say "Your BMI is " bmi " for " weight';
expect('variables on a line', lib.variablesIn(varLine, names, lib.phrasesIn(varLine, bmiVisible)).map(([s, e]) => varLine.slice(s, e)), ['bmi', 'weight']);
const mixed = 'bmi is bmi of weight and height';
expect('a phrase word is not a variable', lib.variablesIn(mixed, names, lib.phrasesIn(mixed, bmiVisible)).map(([s, e]) => mixed.slice(s, e)), ['bmi', 'weight', 'height']);

// one result per definition, and whole words only
const roundedLine = 'bmi is weight / height squared rounded to 1 places';
expect('stacked def lines show once', click(roundedLine, 'rounded'), ['core/math.def: def python A0 rounded to A1 places']);
expect('a word never matches inside a longer word', click('x is index', 'index'), []);
expect('a word still matches on its own', click('for each n in list: say n', 'each').length, 1);

// hover shows only the def line(s)
expect('hover shows only the def line', lib.headerOf(math, math.lines.indexOf('def A0 squared')), 'def A0 squared');
expect('hover shows every line of a def group', lib.headerOf(math, math.lines.indexOf('def python A0 rounded to A1 place')),
  'def python A0 rounded to A1 places\ndef python A0 rounded to A1 place');
expect('hover shows a means line', lib.headerOf(comparison, comparison.lines.indexOf('greater than means >')), 'greater than means >');

// HTML bodies are not def-lang
const bmiView = indexes.find(i => i.file.endsWith(path.join('views', 'bmi.view.def')));
expect('html def is found', click('bmi view', 'bmi'), ['website/def/views/bmi.view.def: def html bmi view']);
expect('html body lines are left alone', bmiView.pythonLines.size > 5, true);

// HTML views: {name}, api="...", loads="..." and href="/..."
const viewFile = name => indexes.find(i => i.file.endsWith(path.join('views', name)));
const htmlAt = (index, text, word) => {
  const n = index.lines.findIndex(l => l.includes(text));
  const ref = lib.htmlReferenceAt(index.lines[n], index.lines[n].indexOf(word));
  return ref && { ref: [ref.kind, ref.value, index.lines[n].slice(ref.start, ref.end)],
    to: lib.resolveHtmlReference(ref, index.file, indexes).map(t => t.label + ': ' + rel(t.file) + ': ' + indexes.find(i => i.file === t.file).lines[t.line].trim()) };
};
const bmiHtml = viewFile('bmi.view.def');
expect('{name} in a view', htmlAt(bmiHtml, '{bmi}', 'bmi}'), { ref: ['field', 'bmi', 'bmi'], to: [
  'is the def: website/def/app.api.def: def bmi',
  'sent by: website/main.def: api "/api/bmi" sends bmi, verdict'] });
expect('{name} that is shared', htmlAt(viewFile('home.view.def'), '{visits}', 'visits').to[0],
  'gets its value: website/def/app.api.def: shared visits is 0');
expect('{name} that is a def', htmlAt(viewFile('home.view.def'), '{time}', 'time').to[0],
  'is the def: core/time.def: def python time');
expect('api="..." on a form', htmlAt(bmiHtml, 'api="/api/bmi"', '/api/bmi').to,
  ['the api: website/main.def: api "/api/bmi" sends bmi, verdict']);
expect('loads="..." on a view', htmlAt(viewFile('home.view.def'), 'loads=', '/api/visit').to,
  ['the api: website/main.def: api "/api/visit" runs count the visit and sends visits, time, today']);
expect('href="/..." on a link', htmlAt(viewFile('missing.view.def'), 'href="/"', 'href').to,
  ['the view: website/def/views/home.view.def: def html home view']);
expect('{name} is coloured only in HTML bodies', bmiHtml.htmlLines.size > 5 && !bmiHtml.htmlLines.has(bmiHtml.lines.indexOf('def html bmi view')), true);

// languages come from `language NAME` lines, not from a fixed list
expect('languages are read from the files', [...languages].sort(), ['css', 'html', 'javascript', 'python']);
expect('style def in a view', htmlAt(viewFile('hello.view.def'), '<style def=', 'hello').to,
  ['puts in: website/def/views/hello.view.def: def css hello style']);
expect('where a language is declared', (({ file, line }) => rel(file) + ': ' + indexes.find(i => i.file === file).lines[line])(lib.findLanguage('html', indexes)),
  'language/html/main.def: language html');
const own = lib.indexText('/tmp/x.def', 'language upper\n    return body.upper()\ndef upper shout A0\n    hello A0\n', lib.languageNames(['language upper']));
expect('a language of your own is a flag', own.defs.map(d => d.text), ['def upper shout A0']);
expect('its body is left alone', [...own.pythonLines].sort(), [1, 3]);
const undeclared = lib.indexText('/tmp/y.def', 'def upper shout A0\n    hello A0\n', lib.languageNames([]));
expect('an undeclared word is part of the pattern', undeclared.pythonLines.size, 0);

// <script def="..."> in a view goes to the JavaScript def
expect('script def in a view', htmlAt(viewFile('hello.view.def'), '<script def=', 'characters').to,
  ['puts in: website/def/views/hello.view.def: def javascript count the characters left']);
expect('javascript is a language', languages.has('javascript'), true);
expect('javascript bodies are left alone', viewFile('hello.view.def').pythonLines.has(viewFile('hello.view.def').lines.indexOf("    // the limit is the input's maxlength; the browser keeps to it")), true);

// comments get no hover
const roundedComment = math.lines.findIndex(l => l === '// Example: 22.857 rounded to 1 places');
expect('a comment line is a comment', lib.isComment(math, roundedComment), true);
{
  const own = lib.indexText('/x/main.def', 'comment is #\n# run with: run x\nsay 1\n', languages);
  expect('a line starting with a `comment is` marker is a comment', lib.isComment(own, 1), true);
  expect('a code line after it is not', lib.isComment(own, 2), false);
  const back = lib.indexText('/x/main.def', '# not yet a comment\ncomment is #\n// no longer a comment\ncomment is //\n// a comment again\n', languages);
  expect('a marker counts only from its comment is line', lib.isComment(back, 0), false);
  expect('a new marker replaces the old one', lib.isComment(back, 2), false);
  expect('comment is // switches back', lib.isComment(back, 4), true);
}
expect('a code line is not', lib.isComment(math, math.lines.indexOf('def python A0 rounded to A1 places')), false);
expect('a // line in a JavaScript body is not', lib.isComment(viewFile('hello.view.def'), viewFile('hello.view.def').lines.indexOf("    // the limit is the input's maxlength; the browser keeps to it")), false);

// def="..." on any element of the page leads to that def, with its description in the hover
const pageHtml = indexes.find(i => i.file.endsWith(path.join('def', 'site.page.def')));
expect('script def in the page', htmlAt(pageHtml, '<script def="web script">', 'web script').to, ['puts in: web/script.def: def javascript web script']);
expect('nav def in the page', htmlAt(pageHtml, '<nav def="site nav">', 'nav"').ref, ['def', 'site nav', 'site nav']);
expect('nav def leads to the links', htmlAt(pageHtml, '<nav def="site nav">', 'site').to, ['puts in: website/def/views/site.nav.def: def html site nav']);
expect('template def leads to the view', htmlAt(pageHtml, '<template def="bmi view">', 'bmi').to, ['puts in: website/def/views/bmi.view.def: def html bmi view']);
expect('data-def is not def', lib.htmlReferenceAt('<p data-def="x">', 9), null);
const scriptIndex = indexes.find(i => i.file.endsWith(path.join('web', 'script.def')));
expect('the script has a description', lib.splitDescription(lib.descriptionOf(scriptIndex, scriptIndex.lines.indexOf('def javascript web script'))).text
  .startsWith('The script of a single page application'), true);
const helloIndex = viewFile('hello.view.def');
expect('a view has a description', lib.splitDescription(lib.descriptionOf(helloIndex, helloIndex.lines.indexOf('def html hello view'))).text,
  "Asks for a name and shows def-lang's greeting.");

// a pattern without fixed words (the number words) matches whole words only
const numberAt = (line, word) => (h => h ? line.slice(h.range[0], h.range[1]) : null)(lib.findDefinitions(line, line.indexOf(word), indexes)[0]);
expect('no number inside written', numberAt('x is written', 'ten'), null);
expect('no number inside often', numberAt('say often', 'ten'), null);
expect('ten on its own is a number', numberAt('x is ten', 'ten'), 'ten');
expect('twenty one is a number', numberAt('x is twenty one', 'one'), 'twenty one');
expect('written in a def line is the flag', lib.flagAt('def python as written A0 is A1', 'def python as written A0 is A1'.indexOf('ten'), languages).flag, 'as written');

// libraries: a program's linked libraries, and a library's own imports
expect('a program folder', rel(lib.programFolder(path.join(SAMPLE, 'website', 'def', 'views', 'bmi.view.def'))), 'website');
expect('a linked library', rel(lib.libraryFolder(path.join(SAMPLE, 'website'), 'web')), 'web');
expect('a library uses what its libraries.toml lists', rel(lib.resolveImport('javascript', path.join(LIB, 'web', 'script.def'))), 'language/javascript/main.def');
expect('the core library uses its own files', rel(lib.resolveImport('values', path.join(LIB, 'core', 'main.def'))), 'core/values.def');
expect('a single-file program has its libraries too', rel(lib.resolveImport('core', path.join(SAMPLE, 'black-jack', 'main.def'))), 'core/main.def');
expect('no library, no import', lib.resolveImport('nothing/here', path.join(SAMPLE, 'black-jack', 'main.def')), null);

// flags: what they mean on hover, and warnings when a def probably needs one
const rounded = 'def python as written repeat A0 times : A1';
expect('hover on as written', lib.flagAt(rounded, rounded.indexOf('written'), languages), { flag: 'as written', start: 11, end: 21 });
expect('no flag hover on the pattern', lib.flagAt(rounded, rounded.indexOf('repeat'), languages), null);
expect('every flag has help', ['as written', 'regex'].every(f => lib.FLAG_HELP[f]), true);
expect('the library needs no flag warnings', indexes.flatMap(i => lib.flagWarnings(i, indexes).map(w => rel(i.file) + ':' + (w.line + 1))), []);
const bad = lib.indexText(path.join(SAMPLE, 'bad.def'), [
  'argument is A',
  '// Stores A1 under the name A0.',
  '// Example: store 5 as x',
  '//          → x is 5',
  'def python store A1 as A0',
  '    self.variables[A0] = A1',
  '',
  '// Sends x.',
  '// Example: send "/a" runs x is 1',
  '//          → GET /a answers {"x": 1}',
  'def python as written send A0 runs A1',
  '    self._sent = (self.run(A0), A1)',
].join('\n'), languages);
expect('warns when as written is missing', lib.flagWarnings(bad, [...indexes, bad]).map(w => [w.line + 1, w.message.split('.')[0]]), [
  [5, 'A0 is already a value here, not its words'],
]);

// how a line is read, like the engine: the underline of a use shows its arguments
const partsOf = (line, word) => (s => s && s.parts.map(([a, b]) => line.slice(a, b)))(
  lib.structureAt(line, line.indexOf(word), indexes, lib.defOrder(lib.orderStarts(website), indexes)));
expect('brackets: is inside api', partsOf('api "/a" runs x is 1 and sends x', 'is 1'), ['x ', ' 1']);
expect('brackets: api around is', partsOf('api "/a" runs x is 1 and sends x', 'runs'), [' "/a" ', ' x is 1 ', ' x']);
expect('sentence: all of ... are wraps >', partsOf('all of [1, 2] are > 1', 'are'), [' [1, 2] ', ' > 1']);
expect('a phrase is not a sentence', partsOf('count of [] = 0', '='), ['count of [] ', ' 0']);
expect('a question wraps what is before it', partsOf('x > 3 ?', '?'), ['x > 3 ']);

// completions: what is offered at the end of `text`'s last line, in bmi/main.def
function offered(text, kind) {
  const file = path.join(SAMPLE, 'bmi', 'main.def');
  const own = lib.indexText(file, text, languages);
  const all = [...indexes.filter(i => i.file !== file), own];
  const n = own.lines.length - 1;
  return lib.completionsAt(own, n, own.lines[n].length, all, languages).filter(i => !kind || i.kind === kind);
}
const labels = items => items.map(i => i.label);
const item = (items, label) => items.find(i => i.label === label);
expect('snippet: fixed words, then tab stops', lib.defSnippet({ pattern: 'repeat A0 times : A1', argumentName: 'A' }).insert, 'repeat ${1:A0} times : ${2:A1}');
expect('snippet: a leading argument inserts the rest', lib.defSnippet({ pattern: 'A0 is A1', argumentName: 'A' }), { label: 'A0 is A1', insert: 'is ${1:A1}', filter: 'is', leading: true });
expect('snippet: a restricted argument shows its name', lib.defSnippet({ pattern: 'roll (A0: \\d+(?:d\\d+)?) dice', argumentName: 'A' }).insert, 'roll ${1:A0} dice');
expect('snippet: argument is X', lib.defSnippet({ pattern: 'X0 doubled', argumentName: 'X' }).insert, 'doubled');
expect('statements at the start of a line', ['def', 'use', 'comment is', 'indent'].every(l => labels(offered('use core\nimp', 'statement')).includes(l)), true);
expect('phrases from the libraries it imports', labels(offered('use core\nsum', 'phrase')).includes('sum of A0'), true);
expect('a phrase brings its description', item(offered('use core\nsum', 'phrase'), 'sum of A0').documentation.includes('sum of [1, 2, 3]'), true);
expect('no phrases from files it does not import', [labels(offered('bm', 'phrase')).includes('bmi of A0 and A1'), labels(offered('use def/bmi\nbm', 'phrase')).includes('bmi of A0 and A1')], [false, true]);
expect('A0 is A1 only after something', [labels(offered('use core\n', 'follow')).includes('A0 is A1'), labels(offered('use core\nx ', 'follow')).includes('A0 is A1')], [false, true]);
expect('variables', labels(offered('use core\nweight is 70\nsay w', 'variable')).includes('weight'), true);
expect('nothing inside text', offered('use core\nsay "su').length, 0);
expect('nothing on a comment line', offered('use core\n// su').length, 0);
expect('flags after def', labels(offered('def ')), ['as written', 'regex', ...languages]);
expect('flags not twice', labels(offered('def as written ', 'flag')), ['regex']);
expect('nothing in the words of a def', offered('def python say A').length, 0);
expect('imports: files and libraries', ['def/bmi', 'core', 'core/math'].every(n => labels(offered('use ')).includes(n)), true);
expect('python: self. members', labels(offered('def python twice A0\n    return self.')).slice(0, 3), ['run', 'say', 'variables']);
expect('python: helpers and the arguments', ['as_text', 'number', 'A0', 'A1'].every(l => labels(offered('def python A0 plus A1\n    return ')).includes(l)), true);
expect('python: X0 after argument is X', labels(offered('argument is X\ndef python X0 doubled\n    return ', 'variable')), ['X0']);
expect('language runner: BODY, VAR, fill', ['BODY', 'VAR', 'fill'].every(l => labels(offered('language upper\n    return ')).includes(l)), true);
expect('replaces what is typed of it', [item(offered('use core\nsum o', 'phrase'), 'sum of A0').start, item(offered('use core\nx i', 'follow'), 'A0 is A1').start], [0, 2]);
expect('use names replace the typed name', item(offered('use de'), 'def/bmi').start, 4);
expect('argument is / comment is make no variables', labels(offered('use core\nargument is X\ncomment is #\nweight is 70\nw', 'variable')), ['weight']);
expect('joined text has no words to show', [lib.readableToRegex('A0 "A1"', 'A'), lib.readableToRegex('"A0" A1', 'A')], [null, null]);
expect('a text argument with words is a phrase', lib.readableToRegex('shout "A0"', 'A').keywords, 1);
expect('no text joins here statement', labels(offered('use core\ntex', 'statement')).includes('text joins here'), false);
expect('shared makes variables, with or without the rest', ['visits', 'score'].every(n => labels(offered('use core\nshared visits is 0\nshared score\nsay v', 'variable')).concat(labels(offered('use core\nshared visits is 0\nshared score\nsay s', 'variable'))).includes(n)), true);
expect('shared is offered, and use shared is gone', [labels(offered('use core\nsh', 'statement')).includes('shared'), labels(offered('use core\nus', 'statement')).includes('use shared')], [true, false]);
expect('use NAMES from FILE: names after from', labels(offered('use visits from de')).includes('def/bmi'), true);
expect('use NAMES from FILE makes variables', ['visits', 'count'].every(n => labels(offered('use core\nuse visits, total as count from counter\nsay ', 'variable')).includes(n)), true);
expect('use NAMES from FILE links the file', lib.findLinks('use visits from def/bmi', path.join(SAMPLE, 'bmi', 'main.def')).map(([s, e]) => [s, e]), [[16, 23]]);
expect('nothing in an HTML body', offered('use html\ndef html card\n    <div>').length, 0);

// libraries.toml: a global library is GLOBAL/NAME/VERSION; a git one not installed yet is nowhere
{
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deflang-check-'));
  const global = path.join(tmp, 'global'), program = path.join(tmp, 'program');
  fs.mkdirSync(path.join(global, 'shapes', '1.0'), { recursive: true });
  fs.writeFileSync(path.join(global, 'shapes', '1.0', 'library.toml'), 'name = "shapes"\nversion = "1.0"\n');
  fs.writeFileSync(path.join(global, 'shapes', '1.0', 'circle.def'), 'def area of A0\n    A0\n');
  fs.mkdirSync(program);
  fs.writeFileSync(path.join(program, 'libraries.toml'),
    'shapes = { from = "https://example.com/libs.git#shapes", global = "1.0" }\nweb = { from = "https://example.com/libs.git#web" }\n');
  fs.writeFileSync(path.join(program, 'main.def'), 'use shapes/circle\n');
  const saved = process.env.DEFLANG_GLOBAL;
  process.env.DEFLANG_GLOBAL = global;
  expect('entries are tables', lib.listedLibraries(program).map(e => [e.name, e.global, e.link]), [['shapes', '1.0', false], ['web', null, false]]);
  expect('a global library', lib.libraryFolder(program, 'shapes'), path.join(global, 'shapes', '1.0'));
  expect('use finds a global library', lib.resolveImport('shapes/circle', path.join(program, 'main.def')), path.join(global, 'shapes', '1.0', 'circle.def'));
  expect('a git library not installed yet is nowhere', lib.libraryFolder(program, 'web'), null);
  expect('global folders are indexed too', lib.linkedFolders(program), [path.join(global, 'shapes', '1.0')]);
  if (saved === undefined) delete process.env.DEFLANG_GLOBAL; else process.env.DEFLANG_GLOBAL = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
