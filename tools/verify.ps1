# Runs every interface suite against the release build, each on fresh test data.
$root = Split-Path $PSScriptRoot
$exe = Join-Path $root 'src-tauri\target\release\vela.exe'
$env:VELA_DATA_DIR = Join-Path $root '.test-data'
$env:VELA_DEBUG_PORT = '9333'
$env:VELA_SHOTS = Join-Path $env:TEMP 'vela-shots'
New-Item -ItemType Directory -Force $env:VELA_SHOTS | Out-Null

$failed = 0
foreach ($suite in 'ui-feel', 'ui-flows', 'ui-art', 'ui-pad', 'ui-live', 'ui-pass', 'ui-new') {
    & "$PSScriptRoot\test-data.ps1" | Out-Null
    Get-Process vela -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 500
    $vela = Start-Process $exe -PassThru
    $lines = & node "$PSScriptRoot\cdp.mjs" "$PSScriptRoot\$suite.mjs" 2>&1
    Stop-Process -Id $vela.Id -Force -ErrorAction SilentlyContinue
    $passed = @($lines | Where-Object { "$_" -match '^PASS' }).Count
    $bad = @($lines | Where-Object { "$_" -match '^FAIL|EXCEPTION|^--- console|Error:' })
    $failed += $bad.Count
    "$suite : $passed passed, $($bad.Count) failed"
    $bad
}
Remove-Item -LiteralPath $env:VELA_DATA_DIR -Recurse -Force -ErrorAction SilentlyContinue
exit [int]($failed -gt 0)
