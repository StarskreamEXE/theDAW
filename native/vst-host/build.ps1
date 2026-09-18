<#
.SYNOPSIS
    Configures, builds and installs thedaw-vst-host.exe.

.DESCRIPTION
    Keeps the build tree off the system drive by default (C: is nearly full on
    this machine) and copies only the finished binary back into the worktree at
    native/vst-host/bin/, which is gitignored.

.EXAMPLE
    .\build.ps1
    .\build.ps1 -Vst3 OFF
    .\build.ps1 -Clean -BuildDir E:\thedaw-build\vst-host
#>
[CmdletBinding()]
param(
    # ON by default: the host is only useful with the VST3 layer linked in. -Vst3 OFF still
    # builds the engine alone (null plugin + protocol), which is what the engine tests need when
    # no plugin is involved.
    [ValidateSet('ON', 'OFF')]
    [string]$Vst3 = 'ON',

    [string]$BuildDir = 'E:\thedaw-build\vst-host-engine',

    [ValidateSet('Release', 'Debug', 'RelWithDebInfo')]
    [string]$Config = 'Release',

    [switch]$Clean,

    [switch]$NoWerror
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Resolve-Cmake {
    $candidates = @(
        'C:\Program Files\Python313\Scripts\cmake.exe',
        'C:\Program Files\CMake\bin\cmake.exe'
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return $candidate }
    }
    $found = Get-Command cmake -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    throw 'cmake was not found. Install CMake or add it to PATH.'
}

$cmake = Resolve-Cmake
Write-Host "cmake:     $cmake"
Write-Host "source:    $here"
Write-Host "build dir: $BuildDir"
Write-Host "vst3:      $Vst3"

if ($Clean -and (Test-Path $BuildDir)) {
    Write-Host "Removing the existing build tree..."
    Remove-Item -Recurse -Force $BuildDir
}
if (-not (Test-Path $BuildDir)) {
    New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null
}

$werror = if ($NoWerror) { 'OFF' } else { 'ON' }

$configureArgs = @(
    '-S', $here,
    '-B', $BuildDir,
    '-A', 'x64',
    "-DTHEDAW_VST3=$Vst3",
    "-DTHEDAW_WERROR=$werror",
    "-DCMAKE_BUILD_TYPE=$Config"
)

$started = Get-Date
& $cmake @configureArgs
if ($LASTEXITCODE -ne 0) { throw "cmake configure failed with exit code $LASTEXITCODE" }

& $cmake --build $BuildDir --config $Config --parallel
if ($LASTEXITCODE -ne 0) { throw "cmake build failed with exit code $LASTEXITCODE" }

$candidates = @(
    (Join-Path $BuildDir "$Config\thedaw-vst-host.exe"),
    (Join-Path $BuildDir 'thedaw-vst-host.exe')
)
$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { throw "the build finished but thedaw-vst-host.exe was not found under $BuildDir" }

$binDir = Join-Path $here 'bin'
if (-not (Test-Path $binDir)) { New-Item -ItemType Directory -Force -Path $binDir | Out-Null }
$target = Join-Path $binDir 'thedaw-vst-host.exe'
Copy-Item -Force $exe $target

$elapsed = (Get-Date) - $started
$sizeKb = [math]::Round((Get-Item $target).Length / 1KB, 1)
Write-Host ''
Write-Host "built  $target"
Write-Host ("size   {0} KB" -f $sizeKb)
Write-Host ("time   {0:n1} s" -f $elapsed.TotalSeconds)
