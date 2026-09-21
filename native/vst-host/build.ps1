<#
.SYNOPSIS
    Configures, builds and installs thedaw-vst-host.exe.

.DESCRIPTION
    Builds out of source and copies only the finished binary back into the
    worktree at native/vst-host/bin/, which is gitignored.

    The build tree defaults to native/vst-host/build, gitignored beside it, so
    the script works on a machine that has nothing but a system drive. Put it
    somewhere else - a scratch volume, a faster disk - with -BuildDir or the
    THEDAW_VST_BUILD_DIR environment variable; -BuildDir wins over both.

.EXAMPLE
    .\build.ps1
    .\build.ps1 -Vst3 OFF
    .\build.ps1 -Clean -BuildDir D:\scratch\vst-host
#>
[CmdletBinding()]
param(
    # ON by default: the host is only useful with the VST3 layer linked in. -Vst3 OFF still
    # builds the engine alone (null plugin + protocol), which is what the engine tests need when
    # no plugin is involved.
    [ValidateSet('ON', 'OFF')]
    [string]$Vst3 = 'ON',

    # Empty on purpose: the real default needs $here, which does not exist yet
    # at parameter-binding time. Resolved just below, in this order: -BuildDir,
    # then $env:THEDAW_VST_BUILD_DIR, then <this directory>\build.
    [string]$BuildDir = '',

    [ValidateSet('Release', 'Debug', 'RelWithDebInfo')]
    [string]$Config = 'Release',

    [switch]$Clean,

    [switch]$NoWerror
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Resolve-Cmake {
    # PATH first: whatever `cmake` the user's shell resolves is the one every
    # other tool of theirs uses, and it is the one theDAW.bat tested for before
    # it offered this build. The absolute paths below are only a fallback for
    # installs that never put CMake on PATH.
    $found = Get-Command cmake -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    $candidates = @(
        'C:\Program Files\Python313\Scripts\cmake.exe',
        'C:\Program Files\CMake\bin\cmake.exe'
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return $candidate }
    }
    throw 'cmake was not found. Install CMake or add it to PATH.'
}

# -BuildDir beats the environment, which beats the gitignored tree beside the
# sources. Nothing here assumes a drive that this machine may not have.
if (-not $BuildDir) { $BuildDir = $env:THEDAW_VST_BUILD_DIR }
if (-not $BuildDir) { $BuildDir = Join-Path $here 'build' }

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
