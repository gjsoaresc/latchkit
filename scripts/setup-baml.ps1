$ErrorActionPreference = 'Stop'
$version = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '../.baml-version') -Raw).Trim()
if ($version -ne '0.17.0') { throw 'Review the BAML CLI and runtime together before changing this pin.' }
& ([scriptblock]::Create((Invoke-RestMethod 'https://pkg.boundaryml.com/install.ps1'))) -Version $version -Yes
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'BAML installation failed.' }
$env:BAML_VERSION = $version
$baml = Join-Path $env:USERPROFILE '.baml/bin/baml.exe'
& $baml agent install
if ($LASTEXITCODE -ne 0) { throw 'BAML agent skill installation failed.' }
& $baml run main
if ($LASTEXITCODE -ne 0) { throw 'BAML credential-free smoke failed.' }
