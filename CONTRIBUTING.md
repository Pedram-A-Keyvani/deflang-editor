# Working on the extension

This folder is the extension. It needs nothing else to build: the interpreter and the
libraries are not part of it (the extension runs the user's interpreter, from the
`def-lang.interpreterFolder` setting).

| File | Is |
|---|---|
| `extension.js` | connects everything to VS Code: commands, hover, Ctrl+click, colors, IntelliSense, errors |
| `lib.js` | reads `.def` files: definitions, phrases, variables, libraries (no VS Code in it); what a library declares is read from its entries and definitions, never written here |
| `grammar.js` | makes `syntaxes/def.tmLanguage.json`, the coloring grammar, from the declared languages and modifiers |
| `make_palette.py` | checks the colors' contrast (4.5 or more; 3 for flags and comments) and writes them into `package.json` |
| `palette.json` | the colors, for light and dark themes |
| `build_vsix.py` | packs the extension into `def-lang-<version>.vsix`, without Node |

Only the interpreter's words (`python`, `use`, the entries and their fields) are
written here. A library's languages, flags, modifiers, statements and phrases are
learned from their declarations: phrases and keywords are colored from their
definitions, and the extension writes the grammar from the declared languages (each
one's `editor` names the VS Code grammar for its bodies) and modifiers. When they
change, it offers to reload the window, which shows the new grammar.

## Building

```console
node grammar.js
```

(the grammar the extension ships with, only `python`; with VS Code's Node:
`ELECTRON_RUN_AS_NODE=1 code grammar.js`)

```console
python3 make_palette.py
```

(only after changing `palette.json`)

```console
python3 build_vsix.py
```

```console
code --install-extension def-lang-VERSION.vsix
```

Then reload VS Code: Ctrl+Shift+P, "Developer: Reload Window".
