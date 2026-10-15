<#
.SYNOPSIS
  Sentry CLI installer for Windows PowerShell and PowerShell 7+.

.DESCRIPTION
  Downloads the standalone Sentry CLI binary for Windows and hands off to
  `sentry cli setup`, which places the binary, installs agent skills, and
  records the install method so `sentry cli upgrade` keeps working.

  Usage:
    irm https://cli.sentry.dev/install.ps1 | iex

  Environment variables:
    SENTRY_VERSION          Install a specific stable version (e.g., 0.42.2)
    SENTRY_INSTALL_DIR      Override the installation directory
    SENTRY_INIT             Set to 1 to run `sentry init` after installing
    SENTRY_NO_MODIFY_PATH   Set to 1 to leave the user PATH unchanged
    SENTRY_CLI_NO_TELEMETRY Set to 1 to disable installer error reporting

  For the nightly channel, install stable first and then run
  `sentry cli upgrade nightly`.
#>

# Everything runs inside a function so `irm ... | iex` never changes the
# caller's session preferences, and failures throw instead of calling `exit`
# (which would close the user's terminal when run through iex).
function Install-SentryCli {
  $ErrorActionPreference = 'Stop'
  # Invoke-WebRequest progress rendering makes downloads dramatically slower
  # on Windows PowerShell 5.1.
  $ProgressPreference = 'SilentlyContinue'

  # Windows PowerShell 5.1 may default to TLS 1.0/1.1, which GitHub rejects.
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch {
    Write-Verbose "Could not enable TLS 1.2: $_"
  }

  $state = @{ Step = 'start'; Version = 'unknown'; Arch = 'unknown' }

  # Fire-and-forget error report via the envelope API, mirroring the bash
  # installer. Uses the CLI's public write-only DSN. No PII collected.
  function Send-InstallError([string]$Message) {
    if ($env:SENTRY_CLI_NO_TELEMETRY -eq '1') { return }
    try {
      $dsnKey = '1188a86f3f8168f089450587b00bca66'
      $projectId = '4510776311808000'
      $eventId = [guid]::NewGuid().ToString('N')
      $header = @{
        event_id = $eventId
        dsn = "https://$dsnKey@o1.ingest.us.sentry.io/$projectId"
      } | ConvertTo-Json -Compress
      $sentryEvent = @{
        event_id = $eventId
        timestamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
        platform = 'other'
        level = 'error'
        logger = 'install'
        server_name = 'install-script'
        message = @{ formatted = $Message }
        tags = @{
          os = 'windows'
          arch = $state.Arch
          channel = 'stable'
          step = $state.Step
          'install.version' = $state.Version
        }
        contexts = @{
          runtime = @{ name = 'powershell'; version = "$($PSVersionTable.PSVersion)" }
        }
      } | ConvertTo-Json -Compress -Depth 5
      $envelope = "$header`n{`"type`":`"event`"}`n$sentryEvent"
      Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec 2 `
        -Uri "https://o1.ingest.us.sentry.io/api/$projectId/envelope/" `
        -ContentType 'application/x-sentry-envelope' `
        -Headers @{ 'X-Sentry-Auth' = "Sentry sentry_key=$dsnKey,sentry_version=7" } `
        -Body $envelope | Out-Null
    } catch {
      Write-Verbose "Failed to report installer error: $_"
    }
  }

  function Stop-Install([string]$Message) {
    Send-InstallError $Message
    throw $Message
  }

  # Returns the HTTP status of a failed web request, or 0 without a response.
  function Get-ErrorStatus($ErrorRecord) {
    $response = $ErrorRecord.Exception.Response
    if ($null -ne $response -and $null -ne $response.StatusCode) {
      return [int]$response.StatusCode
    }
    return 0
  }

  # Fetch release metadata (download URLs and checksums) from Sentry's release
  # registry. Returns $null when the registry is unreachable or returns
  # something unusable; stops when a pinned version does not exist.
  function Get-RegistryRelease([string]$Path) {
    try {
      $metadata = Invoke-RestMethod -UseBasicParsing -TimeoutSec 10 `
        -Uri "https://release-registry.services.sentry.io/apps/sentry/$Path"
    } catch {
      if ((Get-ErrorStatus $_) -eq 404 -and $Path -ne 'latest') {
        Stop-Install "Unknown Sentry CLI version: $Path"
      }
      Write-Verbose "Release registry lookup failed: $_"
      return $null
    }
    $registryVersion = "$($metadata.version)"
    if ($Path -eq 'latest' -and $registryVersion -notmatch '^\d+\.\d+\.\d+$') { return $null }
    if ($Path -ne 'latest' -and $registryVersion -ne $Path) { return $null }
    return $metadata
  }

  # Returns @{ Url; Sha256 } for one registry file entry, or $null.
  function Get-RegistryFile($Metadata, [string]$Name) {
    $entry = $Metadata.files.PSObject.Properties[$Name]
    if ($null -eq $entry -or "$($entry.Value.url)" -notmatch '^https://') { return $null }
    return @{ Url = "$($entry.Value.url)"; Sha256 = "$($entry.Value.checksums.'sha256-hex')" }
  }

  # Usage: Assert-Sha256 <file> <expected-hex>; a missing checksum is a no-op.
  function Assert-Sha256([string]$Path, [string]$Expected) {
    if (-not $Expected) { return }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    if ($actual -ne $Expected.ToLowerInvariant()) {
      Stop-Install "Checksum mismatch for $asset ${version}: expected $Expected, got $actual"
    }
  }

  # Registry outage fallback: the newest `cli@x.y.z` Toolkit release.
  function Find-LatestToolkitVersion {
    # GitHub may have many pages of MCP releases before its newest CLI release.
    for ($page = 1; $page -le 20; $page++) {
      try {
        # Windows PowerShell 5.1 emits a JSON array as one object; piping
        # through ForEach-Object flattens it so an empty page has no items.
        $releases = @(Invoke-RestMethod -UseBasicParsing -TimeoutSec 30 `
          -Uri "https://api.github.com/repos/getsentry/toolkit/releases?per_page=100&page=$page" |
          ForEach-Object { $_ })
      } catch {
        Stop-Install 'Failed to list Toolkit releases'
      }
      if ($releases.Count -eq 0) { break }
      foreach ($release in $releases) {
        if (-not $release.prerelease -and "$($release.tag_name)" -match '^cli@\d+\.\d+\.\d+$') {
          return "$($release.tag_name)".Substring(4)
        }
      }
    }
    Stop-Install "Failed to fetch latest stable version from Sentry's release registry and GitHub. Retry or set SENTRY_VERSION to install a specific version."
  }

  # Compute the directory `sentry cli setup` will install into, matching
  # determineInstallDir() in src/lib/binary.ts, so the installer and setup agree
  # on which directory to put on PATH.
  function Resolve-InstallDir([string]$HomeDir) {
    if ($env:SENTRY_INSTALL_DIR) { return $env:SENTRY_INSTALL_DIR }
    if ($env:XDG_BIN_HOME -and [System.IO.Path]::IsPathRooted($env:XDG_BIN_HOME)) {
      return $env:XDG_BIN_HOME
    }
    $pathDirs = "$env:PATH" -split [System.IO.Path]::PathSeparator |
      ForEach-Object { $_.TrimEnd('\', '/') }
    foreach ($dir in @((Join-Path $HomeDir '.local\bin'), (Join-Path $HomeDir 'bin'))) {
      if ((Test-Path -LiteralPath $dir -PathType Container) -and ($pathDirs -contains $dir.TrimEnd('\', '/'))) {
        return $dir
      }
    }
    return (Join-Path $HomeDir '.local\bin')
  }

  # Persist $Dir on the user PATH without expanding existing %VAR% entries.
  function Add-ToUserPath([string]$Dir) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
      $current = "$($key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames))"
      $entries = @($current -split ';' | Where-Object { $_ })
      if ($entries | Where-Object { $_.TrimEnd('\') -eq $Dir.TrimEnd('\') }) {
        return $false
      }
      $key.SetValue('Path', (@($Dir) + $entries) -join ';', [Microsoft.Win32.RegistryValueKind]::ExpandString)
    } finally {
      $key.Dispose()
    }
    # Setting any user variable through .NET broadcasts WM_SETTINGCHANGE, so
    # newly opened terminals pick up the updated PATH.
    [Environment]::SetEnvironmentVariable('SENTRY_CLI_PATH_REFRESH', '1', 'User')
    [Environment]::SetEnvironmentVariable('SENTRY_CLI_PATH_REFRESH', $null, 'User')
    return $true
  }

  $state.Step = 'detect-os'
  if ($env:OS -ne 'Windows_NT') {
    Stop-Install 'This installer is for Windows. On macOS and Linux, run: curl https://cli.sentry.dev/install -fsS | bash'
  }

  $state.Step = 'detect-arch'
  # 32-bit PowerShell on 64-bit Windows reports x86 here and sets
  # PROCESSOR_ARCHITEW6432 to the real architecture.
  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $state.Arch = "$arch"
  if ($arch -ne 'AMD64') {
    Stop-Install "Unsupported: windows-$arch (only windows-x64 is supported). Install Node.js and run: npm install -g sentry"
  }
  $state.Arch = 'x64'

  # Sentry's release registry is the source of truth for versions, download
  # URLs (including legacy getsentry/cli releases), and checksums. GitHub is
  # only a fallback for registry outages.
  $state.Step = 'resolve-version'
  if ($env:SENTRY_VERSION -eq 'nightly') {
    Stop-Install 'The PowerShell installer only installs stable releases. Install stable, then run: sentry cli upgrade nightly'
  }
  $registryPath = 'latest'
  $version = ''
  if ($env:SENTRY_VERSION) {
    $version = $env:SENTRY_VERSION -replace '^cli@', '' -replace '^v', ''
    $state.Version = $version
    if ($version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
      Stop-Install "Invalid release version: $version"
    }
    $registryPath = $version
  }

  $asset = 'sentry-windows-x64.exe'
  $metadata = Get-RegistryRelease $registryPath
  if ($null -ne $metadata) {
    $version = "$($metadata.version)"
    $gz = Get-RegistryFile $metadata "$asset.gz"
    $raw = Get-RegistryFile $metadata $asset
    if ($null -eq $gz -and $null -eq $raw) {
      Stop-Install "Sentry CLI $version has no $asset build"
    }
  } else {
    Write-Host "Could not resolve $registryPath from Sentry's release registry. Trying GitHub..." -ForegroundColor DarkGray
    if (-not $version) { $version = Find-LatestToolkitVersion }
    $base = "https://github.com/getsentry/toolkit/releases/download/cli@$version/$asset"
    $gz = @{ Url = "$base.gz"; Sha256 = '' }
    $raw = @{ Url = $base; Sha256 = '' }
    Write-Warning 'GitHub fallback downloads are not checksum-verified.'
  }
  $state.Version = $version

  $state.Step = 'download'
  $tmpBinary = Join-Path ([System.IO.Path]::GetTempPath()) "sentry-install-$([guid]::NewGuid().ToString('N')).exe"
  $tmpArchive = "$tmpBinary.gz"

  Write-Host "Downloading sentry v$version..." -ForegroundColor DarkGray
  try {
    # Prefer the gzip asset (~60% smaller); fall back to the raw binary when it
    # is missing. A checksum mismatch is fatal, never a reason to fall back.
    $downloaded = $false
    if ($null -ne $gz) {
      try {
        Invoke-WebRequest -UseBasicParsing -Uri $gz.Url -OutFile $tmpArchive
        $downloaded = $true
      } catch {
        Write-Verbose "Compressed download failed, trying raw binary: $_"
      }
    }
    if ($downloaded) {
      Assert-Sha256 $tmpArchive $gz.Sha256
      $source = [System.IO.File]::OpenRead($tmpArchive)
      try {
        $gzip = New-Object System.IO.Compression.GZipStream($source, [System.IO.Compression.CompressionMode]::Decompress)
        $target = [System.IO.File]::Create($tmpBinary)
        try { $gzip.CopyTo($target) } finally { $target.Dispose(); $gzip.Dispose() }
      } finally {
        $source.Dispose()
      }
    } elseif ($null -ne $raw) {
      try {
        Invoke-WebRequest -UseBasicParsing -Uri $raw.Url -OutFile $tmpBinary
      } catch {
        Stop-Install "Failed to download $($raw.Url)"
      }
      Assert-Sha256 $tmpBinary $raw.Sha256
    } else {
      Stop-Install "Failed to download $($gz.Url)"
    }
  } catch {
    Remove-Item -LiteralPath $tmpBinary -Force -ErrorAction SilentlyContinue
    throw
  } finally {
    Remove-Item -LiteralPath $tmpArchive -Force -ErrorAction SilentlyContinue
  }

  # Resolve the install directory once and pass it to setup explicitly so PATH
  # handling below targets the same directory setup installs into.
  $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
  $installDir = Resolve-InstallDir $homeDir
  $previousInstallDir = $env:SENTRY_INSTALL_DIR
  $env:SENTRY_INSTALL_DIR = $installDir

  try {
    if ($env:SENTRY_NO_MODIFY_PATH -ne '1') {
      $state.Step = 'path'
      try {
        if (Add-ToUserPath $installDir) {
          Write-Host "PATH: Added $installDir to your user PATH. Open a new terminal to use it everywhere."
        }
      } catch {
        Write-Warning "Could not update your user PATH. Add $installDir to PATH manually."
      }
      # GitHub Actions does not read the registry between steps.
      if ($env:GITHUB_PATH) {
        Add-Content -LiteralPath $env:GITHUB_PATH -Value $installDir
      }
      # Make the CLI available in this session too.
      $sessionDirs = "$env:PATH" -split [System.IO.Path]::PathSeparator
      if ($sessionDirs -notcontains $installDir) {
        $env:PATH = "$installDir$([System.IO.Path]::PathSeparator)$env:PATH"
      }
    }

    # Delegate placement, completions, agent skills, install-method recording,
    # and first-run login to the binary itself. PATH is handled above because
    # setup only knows how to edit POSIX shell config files.
    $state.Step = 'setup'
    $setupArgs = @('cli', 'setup', '--install', '--method', 'curl', '--channel', 'stable', '--no-modify-path')
    & $tmpBinary @setupArgs
    if ($LASTEXITCODE -ne 0) {
      Stop-Install "sentry cli setup failed with exit code $LASTEXITCODE"
    }

    if ($env:SENTRY_INIT -eq '1') {
      $state.Step = 'init'
      $installedBinary = Join-Path $installDir 'sentry.exe'
      if (-not (Test-Path -LiteralPath $installedBinary)) {
        Stop-Install 'Cannot find installed sentry binary'
      }
      & $installedBinary init
      if ($LASTEXITCODE -ne 0) {
        # Like the bash installer, report wizard failures to the caller but not
        # to installer telemetry: init errors are not installation failures.
        throw "sentry init failed with exit code $LASTEXITCODE"
      }
    }
  } finally {
    $env:SENTRY_INSTALL_DIR = $previousInstallDir
    # The running temp binary cannot always be deleted on Windows; try anyway.
    Remove-Item -LiteralPath $tmpBinary -Force -ErrorAction SilentlyContinue
  }
}

Install-SentryCli
