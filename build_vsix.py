"""Packs this folder into def-lang-<version>.vsix without Node or vsce, with the
interpreter inside it: the deflang project next to this repo (../deflang), or the
folder in $DEFLANG. Libraries are not part of it:
a program installs them (python -m deflang install ...).
Install it with:  code --install-extension def-lang-<version>.vsix"""
import json
import os
import zipfile
from pathlib import Path

HERE = Path(__file__).parent
FILES = ["package.json", "language-configuration.json", "syntaxes/def.tmLanguage.json", "README.md",
         "extension.js", "lib.js", "palette.json"]

INTERPRETER = Path(os.environ.get("DEFLANG", HERE.parent / "deflang")).resolve()
if not (INTERPRETER / "execute.py").is_file():
    raise SystemExit(f"the def-lang interpreter isn't at {INTERPRETER}: put the deflang project next to this repo, or set DEFLANG")

package = json.loads((HERE / "package.json").read_text())
manifest = f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{package['name']}" Version="{package['version']}" Publisher="{package['publisher']}" />
    <DisplayName>{package['displayName']}</DisplayName>
    <Description xml:space="preserve">{package['description']}</Description>
    <Categories>Programming Languages</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{package['engines']['vscode']}" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
"""
content_types = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".py" ContentType="text/x-python" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>
"""
out = HERE / f"{package['name']}-{package['version']}.vsix"
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as vsix:
    vsix.writestr("extension.vsixmanifest", manifest)
    vsix.writestr("[Content_Types].xml", content_types)
    for name in FILES:
        vsix.write(HERE / name, f"extension/{name}")
    # the interpreter: python -m deflang, with the extension's folder on PYTHONPATH
    for file in sorted(INTERPRETER.glob("*.py")):
        vsix.write(file, "extension/deflang/" + file.name)

with zipfile.ZipFile(out) as vsix:
    names = set(vsix.namelist())
needed = {"extension/deflang/__init__.py", "extension/deflang/__main__.py", "extension/deflang/libraries.py",
          "extension/deflang/execute.py", "extension/deflang/tree.py", "extension/extension.js", "extension/lib.js"}
missing = needed - names
if missing:
    raise SystemExit(f"the package is missing {sorted(missing)}")
if any(name.endswith(".def") for name in names):
    raise SystemExit("the package has .def files: libraries are installed separately")
print("wrote", out)
