param([string]$Version='latest',[string]$Root=$(Join-Path $env:LOCALAPPDATA 'Latchkit'),[string]$Artifact,[string]$Checksum)
$ErrorActionPreference='Stop'
if ($env:PROCESSOR_ARCHITECTURE -notmatch '^AMD64$') { throw 'Unsupported Windows target; only win32-x64 is available.' }
$target='win32-x64'; $releaseVersion=$Version
if (-not $Artifact -and $Version -eq 'latest') {
  $release=Invoke-RestMethod -Uri 'https://api.github.com/repos/willahealm/latchkit/releases/latest'
  $releaseVersion=([string]$release.tag_name) -replace '^v',''
  $asset=$release.assets | Where-Object { $_.name -eq "latchkit-$releaseVersion-$target.zip" } | Select-Object -First 1
  if (-not $releaseVersion -or -not $asset) { throw "Latest release has no $target archive." }; $Artifact=$asset.browser_download_url
}
if (-not $Artifact) { $Artifact="https://github.com/willahealm/latchkit/releases/download/v$releaseVersion/latchkit-$releaseVersion-$target.zip" }
if (-not $Checksum) { $Checksum="$Artifact.sha256" }
$temporary=Join-Path ([IO.Path]::GetTempPath()) ("latchkit-install-"+[guid]::NewGuid()); New-Item -ItemType Directory -Path $temporary | Out-Null
try {
  $archive=Join-Path $temporary 'bundle.zip'; $checksumFile=Join-Path $temporary 'bundle.sha256'
  if (Test-Path -LiteralPath $Artifact -PathType Leaf) { Copy-Item -LiteralPath $Artifact -Destination $archive } else { Invoke-WebRequest -Uri $Artifact -OutFile $archive }
  if (Test-Path -LiteralPath $Checksum -PathType Leaf) { Copy-Item -LiteralPath $Checksum -Destination $checksumFile } else { Invoke-WebRequest -Uri $Checksum -OutFile $checksumFile }
  $expected=(Get-Content -LiteralPath $checksumFile -Raw).Trim().Split()[0]
  # .NET hashing and extraction keep the bootstrap independent of PowerShell module autoload, which
  # Windows PowerShell 5.1 cannot perform when it inherits a PowerShell 7 PSModulePath (for example
  # when launched from pwsh or a CI runner); Get-FileHash and Expand-Archive live in script modules.
  $sha=[System.Security.Cryptography.SHA256]::Create(); $stream=[IO.File]::OpenRead($archive)
  try { $actual=([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-','').ToLowerInvariant() } finally { $stream.Dispose(); $sha.Dispose() }
  if ($expected -notmatch '^[a-fA-F0-9]{64}$' -or $actual -ne $expected.ToLowerInvariant()) { throw 'Archive SHA-256 verification failed.' }
  $bundle=Join-Path $temporary 'bundle'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($archive, $bundle)
  $node=Join-Path $bundle 'runtime/node.exe'; $entry=Join-Path $bundle 'app/dist/src/installation/entry.js'
  if (!(Test-Path -LiteralPath $node -PathType Leaf) -or !(Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'Archive has an unsupported bundle layout.' }
  $arguments=@($entry,'install','--root',$Root,'--bundle',$bundle,'--target',$target); if ($Version -ne 'latest') { $arguments+=@('--version',$Version) }
  & $node @arguments; if ($LASTEXITCODE) { throw "Installer manager failed: $LASTEXITCODE" }
  Write-Host ("Use the launcher at " + (Join-Path $Root 'bin/latchkit.ps1') + " or add its bin directory to your user PATH.")
} finally { Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue }
