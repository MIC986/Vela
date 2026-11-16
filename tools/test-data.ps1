# Builds .test-data from a copy of the real library, plus a harmless fake game, so
# the interface suites see real artwork without ever touching the real data.
$source = "$env:LOCALAPPDATA\com.vela.launcher"
if (-not (Test-Path "$source\library.json")) { $source = "$env:LOCALAPPDATA\Vela" }
$t = Join-Path (Split-Path $PSScriptRoot) '.test-data'
Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$t\art", "$t\fakegame", "$t\watch" | Out-Null
Copy-Item "$source\library.json", "$source\cache.json" $t
Copy-Item "$source\art\*" "$t\art"
Copy-Item "$env:WINDIR\System32\cmd.exe" "$t\fakegame\FakeGame.exe"

$exe = "$t\fakegame\FakeGame.exe"
$user = @{ custom = @(@{
    id = 'custom:faketest'; title = 'Fake Test Game'; source = 'local'; installed = $true
    install_dir = "$t\fakegame"; exe = $exe
    launch = @{ kind = 'exe'; path = $exe; args = '/c ping -n 22 127.0.0.1 >nul'; cwd = "$t\fakegame" }
}) }
$settings = @{ scan_folders = @("$t\watch"); sound = $false; online_art_asked = $true; gamepass_asked = $true; gamepass_on = $true }
$utf8 = New-Object Text.UTF8Encoding $false
[IO.File]::WriteAllText("$t\user.json", ($user | ConvertTo-Json -Depth 6), $utf8)
[IO.File]::WriteAllText("$t\settings.json", ($settings | ConvertTo-Json -Depth 3), $utf8)
"test data ready"
