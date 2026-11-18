# CI-only packaging. Never installs an MSI or runs the application.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$release = Join-Path $repo 'src-tauri/target/release'
$out = Join-Path $repo 'external-upload-windows-artifacts'
# New directories are required: avoid silently mixing outputs from older builds.
$stage = Join-Path $repo 'external-upload-windows-portable'
New-Item -ItemType Directory -Path $out -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
foreach ($name in @('AeroFTP.exe', 'aeroftp-cli.exe', 'aeroftp-dispatch.exe')) {
    $binary = Join-Path $release $name
    if (-not (Test-Path $binary -PathType Leaf)) { throw "Missing production binary: $binary" }
    Copy-Item $binary (Join-Path $stage $name)
}
Copy-Item (Join-Path $repo 'src-tauri/installer/portable/portable.marker') $stage
Copy-Item (Join-Path $repo 'LICENSE') (Join-Path $stage 'LICENSE.txt')
# Match the resource layout of the Windows Tauri bundle.
New-Item -ItemType Directory -Path (Join-Path $stage 'icons/mimetypes') -Force | Out-Null
$config = Get-Content (Join-Path $repo 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
foreach ($resource in $config.bundle.resources) {
    $destination = Join-Path $stage $resource
    New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
    Copy-Item (Join-Path $repo "src-tauri/$resource") $destination
}
Get-ChildItem $release -File -Filter '*.dll' | Copy-Item -Destination $stage

# Follow native imports so a non-system dependency cannot be omitted silently.
# Rust uses static CRT, but this also handles a future dynamic native dependency.
$pending = [System.Collections.Generic.Queue[string]]::new()
$seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
Get-ChildItem $stage -File | Where-Object { $_.Extension -in @('.exe', '.dll') } | ForEach-Object { $pending.Enqueue($_.FullName) }
$imports = [System.Collections.Generic.List[string]]::new()
while ($pending.Count -gt 0) {
    $binary = $pending.Dequeue()
    if (-not $seen.Add($binary)) { continue }
    $lines = & dumpbin /nologo /dependents $binary
    if ($LASTEXITCODE -ne 0) { throw "dumpbin failed for $binary" }
    foreach ($line in $lines) {
        if ($line -notmatch '^\s+([\w.+-]+\.dll)\s*$') { continue }
        $dll = $Matches[1]
        $imports.Add("$(Split-Path $binary -Leaf) -> $dll")
        $destination = Join-Path $stage $dll
        if (Test-Path $destination) { $pending.Enqueue($destination); continue }
        if ($dll -match '^(api-ms-|ext-ms-)') { continue }
        # OS DLLs stay with Windows; do not redistribute a runner's system files.
        if (Test-Path (Join-Path $env:SystemRoot "System32/$dll")) { continue }
        $candidate = Get-ChildItem $release -Recurse -File -Filter $dll |
            Where-Object { $_.FullName -notlike '*\bundle\*' } | Select-Object -First 1
        if (-not $candidate) { throw "Unresolved runtime DLL $dll imported by $binary" }
        Copy-Item $candidate.FullName $destination
        $pending.Enqueue($destination)
    }
}
$imports | Sort-Object -Unique | Set-Content (Join-Path $stage 'NATIVE-IMPORTS.txt') -Encoding utf8
@"
AeroFTP external-upload fork validation build
Commit: $env:GITHUB_SHA
Run: https://github.com/$env:GITHUB_REPOSITORY/actions/runs/$env:GITHUB_RUN_ID

Extract the portable ZIP to a NEW writable directory, then run AeroFTP.exe.
portable.marker keeps application data under the adjacent data directory.
No installation is needed; do not run the separately supplied installers for this test.
Requires Windows 10/11 x64 and an installed Microsoft Edge WebView2 Runtime.
This CI build is unsigned. It is not a published AeroFTP release.
Do not accept an upstream auto-update while validating this fork revision.
NATIVE-IMPORTS.txt records the inspected binary dependencies.
"@ | Set-Content (Join-Path $stage 'README.txt') -Encoding utf8
# Verify the recorded shipping features against the checked-out manifest.
$cargoManifest = Get-Content (Join-Path $repo 'src-tauri/Cargo.toml') -Raw
if ($cargoManifest -notmatch '(?ms)^\[features\]\s*\r?\n(?<body>.*?)(?=^\[|\z)') {
    throw 'Cargo [features] section missing'
}
$featureSection = $Matches['body']
if ($featureSection -notmatch '(?m)^default\s*=\s*\[(?<values>[^\]]*)\]') {
    throw 'Cargo default feature array missing or unsupported'
}
$manifestDefaults = @([regex]::Matches($Matches['values'], '"([^"\r\n]+)"') | ForEach-Object { $_.Groups[1].Value })
$recordedDefaults = @('aerorsync', 'local-stt', 'proton-native')
if (@(Compare-Object $recordedDefaults $manifestDefaults).Count -ne 0) {
    throw 'BUILD-INFO default_features differs from Cargo.toml; review the production feature set'
}
@{
    commit = $env:GITHUB_SHA
    repository = $env:GITHUB_REPOSITORY
    run_id = $env:GITHUB_RUN_ID
    version = $config.version
    build_command = 'npm run tauri build -- --ci'
    default_features = $manifestDefaults
} | ConvertTo-Json | Set-Content (Join-Path $stage 'BUILD-INFO.json') -Encoding utf8
function Write-Hashes([string] $Directory, [string] $Destination) {
    $files = @(Get-ChildItem $Directory -Recurse -File | Where-Object { $_.FullName -ne $Destination } | Sort-Object FullName)
    $files | ForEach-Object {
        $relative = [IO.Path]::GetRelativePath($Directory, $_.FullName).Replace('\', '/')
        "$((Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $relative"
    } | Set-Content $Destination -Encoding utf8
}
Write-Hashes $stage (Join-Path $stage 'SHA256SUMS.txt')
$zip = Join-Path $out "AeroFTP-$($config.version)-external-upload-$($env:GITHUB_SHA.Substring(0, 12))-portable-windows-x64.zip"
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
$installers = @(Get-ChildItem (Join-Path $release 'bundle/msi/*.msi') -File) + @(Get-ChildItem (Join-Path $release 'bundle/nsis/*.exe') -File)
if ($installers.Count -lt 2) { throw 'Expected both MSI and NSIS installers from the complete production Tauri build' }
$installers | Copy-Item -Destination $out
# Keep the stage outside the artifact directory for the required runtime smoke.
# Only the immutable ZIP and installers are uploaded as application payloads.
Write-Hashes $out (Join-Path $out 'SHA256SUMS.txt')
Get-ChildItem $out -File | Format-Table Name, Length
