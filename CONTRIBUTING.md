# Working on the extension

This folder is the extension. It needs nothing else to build: the interpreter and the
libraries are not part of it (the extension runs the user's interpreter, from the
`def-lang.interpreterFolder` setting).

| File | Is |
|---|---|
| `extension.js` | connects everything to VS Code: commands, hover, Ctrl+click, colors, IntelliSense, errors |
| `lib.js` | reads `.def` files: definitions, phrases, variables, libraries (no VS Code in it) |
| `make_grammar.py` | writes `syntaxes/def.tmLanguage.json`, the coloring grammar |
| `make_palette.py` | checks the colors' contrast (4.5 or more; 3 for flags and comments) and writes them into `package.json` |
| `palette.json` | the colors, for light and dark themes |
| `build_vsix.py` | packs the extension into `def-lang-<version>.vsix`, without Node |

To add a language to the coloring of bodies, add it to `LANGUAGES` in
`make_grammar.py`.

## Building

```console
python3 make_grammar.py
```

(only after changing the grammar)

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
