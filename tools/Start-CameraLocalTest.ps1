param([string]$Serial)
$ErrorActionPreference = 'Stop'
$cameraWorkspace = Split-Path -Parent $PSScriptRoot
$cameraRoot = Join-Path $cameraWorkspace 'github-dokodemo-nauru'
$cameraAdb = Join-Path $cameraWorkspace 'tmp/android-sdk/platform-tools/adb.exe'
$cameraPython = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
if (!(Test-Path -LiteralPath $cameraPython)) { throw 'Python runtime was not found.' }
if (!(Test-Path -LiteralPath $cameraAdb)) { throw 'Android device tools were not found.' }
try {
    $cameraResponse = Invoke-WebRequest 'http://localhost:8765/camera/' -UseBasicParsing -TimeoutSec 2
    if ($cameraResponse.Content -notmatch 'camera-stage') { throw 'Port 8765 is used by another server.' }
} catch {
    if (Get-NetTCPConnection -State Listen -LocalPort 8765 -ErrorAction SilentlyContinue) { throw 'Port 8765 is used by another server.' }
    $cameraServer = Start-Process -FilePath $cameraPython -ArgumentList @('-m', 'http.server', '8765', '--bind', '127.0.0.1', '--directory', ('"' + $cameraRoot + '"')) -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP/nauru-camera-server.log" -RedirectStandardError "$env:TEMP/nauru-camera-server-error.log" -PassThru
    Start-Sleep -Milliseconds 1000
    Write-Output "Local test server started (PID $($cameraServer.Id))."
}
if (!$Serial) {
    $cameraDevices = @(& $cameraAdb devices | Select-String '^([^\s]+)\s+device$' | ForEach-Object { $_.Matches[0].Groups[1].Value })
    if ($cameraDevices.Count -ne 1) { throw 'Connect one authorized Android device, or specify -Serial.' }
    $Serial = $cameraDevices[0]
}
& $cameraAdb -s $Serial reverse tcp:8765 tcp:8765
if ($LASTEXITCODE -ne 0) { throw 'Could not connect the device to the local server.' }
& $cameraAdb -s $Serial shell am start -a android.intent.action.VIEW -d 'http://localhost:8765/camera/' -p com.android.chrome
if ($LASTEXITCODE -ne 0) { throw 'Could not open Chrome on the device.' }
Write-Output 'Camera local test: http://localhost:8765/camera/'
