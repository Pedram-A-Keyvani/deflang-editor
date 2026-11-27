"""Writes syntaxes/def.tmLanguage.json. Edit this file, then run: python3 make_grammar.py"""
import json
import re
from pathlib import Path

# Languages the editor can colour. def-lang itself learns languages from
# `language NAME` lines, so any other declared language works too; its body just
# isn't coloured until it is added here.
LANGUAGES = {  # flag word -> (VS Code grammar scope, VS Code language id)
    "python": ("source.python", "python"),
    "html": ("text.html.basic", "html"),
    "css": ("source.css", "css"),
    "javascript": ("source.js", "javascript"),
    "js": ("source.js", "javascript"),
    "sql": ("source.sql", "sql"),
    "markdown": ("text.html.markdown", "markdown"),
    "json": ("source.json", "json"),
    "shell": ("source.shell", "shellscript"),
    "bash": ("source.shell", "shellscript"),
    "yaml": ("source.yaml", "yaml"),
}
FLAG = r"(?:as\s+written|regex|" + "|".join(LANGUAGES) + ")"
CYCLES = r"(?:file|line|define|call|body|scope)"
PHASES = r"(?:start|end|error)"
NUMBER_WORDS = ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
                "fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy "
                "eighty ninety hundred thousand million billion").split()
# words for the comparison and math symbols (comparison.def, math.def)
OPERATOR_WORDS = sorted([
    "is greater than or equal to", "greater than or equal to", "is less than or equal to",
    "less than or equal to", "is greater than", "greater than", "is less than", "less than",
    "is equal to", "equal to", "plus", "minus", "divided by", "multiplied by",
], key=len, reverse=True)
# Library phrases (say, sum of, home page, ...) are coloured by the extension from the
# real defs (semantic colours), so they aren't listed here.


def words(items):
    return r"\b(?:" + "|".join(r"\s+".join(map(re.escape, item.split())) for item in items) + r")\b"


VIEW_TAG = {
    # <view path="..." title="...">: def-lang's own tag, a normal tag in HTML bodies
    "name": "meta.tag.view.html",
    "begin": r"(</?)(view)\b",
    "beginCaptures": {"1": {"name": "punctuation.definition.tag.begin.html"}, "2": {"name": "entity.name.tag.html"}},
    "end": r"(/?>)",
    "endCaptures": {"1": {"name": "punctuation.definition.tag.end.html"}},
    "patterns": [{"include": "text.html.basic#attribute"}],
}


def body_rule(name, scope):
    """def ... NAME ...: the indented body below is written in that language."""
    inner = ([VIEW_TAG] if name == "html" else []) + [{"include": scope}]
    return {
        "name": f"meta.def.{name}.def",
        "begin": rf"^(def)\s+(?=(?:{FLAG}\s+)*{name}\s)((?:{FLAG}\s+)+)(.*)$",
        "beginCaptures": {
            "1": {"name": "storage.type.def.def"},
            "2": {"patterns": [{"include": "#flags"}]},
            "3": {"patterns": [{"include": "#pattern"}]},
        },
        "end": r"^(?=\S)",
        "patterns": [{"name": f"meta.embedded.block.{name}", "begin": r"^(?=[ \t])", "end": r"^(?=\S)", "patterns": inner}],
    }


def hook_rule(name, scope):
    """hook CYCLE PHASE in NAME: the indented body below is written in that language.
    `\1` is the field's own indent, so the next field at the same level ends the body."""
    inner = ([VIEW_TAG] if name == "html" else []) + [{"include": scope}]
    return {
        "name": f"meta.hook.{name}.def",
        "begin": rf"^(\s*)(hook)\s+({CYCLES})\s+({PHASES})\s+in\s+({name})(\[[^\]]*\])?\s*$",
        "beginCaptures": {
            "2": {"name": "storage.type.def.def"},
            "3": {"name": "keyword.control.def"},
            "4": {"name": "keyword.control.def"},
            "5": {"name": "storage.modifier.def"},
            "6": {"patterns": [{"include": "#flags"}]},
        },
        "end": r"^(?=\1\S|\S)",
        "patterns": [{"name": f"meta.embedded.block.{name}", "begin": r"^(?=[ \t])", "end": r"^(?=\S)", "patterns": inner}],
    }


grammar = {
    "$schema": "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
    "name": "def-lang",
    "scopeName": "source.def",
    "patterns": [
        # no comment rule: a file's comment marker can change (`comment is #`), so
        # comments are coloured by the extension, which knows the marker of each line
        {"include": "#language-line"},
        *[{"include": f"#hook-{name}-line"} for name in LANGUAGES],
        *[{"include": f"#{name}-def"} for name in LANGUAGES],
        {"include": "#def"},
        {"include": "#statement"},
        {"include": "#means"},
        {"include": "#echo"},
        {"include": "#expression"},
    ],
    "repository": {
        # language NAME: its indented body is the Python that runs that language
        "language-line": {
            "name": "meta.language.def",
            "begin": r"^(language)\s+(\w+)\s*$",
            "beginCaptures": {"1": {"name": "storage.type.def.def"}, "2": {"name": "storage.modifier.def"}},
            "end": r"^(?=\S)",
            "patterns": [{"name": "meta.embedded.block.python", "begin": r"^(?=[ \t])", "end": r"^(?=\S)",
                          "patterns": [{"include": "source.python"}]}],
        },
        **{f"{name}-def": body_rule(name, scope) for name, (scope, _) in LANGUAGES.items()},
        **{f"hook-{name}-line": hook_rule(name, scope) for name, (scope, _) in LANGUAGES.items()},

        # def ... : the indented body below is def-lang (handled by the top-level patterns)
        "def": {
            "match": rf"^(def)\s+((?:{FLAG}\s+)*)(.*)$",
            "captures": {
                "1": {"name": "storage.type.def.def"},
                "2": {"patterns": [{"include": "#flags"}]},
                "3": {"patterns": [{"include": "#pattern"}]},
            },
        },

        # each flag on a def line; `as written` has its own colour
        "flags": {
            "patterns": [
                {"name": "storage.modifier.as-written.def", "match": r"as\s+written"},
                {"name": "storage.modifier.def", "match": r"regex|" + "|".join(LANGUAGES)},
            ]
        },

        "pattern": {
            "patterns": [
                {
                    "match": r"(\()(A\d+)(:)\s*(.*)(\))",
                    "captures": {
                        "1": {"name": "punctuation.definition.parameter.def"},
                        "2": {"name": "variable.parameter.def"},
                        "3": {"name": "punctuation.separator.def"},
                        "4": {"name": "string.regexp.def"},
                        "5": {"name": "punctuation.definition.parameter.def"},
                    },
                },
                {"name": "variable.parameter.def", "match": r"\bA\d+\b"},
                {"name": "keyword.operator.def", "match": r"[^\w\s]+"},
                {"name": "entity.name.function.def", "match": r"[\w.]+"},
            ]
        },

        "statement": {
            "patterns": [
                {
                    "match": r"^(use)\s+(?:(.+?)\s+(from)\s+)?(\S+)\s*$",
                    "captures": {"1": {"name": "keyword.control.import.def"}, "2": {"name": "variable.other.def"},
                                 "3": {"name": "keyword.control.import.def"}, "4": {"name": "entity.name.namespace.def"}},
                },
                {
                    "match": r"^(argument|comment)\s+(is)\s+(.*)$",
                    "captures": {
                        "1": {"name": "keyword.control.def"},
                        "2": {"name": "keyword.control.def"},
                        "3": {"name": "variable.parameter.def"},
                    },
                },
                {
                    "match": r"^\s*(shared)\s+(\w+)",
                    "captures": {"1": {"name": "keyword.control.def"}, "2": {"name": "variable.other.def"}},
                },
                {
                    "match": r"^(indent)\s+(\d+)\s*$",
                    "captures": {"1": {"name": "keyword.control.def"}, "2": {"name": "constant.numeric.def"}},
                },
                {
                    "match": r"^\s*(error)\s+(.*)$",
                    "captures": {"1": {"name": "keyword.control.error.def"}, "2": {"name": "invalid.illegal.message.def"}},
                },
            ]
        },

        # greater than means >
        "means": {
            "match": r"^(?!def\s|use\s|comment\s|argument\s|error\s)(\S.*?)\s+(means)\s+(.*)$",
            "captures": {
                "1": {"name": "entity.name.function.def"},
                "2": {"name": "keyword.control.means.def"},
                "3": {"patterns": [{"include": "#expression"}]},
            },
        },

        # `line` : printed, then run
        "echo": {
            "name": "meta.echo.def",
            "begin": r"^\s*(`)",
            "end": r"(`)\s*$",
            "beginCaptures": {"1": {"name": "punctuation.definition.echo.def"}},
            "endCaptures": {"1": {"name": "punctuation.definition.echo.def"}},
            "patterns": [{"include": "#expression"}],
        },

        "expression": {
            "patterns": [
                {
                    "name": "string.quoted.double.def",
                    "begin": '"',
                    "end": '"',
                    "beginCaptures": {"0": {"name": "punctuation.definition.string.begin.def"}},
                    "endCaptures": {"0": {"name": "punctuation.definition.string.end.def"}},
                },
                {"name": "variable.parameter.def", "match": r"\bA\d+\b"},
                {"name": "keyword.control.question.def", "match": r"\?"},
                {"name": "keyword.control.loop.def", "match": words(["repeat", "times", "while", "for each", "in", "if", "otherwise"])},
                {"name": "keyword.other.operator.def", "match": words(OPERATOR_WORDS)},
                {"name": "keyword.other.logical.def", "match": words(["both", "and", "either", "or", "not"])},
                {"name": "keyword.control.means.def", "match": words(["means"])},
                {"name": "keyword.other.shared.def", "match": r"^\s*shared(?=\s)"},
                {"name": "keyword.other.def", "match": words(["is not", "is", "are", "does", "do"])},
                {"name": "constant.numeric.def", "match": r"(?<![\w.])[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b"},
                {"name": "constant.numeric.word.def", "match": words(NUMBER_WORDS)},
                {"name": "constant.language.def", "match": r"\b(?:True|False|None)\b"},
                {"name": "keyword.operator.def", "match": r">=|<=|[<>=+\-*/#:]"},
                {"name": "punctuation.section.brackets.def", "match": r"[\[\],]"},
            ]
        },
    },
}

# Python's re is close enough to Oniguruma to catch typos in the regexes above
def check(node):
    if isinstance(node, dict):
        for key in ("match", "begin", "end"):
            if key in node:
                # an `end` can use its rule's `begin` indent through \1: give Python's
                # standalone compile a capture to refer to
                re.compile((r"(.*)" if key == "end" else "") + node[key])
        for value in node.values():
            check(value)
    elif isinstance(node, list):
        for value in node:
            check(value)


check(grammar)
# which embedded block is which VS Code language (for comments, brackets, ...)
package_path = Path(__file__).parent / "package.json"
package = json.loads(package_path.read_text())
package["contributes"]["grammars"][0]["embeddedLanguages"] = {
    f"meta.embedded.block.{name}": language for name, (_, language) in LANGUAGES.items()}
package_path.write_text(json.dumps(package, indent=2, ensure_ascii=False) + "\n")

path = Path(__file__).parent / "syntaxes" / "def.tmLanguage.json"
path.write_text(json.dumps(grammar, indent=2, ensure_ascii=False) + "\n")
print("wrote", path)
