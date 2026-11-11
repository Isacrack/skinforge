#!/usr/bin/env python3
"""Compila src/* en un único index.html autocontenido (sin recursos externos)."""
import pathlib

ROOT = pathlib.Path(__file__).parent
src = ROOT / "src"

tpl = (src / "index.template.html").read_text(encoding="utf-8")
css = (src / "style.css").read_text(encoding="utf-8")
pck = (src / "pck.js").read_text(encoding="utf-8")
app = (src / "app.js").read_text(encoding="utf-8")

out = (tpl
       .replace("/*@@CSS@@*/", css)
       .replace("/*@@PCK@@*/", pck)
       .replace("/*@@APP@@*/", app))

target = ROOT / "index.html"
target.write_text(out, encoding="utf-8")
print(f"OK → {target}  ({len(out)/1024:.1f} KB)")
