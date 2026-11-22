# def-lang for VS Code

The def-lang language for VS Code. It carries the interpreter (no libraries: a
program installs those) and needs Python 3.11 or newer (setting `def-lang.python`).

- **def-lang: Run this program** (the ▶ button on a `.def` file): runs it in a
  terminal. A file of a package runs the package's `main.def`.
- **def-lang: Open console**: the def-lang console in a terminal.
- **def-lang: Install library…**: from a git repository (`URL#folder`), into the
  project or global, or a local library (a folder of the project, linked), into the
  program of the open file, with the libraries its `libraries.toml` lists.

Colours `.def` files: comments (with the file's own marker: `//`, or what `comment is`
sets from that line on), `def` lines and their flags, arguments (`A0`),
restricted-argument regexes, text, numbers (also in words), questions, loops,
library phrases, and Python bodies of `def python ...` as real Python.

Ctrl+click (or F12) goes to, and hovering shows:

- a phrase's `def` or `means` line (`squared`, `is between`, `home page`,
  `greater than`); the def with the most matching words wins, like in the engine;
- a variable's first value (`x is ...`, `give x`, `for each x in`, `add ... to x`);
- the file in `use web/server` (a library's file), `use def/app.api`,
  `template "pages/index.html"` and
  `the assets are in "static"`.

Hover also shows a def's description: the comment lines right above it
(above the first line of a group of `def` lines, or of a run of `means` lines).

    // A0 multiplied by itself. Example: `3 squared`
    def A0 squared
        A0 * A0

The same works in a package's HTML templates, inside `{{ ... }}`:
`{{ visits }}` goes to `visits is 0`, `{{ the time }}` to the `time` def.
Variables are looked up in the template's own package first.

Colours use the Fjord palette, with a set for dark themes and one for light themes:
steel blue for def-lang's own words (`def`, `use`, `is`, `?`, symbols), grey for
flags, near-default text for def phrases (`count the visit`, `say`), gold for
variables (`A0` and your own, like `visits`), sage for quoted text and lilac for
numbers. `make_palette.py` checks every colour for contrast (4.5 or more; 3 for
flags and comments, which are meant to sit back) and writes them into
`package.json`. Other languages keep the theme's colours. To use your theme's
colours for def-lang too, set your own `editor.tokenColorCustomizations` (yours
replace the extension's).

Hovering underlines the whole use of a def, spaces included: its fixed words with
a solid steel-blue line, the parts that fill its arguments with gold dashes. Set
`def-lang.underline.wordColor` or `def-lang.underline.argumentColor` (a theme
colour id like `charts.blue`, or `#rrggbb`) to use one colour of your own.

In a view's HTML (`def html ... view`), `{name}` is coloured as a variable, and
Ctrl+click and hover lead to where it gets its value and to the `api` line that
sends it. `api="/api/x"` and `loads="/api/x"` lead to that `api` line, and
`href="/x"` to the view with that path.

Languages (`def html ...`, `def python ...`) are read from the `language NAME`
lines of your files, so a language you declare yourself is understood too:
Ctrl+click or hover on the word after `def` goes to its `language` line. Bodies
of Python, HTML, CSS, JavaScript, SQL, Markdown, JSON, shell and YAML are coloured
in that language; add others to `LANGUAGES` in `make_grammar.py`.

In HTML, Ctrl+click or hover on the name in any `def="..."` (`<nav def="site nav">`,
`<template def="bmi view">`, `<script def="web script">`) goes to that def and shows
its description.

Hover on a flag after `def` (`as written`, `regex`) says what it means and when a
def needs it. A Python body that runs or names an argument itself without
`as written` gets a warning under its def line. The hover underline reads a line
like the engine does: brackets, sentences, word lists, then def order.

IntelliSense (as you type, or Ctrl+Space) offers the def phrases this file's program
can see, with their descriptions and Tab between the arguments (`repeat ▮ times : ▯`);
after something typed, the defs that start with an argument (`x ` → `is`, `>`, `+`);
variables; statements at the start of a line; flags and languages after `def`;
files and libraries after `use` (and after `from`); and in a Python body, what `self.` and the
helpers (`as_text`, `number`, ...) give, and the def's own arguments.

Errors are underlined in red as you type, saved or not: unknown names, files it
can't find, a missing closing quote, a Python syntax error in a body, and more. They
come from the interpreter itself (`python -m deflang check`), which reads the open
file as part of its program without running anything.

It looks at every `.def` file in the open folder, and at the libraries a program
lists: linked, global (`~/.def-lang/libraries`, or what `def-lang setup` chose), or
copied into `libraries/`.

## Building

This repository is the extension. It works with three repositories next to it:

    deflang/          the interpreter, packed into the extension
    deflang-lib/      the libraries, for the checks
    deflang-sample/   the samples, for the checks

(or `$DEFLANG`, `$DEFLANG_LIB` and `$DEFLANG_SAMPLE`).

    python3 make_grammar.py      # only after changing the grammar
    ELECTRON_RUN_AS_NODE=1 code check.js   # checks lib.js against the libraries and samples
    python3 build_vsix.py        # packs ../deflang/ in, and checks it has no libraries
    code --install-extension def-lang-<version>.vsix

Then reload VS Code (Ctrl+Shift+P, "Developer: Reload Window").
Uninstall with `code --uninstall-extension def-lang.def-lang`.
