"""Puts a hand-picked set of games at the front of .test-data, for the README's screenshots.

Run after tools/test-data.ps1. Only the test copy changes; the real library never does.
"""
import json
import os
import sys
import time

FRONT = [
    "Cyberpunk 2077", "Red Dead Redemption 2", "Forza Horizon 6", "Battlefield™ 6", "Grand Theft Auto V Enhanced",
    "Minecraft Dungeons II", "Counter-Strike 2", "Microsoft Flight Simulator 2024", "Hearts of Iron IV", "Bloons TD 6",
    "Among Us", "Oxygen Not Included", "Mini Motorways", "Plague Inc: Evolved", "WorldBox - God Simulator",
]

data = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".test-data")
games = json.load(open(os.path.join(data, "library.json"), encoding="utf-8"))
user_path = os.path.join(data, "user.json")
user = json.load(open(user_path, encoding="utf-8-sig"))
now = int(time.time())
played = user.setdefault("last_played", {})
for i, title in enumerate(FRONT):
    match = [g for g in games if g["title"] == title and g.get("installed")] or [g for g in games if g["title"] == title]
    if not match:
        print("not found:", title, file=sys.stderr)
        continue
    played[match[0]["id"]] = now - 3600 - i * 900
json.dump(user, open(user_path, "w", encoding="utf-8"))
print("front row set:", len(played))
