# def-lang for VS Code

The [def-lang](https://github.com/Pedram-A-Keyvani/deflang) language in VS Code, for
any folder of `.def` files.

## Install

Get `def-lang-VERSION.vsix`, from the repository's
[Releases](https://github.com/Pedram-A-Keyvani/deflang-editor/releases), or build it
yourself ([CONTRIBUTING.md](CONTRIBUTING.md)). Then install it:

```console
code --install-extension def-lang-VERSION.vsix
```

or in VS Code: Extensions view → `…` menu → **Install from VSIX…**. Then reload the
window: Ctrl+Shift+P, "Developer: Reload Window".

A newer `.vsix` installs over the old one the same way.

## Updates

VS Code updates only extensions from the Marketplace, so def-lang looks for updates
itself, once a day, and at once after it is installed or updated:

- **The interpreter it installed** (in `~/.def-lang/deflang`, or the folder you chose)
  is brought up to GitHub's: a git clone is fast-forwarded, a zip is downloaded again.
  One that has changes of its own is left as it is. An interpreter you set up
  yourself (like a working copy of deflang) is never touched.
- **The extension**: if GitHub has a newer release, it offers to install it
  (**Update**, **Not now**, **Don't ask again**).

Only GitHub sees the requests. Check now with **def-lang: Check for updates** (the
extension) or **def-lang: Install or update the interpreter**; turn the daily check off
with the setting `def-lang.checkForUpdates`.

## Uninstall

```console
code --uninstall-extension def-lang.def-lang
```

or in VS Code: Extensions view → def-lang → **Uninstall**.

## Before you start

It runs the def-lang interpreter, with Python 3.11 or newer. When it starts, it looks
for the interpreter: the `def-lang.interpreterFolder` setting, your shell's `def-lang` alias, or
an installed deflang. If it doesn't find one, it asks, at every start until it is set
up (**Not now** waits for the next start; **Don't ask again** lasts until the next
version of the extension):

- **Install**: gets the interpreter from GitHub into `~/.def-lang/deflang` (or a folder
  you choose), with git or, without git, as a zip.
- **I have it**: you pick your `deflang` folder.

Then it sets everything up by itself: `def-lang.interpreterFolder` shows the folder, and the
`def-lang` command is added to your terminal (one line in `~/.bashrc` or `~/.zshrc`,
unless a `def-lang` alias is there already). Open a new terminal to use it.

## Commands

- **Run this program** (the ▶ button on a `.def` file): runs it in a terminal. A file
  of a program runs the program's `main.def`.
- **Open console**: the def-lang console in a terminal.
- **Install or update the interpreter**: installs it, as above; or updates it
  (`git pull`, or a new zip).
- **Check for updates**: looks for a newer def-lang now (see Updates).
- **Install library…**: from a git repository (`URL#folder`), into the project or
  global, or a local library (a folder of the project). It installs the libraries
  that library uses too.

## Editing

- **Colors** for comments, definition lines (`python[written] …`) and their flags,
  entries (`language`, `modifier`, …) and their fields, modifiers, arguments, text, numbers,
  variables and the phrases of your defs. Bodies in another language (Python, HTML,
  CSS, JavaScript, …) are colored in that language.
- **Nothing of a library is built in.** The editor knows only the interpreter's words
  (`python`, `use`, the entries); everything else it learns from what your program
  declares, the way the interpreter does: a definition that keeps its arguments' words
  colors like a keyword, a statement sets the comment marker if its `does` says so, a
  language's `editor` names the colors of its bodies. When a new language or modifier
  is declared, the editor offers to reload the window, which colors its bodies.
- **Hover and Ctrl+click** (or F12) on a phrase go to its definition and show its
  description: the comment lines right above it. They also work on variables, on the
  file after `use`, on a library's statements, and on the language, flags and
  modifiers of a definition line (`internal css[…]`): they lead to the entry that
  declares them, with its comment lines as its help. Where two files define the same
  phrase, they show the one in the line's scope (`in the scope of web/http`), as the
  interpreter reads it; the files named there lead to their files.
- **Find All References** (Shift+F12; Shift+Alt+F12 for the References panel) lists
  every use of what is under the cursor: a definition (from its definition line or any
  use of it: program lines, def-lang bodies, `does in def` lines, HTML's
  `def="name"`), a variable (in its file, and in the files that `use` it, under the
  name they give it), an entry (a language, flag, modifier or statement), or a file
  named by `use` or `in the scope of`. A line counts with the definition it is read
  with, as on hover. Above each definition and entry, the number of its uses: a click
  lists them (`def-lang.usesAbove` turns it off). Python bodies aren't read.
- **Underlines** on hover show how a line is read: a def's fixed words solid, the
  parts that fill its arguments dashed.
- **IntelliSense** offers the phrases a file's program can see, with Tab between the
  arguments (`repeat ▮ times : ▯`), and also variables, statements, languages,
  modifiers, an entry's fields, the flags in the brackets after a language, files after
  `use`, and in a Python body what `self.` and `self["` give.
- **Errors** are underlined in red as you type: unknown names, files that can't be
  found, a missing closing quote, a Python syntax error, and more. They come from the
  interpreter, which reads the program without running it. When a `libraries.toml`
  changes, the open files are checked again: a library may be found, or gone, now.
- **Format Document** (Shift+Alt+F, or on save with `editor.formatOnSave`): tidies the
  layout, never what a line means. Indentation in spaces, one space between words
  (quoted text and comments as they are), no trailing spaces, no runs of empty lines.
  A body in another language goes one level under its def, formatted by VS Code's
  formatter for that language: HTML, CSS, JavaScript and JSON are built in; Python
  needs a formatter extension (Black, autopep8, Ruff). Without one, the body keeps
  its own layout.
- **Libraries** are found the way the interpreter finds them: copies in `libraries/`,
  local folders, and global ones.
- **In HTML bodies**, `def="name"`, `{name}`, `api="…"` and `href="/…"` lead to the
  def, value, api line or view they name.
- **Inside a body in another language**, hover and IntelliSense are that language's,
  as in a `.html`, `.css` or `.js` file: tag and property help, completions, and so
  on. Python's need a Python extension; in a Python body, def-lang's own helpers
  (`self.`, `as_text`, …) are offered too.

## Settings

| Setting | Is |
|---|---|
| `def-lang.interpreterFolder` | the folder that holds the interpreter's `deflang` folder, like `~/code`; not where your programs are: `.def` files anywhere use it. Filled in by the extension when it finds or installs it (it was `def-lang.folder` before 0.39.0, and moves over by itself) |
| `def-lang.python` | the Python (3.11 or newer) that runs def-lang: `python3` (left at that, the one your `def-lang` alias names; `python` on Windows) |
| `def-lang.checkForUpdates` | look for a newer def-lang on GitHub once a day (on by default) |
| `def-lang.formatBodies` | Format Document formats bodies in other languages too (on by default) |
| `def-lang.usesAbove` | the number of uses above each definition and entry; a click lists them (on by default) |
| `def-lang.underline.wordColor` | color of the underline under a def's fixed words, `#rrggbb`: in `settings.json`, click its color box to pick one (a theme color id like `charts.blue` works too) |
| `def-lang.underline.argumentColor` | color of the underline under the parts that fill a def's arguments |

The colors work with light and dark themes. Your own
`editor.tokenColorCustomizations` replace them.
