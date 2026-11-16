# Renders the README banner and the installer's images from tools/brand, with Edge.
# Run tools/make_icon.py first if the icon changed.
$root = Split-Path $PSScriptRoot
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
$brand = Join-Path $PSScriptRoot 'brand'
$tmp = Join-Path $env:TEMP 'vela-brand'
New-Item -ItemType Directory -Force $tmp, "$root\docs", "$root\src-tauri\installer" | Out-Null

function Shot($page, $query, $width, $height, $scale, $out) {
    $url = ([Uri](Join-Path $brand $page)).AbsoluteUri + $query
    & $edge --headless=new --disable-gpu --hide-scrollbars --no-first-run "--user-data-dir=$tmp\profile" `
        "--force-device-scale-factor=$scale" "--window-size=$width,$height" --virtual-time-budget=3000 "--screenshot=$out" $url 2>$null | Out-Null
}

Shot 'banner.html' '' 1280 400 2 "$tmp\banner.png"
Shot 'installer.html' '?panel' 656 1256 1 "$tmp\panel.png"
Shot 'installer.html' '?header' 600 228 1 "$tmp\header.png"

# NSIS wants plain 24-bit bitmaps at exact sizes.
python -c @"
from PIL import Image
Image.open(r'$tmp\panel.png').convert('RGB').resize((164, 314), Image.LANCZOS).save(r'$root\src-tauri\installer\sidebar.bmp')
Image.open(r'$tmp\header.png').convert('RGB').resize((150, 57), Image.LANCZOS).save(r'$root\src-tauri\installer\header.bmp')
Image.open(r'$tmp\banner.png').convert('RGB').save(r'$root\docs\banner.jpg', quality=92, optimize=True, progressive=True)
print('ok')
"@
