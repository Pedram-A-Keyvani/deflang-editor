"""Writes the def-lang color palette into package.json. Edit this file, then run:
    python3 make_palette.py

Palette: https://coolors.co/palette/8ecae6-219ebc-023047-ffb703-fb8500
The Fjord palette: steel blue for def-lang's own words (def, import, is, ...),
gold for variables (A0 and your own), near-default text for def phrases, sage for
quoted text, lilac for numbers. On white, the light colors of the palette are too faint to read, so the
light set uses navy and darker shades of the same colors. Every text color is
checked for contrast against a typical background (WCAG: 4.5 or more).
"""
import json
from pathlib import Path

SKY, BLUE, NAVY, AMBER, ORANGE = "#8ECAE6", "#219EBC", "#023047", "#FFB703", "#FB8500"
# variables: a pale pink on dark backgrounds, a deeper rose of the same tone on white
PINK, ROSE = "#F7C1D0", "#A8375C"
# def phrases: the usual default text color (Dark+ on dark backgrounds, Light Modern on white)
WHITE, BLACK = "#D4D4D4", "#3B3B3B"
# quoted text: a soft green on dark backgrounds, a deeper green on white
MINT, GREEN = "#A8D8A0", "#2F7A3A"


def shade(color, factor):
    """The same color, darker (factor < 1)."""
    r, g, b = (int(color[i:i + 2], 16) for i in (1, 3, 5))
    return "#{:02X}{:02X}{:02X}".format(*(round(c * factor) for c in (r, g, b)))


# def (the language's own words) orange, variables pink, def phrases white/black, text green
def mix(color, other, amount):
    """`color` with `amount` (0..1) of `other` blended in."""
    a = [int(color[i:i + 2], 16) for i in (1, 3, 5)]
    b = [int(other[i:i + 2], 16) for i in (1, 3, 5)]
    return "#{:02X}{:02X}{:02X}".format(*(round(x + (y - x) * amount) for x, y in zip(a, b)))


# Fjord: steel-blue language words, gray flags, phrases near the default text
# color, gold variables, sage text, lilac numbers. Flags and comments are meant
# to sit back, so they only need contrast 3 (not 4.5).
SUBTLE = {"flag": 3.0, "comment": 3.0}

PALETTES = {
    "dark": {  # on a dark background (#1E1E1E)
        "keyword": "#88A9D8", "word": "#88A9D8", "flag": "#7A8597", "operator": "#88A9D8",
        "phrase": "#DCE1E8", "variable": "#E8C27A", "string": "#9CCB9B", "number": "#C79BD6",
        "comment": "#6E7787", "regex": "#C79BD6", "error": "#E39A9A",
    },
    "light": {  # on a white background
        "keyword": "#2E5A9C", "word": "#2E5A9C", "flag": "#67707F", "operator": "#2E5A9C",
        "phrase": "#2E3440", "variable": "#8A6210", "string": "#3E7A3D", "number": "#7A4290",
        "comment": "#6A7380", "regex": "#7A4290", "error": "#A33A3A",
    },
}
BACKGROUND = {"dark": "#1E1E1E", "light": "#FFFFFF"}

# the hover underline: a phrase's fixed words solid steel blue, the parts that fill
# its arguments in gold dashes
UNDERLINE = {
    "word": {"dark": "#88A9D8", "light": "#2E5A9C"},
    "argument": {"dark": "#E8C27A", "light": "#8A6210"},
}

SCOPES = [
    (["storage.type.def.def", "keyword.control.import.def"], "keyword", "bold"),
    # modifiers and an entry's fields; a library's keywords are colored from their
    # definitions (semantic colors, below)
    (["keyword.control.def", "keyword.control.field.def"], "keyword", ""),
    (["storage.modifier.def"], "flag", "italic"),
    (["entity.name.function.def"], "phrase", ""),
    # an entry's name (`language css`, `modifier shared`): a declared name
    (["entity.name.type.def"], "phrase", "bold"),
    (["variable.parameter.def"], "variable", "italic"),
    (["string.quoted.double.def", "punctuation.definition.string.begin.def", "punctuation.definition.string.end.def",
      "entity.name.namespace.def"], "string", ""),
    (["constant.numeric.def", "constant.language.def"], "number", ""),
    (["comment.line.double-slash.def"], "comment", "italic"),
    (["keyword.operator.def", "punctuation.section.brackets.def", "punctuation.definition.echo.def",
      "punctuation.definition.parameter.def", "punctuation.separator.def"], "operator", ""),
    (["string.regexp.def"], "regex", ""),
]


def luminance(color):
    def channel(c):
        c /= 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(int(color[i:i + 2], 16)) for i in (1, 3, 5))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    x, y = sorted((luminance(a), luminance(b)), reverse=True)
    return (x + 0.05) / (y + 0.05)


def rules(palette):
    out = []
    for scopes, name, style in SCOPES:
        setting = {"foreground": palette[name]}
        if style:
            setting["fontStyle"] = style
        out.append({"scope": scopes, "settings": setting})
    return out


if __name__ == "__main__":
    for mode, palette in PALETTES.items():
        for name, color in palette.items():
            if len(color) == 7:
                ratio = contrast(color, BACKGROUND[mode])
                least = SUBTLE.get(name, 4.5)
                assert ratio >= least, f"{mode} {name} {color}: contrast {ratio:.1f} is below {least}"
                print(f"{mode:5} {name:9} {color}  contrast {ratio:4.1f}")

    path = Path(__file__).parent / "package.json"
    package = json.loads(path.read_text())
    defaults = package["contributes"]["configurationDefaults"]
    defaults["editor.tokenColorCustomizations"] = {
        "textMateRules": rules(PALETTES["dark"]),
        "[*Light*]": {"textMateRules": rules(PALETTES["light"])},
    }
    # phrases, variables, a library's keywords (the words of definitions that keep their
    # arguments' words, statements, aliases, modifiers), and word lists (number words)
    semantic = lambda palette: {"function:def-lang": palette["phrase"], "variable:def-lang": palette["variable"],
                                "keyword:def-lang": palette["keyword"], "number:def-lang": palette["number"]}
    defaults["editor.semanticTokenColorCustomizations"] = {
        "rules": semantic(PALETTES["dark"]),
        "[*Light*]": {"rules": semantic(PALETTES["light"])},
    }
    package["contributes"].pop("defLangUnderline", None)
    props = package["contributes"]["configuration"]["properties"]
    for name in ("wordColor", "argumentColor"):
        props[f"def-lang.underline.{name}"]["default"] = ""
    props["def-lang.underline.wordColor"]["description"] = (
        "Color of the hover underline under a def's fixed words: a theme color id (like charts.blue) "
        "or a #rrggbb color. Empty: the palette's steel blue, for light and dark themes.")
    props["def-lang.underline.argumentColor"]["description"] = (
        "Color of the hover underline under the parts that fill a def's arguments: a theme color id "
        "(like charts.yellow) or a #rrggbb color. Empty: the palette's gold dashes, for light and dark themes.")
    path.write_text(json.dumps(package, indent=2, ensure_ascii=False) + "\n")
    (Path(__file__).parent / "palette.json").write_text(json.dumps({"underline": UNDERLINE}, indent=2) + "\n")
    print("wrote", path, "and palette.json")
