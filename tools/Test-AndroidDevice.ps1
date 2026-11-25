param(
    [Parameter(Mandatory)][string]$Serial,
    [Parameter(Mandatory)][string]$Step,
    [ValidateSet('Capture', 'Tap')][string]$Action = 'Capture',
    [string]$Text,
    [string]$Description
)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $workspace 'google-play/android-project/twa-manifest.json') -Raw | ConvertFrom-Json).appVersionName
$output = Join-Path $workspace "outputs/android-update-$version"
$adb = Join-Path $workspace 'tmp/android-sdk/platform-tools/adb.exe'
$xmlPath = Join-Path $output "$Step.xml"
if ($Step -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Use a simple step name.' }
New-Item -ItemType Directory -Path $output -Force | Out-Null

& $adb -s $Serial shell uiautomator dump /sdcard/dokodemo-test-ui.xml | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Device UI dump failed.' }
& $adb -s $Serial pull /sdcard/dokodemo-test-ui.xml $xmlPath | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Device UI transfer failed.' }
[xml]$ui = Get-Content -LiteralPath $xmlPath -Raw
$nodes = @($ui.SelectNodes('//node') | Where-Object { $_.bounds -ne '[0,0][0,0]' })

if ($Action -eq 'Tap') {
    if (!$Text -and !$Description) { throw 'A UI text or description is required.' }
    $target = $nodes | Where-Object {
        (!$Text -or $_.text -eq $Text) -and (!$Description -or $_.'content-desc' -eq $Description)
    } | Select-Object -First 1
    if (!$target) {
        # Chrome may rebuild its accessibility tree after a navigation-mode change.
        & $adb -s $Serial shell input keyevent 61
        & $adb -s $Serial shell uiautomator dump /sdcard/dokodemo-test-ui.xml | Out-Null
        & $adb -s $Serial pull /sdcard/dokodemo-test-ui.xml $xmlPath | Out-Null
        [xml]$ui = Get-Content -LiteralPath $xmlPath -Raw
        $target = $ui.SelectNodes('//node') | Where-Object {
            $_.bounds -ne '[0,0][0,0]' -and
            (!$Text -or $_.text -eq $Text) -and (!$Description -or $_.'content-desc' -eq $Description)
        } | Select-Object -First 1
    }
    if (!$target) { throw 'The requested control is not visible in the device UI tree.' }
    if ($target.bounds -notmatch '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') { throw 'Control bounds are unavailable.' }
    $tapX = [int](([int]$matches[1] + [int]$matches[3]) / 2)
    $tapY = [int](([int]$matches[2] + [int]$matches[4]) / 2)
    & $adb -s $Serial shell input tap $tapX $tapY
    if ($LASTEXITCODE -ne 0) { throw 'Device tap failed.' }
    Start-Sleep -Milliseconds 1600
    Write-Output "Tapped $($target.text) $($target.'content-desc') at $tapX,$tapY using UI bounds."
} else {
    & $adb -s $Serial shell screencap -p /sdcard/dokodemo-test-screen.png
    if ($LASTEXITCODE -ne 0) { throw 'Device screenshot failed.' }
    & $adb -s $Serial pull /sdcard/dokodemo-test-screen.png (Join-Path $output "$Step.png") | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Device screenshot transfer failed.' }
    $nodes | Where-Object { $_.text -or $_.'content-desc' } | ForEach-Object {
        '{0} | {1} | {2}' -f $_.text, $_.'content-desc', $_.bounds
    }
}
