"""Prints a readable summary of `vela --dump-scan` output."""
import collections
import json
import sys

games = json.load(open(sys.argv[1], encoding="utf-8-sig"))
by = collections.Counter((g["source"], g["installed"]) for g in games)
for (source, installed), count in sorted(by.items()):
    print(f"{source:10} {'installed' if installed else 'not installed':14} {count}")
print()
sources = sys.argv[2].split(",") if len(sys.argv) > 2 else None
for g in sorted(games, key=lambda g: (g["source"], not g["installed"], g["title"].lower())):
    if sources and g["source"] not in sources:
        continue
    mark = "*" if g["installed"] else " "
    where = g.get("exe") or g.get("dir") or ""
    print(f"{mark} [{g['source']:7}] {g['title'][:44]:44} {where[:80]}")
