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
itself: once a day it asks GitHub for its newest release, and if that is newer, it
offers to install it (**Update**, **Not now**, **Don't ask again**). Only GitHub sees
the request. Check now with **def-lang: Check for updates**; turn the daily check off
with the setting `def-lang.checkForUpdates`.

## Uninstall

```console
code --uninstall-extension def-lang.def-lang
```

or in VS Code: Extensions view → def-lang → **Uninstall**.

## Before you start

It runs the def-lang interpreter, with Python 3.11 or newer. If the interpreter isn't
installed, the extension offers to install it:

- **Install**: it gets the interpreter from GitHub into `~/.def-lang/deflang` (or a
  folder you choose), with git or, without git, as a zip. Then it asks whether to
  add the `def-lang` command to your terminal (one line in `~/.bashrc` or
  `~/.zshrc`); it never changes them without a yes.
- **I have it**: you pick your `deflang` folder.

It also finds an interpreter you set up yourself, as the def-lang guide says: it
reads your shell's `def-lang` alias. After changing the alias, reload the window.

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

- **Colours** for comments, `def` lines and their flags, arguments, text, numbers,
  variables and the phrases of your defs. Bodies in another language (Python, HTML,
  CSS, JavaScript, …) are coloured in that language.
- **Hover and Ctrl+click** (or F12) on a phrase go to its `def` and show its
  description: the comment lines right above the def. They also work on variables,
  on the file after `use`, on flags (`as written`, `regex`) and on a language name
  after `def`.
- **Underlines** on hover show how a line is read: a def's fixed words solid, the
  parts that fill its arguments dashed.
- **IntelliSense** offers the phrases a file's program can see, with Tab between the
  arguments (`repeat ▮ times : ▯`), and also variables, statements, flags, files after
  `use`, and in a Python body what `self.` gives.
- **Errors** are underlined in red as you type: unknown names, files that can't be
  found, a missing closing quote, a Python syntax error, and more. They come from the
  interpreter, which reads the program without running it.
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
| `def-lang.folder` | the folder that holds the interpreter's `deflang` folder, like `~/code`. Empty: the one in your `def-lang` alias, else an installed deflang (pip, pipx) |
| `def-lang.python` | the Python (3.11 or newer) that runs def-lang. Empty: the one in your `def-lang` alias, else `python3` (`python` on Windows) |
| `def-lang.checkForUpdates` | look for a newer def-lang on GitHub once a day (on by default) |
| `def-lang.formatBodies` | Format Document formats bodies in other languages too (on by default) |
| `def-lang.underline.wordColor` | colour of the underline under a def's fixed words: a theme colour id (like `charts.blue`) or `#rrggbb` |
| `def-lang.underline.argumentColor` | colour of the underline under the parts that fill a def's arguments |

The colours work with light and dark themes. Your own
`editor.tokenColorCustomizations` replace them.
