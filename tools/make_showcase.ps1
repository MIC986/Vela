# Frames the raw README screenshots (from tools/ui-readme.mjs) for docs/screenshots.
# Usage: tools\make_showcase.ps1 -Raw <folder of raw shots>
param([Parameter(Mandatory)] [string]$Raw)
$root = Split-Path $PSScriptRoot
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
$page = ([Uri](Join-Path $PSScriptRoot 'brand\showcase.html')).AbsoluteUri
$from = ([Uri](Resolve-Path $Raw).Path).AbsoluteUri
$tmp = Join-Path $env:TEMP 'vela-showcase'
$out = Join-Path $root 'docs\screenshots'
New-Item -ItemType Directory -Force $tmp, $out | Out-Null
Get-ChildItem $out -Filter *.jpg | Remove-Item

function Render($query, $height, $name) {
    & $edge --headless=new --disable-gpu --hide-scrollbars --no-first-run "--user-data-dir=$tmp\profile" `
        --force-device-scale-factor=1.5 "--window-size=1600,$height" --virtual-time-budget=4000 `
        "--allow-file-access-from-files" "--screenshot=$tmp\$name.png" "$($page)?$query&from=$from" 2>$null | Out-Null
}

Render 'hero=home,browse,stats' 780 'hero'
foreach ($shot in 'browse', 'series', 'game', 'library', 'stats', 'fullscreen') { Render "shot=$shot" 980 $shot }

python -c @"
from PIL import Image
import glob, os
for f in glob.glob(r'$tmp\*.png'):
    name = os.path.splitext(os.path.basename(f))[0]
    Image.open(f).convert('RGB').save(os.path.join(r'$out', name + '.jpg'), quality=86, optimize=True, progressive=True)
    print(name, os.path.getsize(os.path.join(r'$out', name + '.jpg')) // 1024, 'KB')
"@
