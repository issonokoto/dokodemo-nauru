param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$project = Join-Path $workspace 'google-play/android-project'
$version = (Get-Content -LiteralPath (Join-Path $project 'twa-manifest.json') -Raw | ConvertFrom-Json).appVersionName
$output = Join-Path $workspace "outputs/android-update-$version"
$jdk = Join-Path $workspace 'tmp/jdk17/jdk-17.0.19+10'
$sdk = Join-Path $workspace 'tmp/android-sdk'
$signingKey = Join-Path $workspace 'google-play-private/dokodemo-nauru-upload.keystore'
$credentialFile = Join-Path $workspace 'google-play-private/dokodemo-nauru-upload-credentials.txt'

New-Item -ItemType Directory -Path $output -Force | Out-Null
$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:GRADLE_USER_HOME = Join-Path $workspace 'tmp/gradle-home-agp9'
$env:DOKODEMO_BUILD_DIR = Join-Path $output 'build'

if (!$SkipBuild) {
    Push-Location $project
    try {
        & './gradlew.bat' :app:assembleRelease :app:bundleRelease :app:lintRelease --no-daemon --console=plain
        if ($LASTEXITCODE -ne 0) { throw 'Android release build failed.' }
    } finally {
        Pop-Location
    }
}

$credentialLines = Get-Content -LiteralPath $credentialFile
$passwordLine = $credentialLines | Where-Object { $_ -match '^Password\s*:' } | Select-Object -First 1
$aliasLine = $credentialLines | Where-Object { $_ -match '^Alias\s*:' } | Select-Object -First 1
if (!$passwordLine -or !$aliasLine) { throw 'Signing credential fields were not found.' }
$env:DOKODEMO_KEY_PASSWORD = ($passwordLine -replace '^Password\s*:\s*', '').Trim()
$keyAlias = ($aliasLine -replace '^Alias\s*:\s*', '').Trim()

try {
    $unsignedApk = Join-Path $output 'build/outputs/apk/release/app-release-unsigned.apk'
    $alignedApk = Join-Path $output 'app-release-aligned.apk'
    $signedApk = Join-Path $workspace "google-play/dokodemo-nauru-$version-test.apk"
    $signedBundle = Join-Path $workspace "google-play/dokodemo-nauru-$version-optimized-signed.aab"

    & (Join-Path $sdk 'build-tools/36.0.0/zipalign.exe') -P 16 -f 4 $unsignedApk $alignedApk
    if ($LASTEXITCODE -ne 0) { throw 'APK alignment failed.' }
    & (Join-Path $sdk 'build-tools/36.0.0/apksigner.bat') sign --ks $signingKey --ks-key-alias $keyAlias --ks-pass env:DOKODEMO_KEY_PASSWORD --key-pass env:DOKODEMO_KEY_PASSWORD --out $signedApk $alignedApk
    if ($LASTEXITCODE -ne 0) { throw 'APK signing failed.' }
    & (Join-Path $sdk 'build-tools/36.0.0/apksigner.bat') verify --verbose --print-certs $signedApk *> (Join-Path $output 'apk-signature-verification.txt')
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
    Get-Content -LiteralPath (Join-Path $output 'apk-signature-verification.txt') | Select-String -Pattern '^Verifies$|Verified using v[123] scheme|certificate SHA-256'

    & (Join-Path $jdk 'bin/jarsigner.exe') -keystore $signingKey -storepass:env DOKODEMO_KEY_PASSWORD -keypass:env DOKODEMO_KEY_PASSWORD -sigalg SHA256withRSA -digestalg SHA-256 -signedjar $signedBundle (Join-Path $output 'build/outputs/bundle/release/app-release.aab') $keyAlias *> (Join-Path $output 'bundle-signing.txt')
    if ($LASTEXITCODE -ne 0) { throw 'App Bundle signing failed.' }
    & (Join-Path $jdk 'bin/jarsigner.exe') -verify $signedBundle *> (Join-Path $output 'bundle-signature-verification.txt')
    if ($LASTEXITCODE -ne 0) { throw 'App Bundle signature verification failed.' }

    Get-Item -LiteralPath $signedApk, $signedBundle | Select-Object Name, Length
} finally {
    Remove-Item Env:/DOKODEMO_KEY_PASSWORD -ErrorAction SilentlyContinue
}
