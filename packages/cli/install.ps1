<#
.SYNOPSIS
  Sentry CLI installer for Windows PowerShell and PowerShell 7+.

.DESCRIPTION
  Downloads the standalone Sentry CLI binary for Windows and hands off to
  `sentry cli setup`, which places the binary, adds it to the user PATH,
  installs agent skills, and records the install method so
  `sentry cli upgrade` keeps working.

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
#
# Invoke-Install, right below, is the whole install from start to finish.
# Every other function is a helper for one of its steps.
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

  # Where there is no standalone binary, the npm package runs on Node.js.
  $npmFallback = 'Install Node.js 20 or later and run: npm install -g sentry'
  # What error reports say about the install. Each step updates it.
  $state = @{ Step = 'start'; Version = 'unknown'; Arch = 'unknown' }

  function Invoke-Install {
    # The functions below read $asset from this scope.
    $asset = Get-WindowsAsset
    $release = Resolve-Release
    $binary = Save-Binary $release
    try {
      Invoke-Setup $binary
      if ($env:SENTRY_INIT -eq '1') { Invoke-Init $binary }
    } finally {
      # The running temp binary cannot always be deleted on Windows; try anyway.
      Remove-Item -LiteralPath $binary -Force -ErrorAction SilentlyContinue
    }
  }

  # -------------------------------------------------------------------------
  # Step 1: check that this machine can run the binary
  # -------------------------------------------------------------------------

  # Returns the release file name for this machine's architecture.
  function Get-WindowsAsset {
    $state.Step = 'detect-os'
    if ($env:OS -ne 'Windows_NT') {
      Stop-Install 'This installer is for Windows. On macOS and Linux, run: curl https://cli.sentry.dev/install -fsS | bash'
    }

    $state.Step = 'detect-arch'
    # 32-bit PowerShell on 64-bit Windows reports x86 here and sets
    # PROCESSOR_ARCHITEW6432 to the real architecture.
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $state.Arch = "$arch"
    switch ($arch) {
      'AMD64' { $state.Arch = 'x64' }
      'ARM64' { $state.Arch = 'arm64' }
      default {
        Stop-Install "Unsupported: windows-$arch (only x64 and arm64 are supported). $npmFallback"
      }
    }
    return "sentry-windows-$($state.Arch).exe"
  }

  # -------------------------------------------------------------------------
  # Step 2: find the release to install
  #
  # Sentry's release registry is the source of truth for versions, download
  # URLs, and checksums. When it is down, a pinned version still downloads
  # from its GitHub release, without checksums; "latest" needs the registry.
  # -------------------------------------------------------------------------

  # Returns @{ Version; Gz; Raw }, where Gz and Raw are the compressed and
  # plain downloads as @{ Url; Sha256 }, or $null when the release lacks one.
  function Resolve-Release {
    $state.Step = 'resolve-version'
    if ($env:SENTRY_VERSION -eq 'nightly') {
      Stop-Install 'The PowerShell installer only installs stable releases. Install stable, then run: sentry cli upgrade nightly'
    }

    $version = ''
    $registryPath = 'latest'
    if ($env:SENTRY_VERSION) {
      $version = $env:SENTRY_VERSION -replace '^cli@', '' -replace '^v', ''
      $state.Version = $version
      if ($version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
        Stop-Install "Invalid release version: $version"
      }
      $registryPath = $version
    }

    $metadata = Get-RegistryRelease $registryPath
    if ($null -ne $metadata) {
      $release = @{
        Version = "$($metadata.version)"
        Gz = Get-RegistryFile $metadata "$asset.gz"
        Raw = Get-RegistryFile $metadata $asset
      }
      $state.Version = $release.Version
      if ($null -eq $release.Gz -and $null -eq $release.Raw) {
        Stop-Install "Sentry CLI $($release.Version) has no $asset build. $npmFallback"
      }
      return $release
    }

    if (-not $version) {
      Stop-Install "Failed to fetch latest stable version from Sentry's release registry. Retry or set SENTRY_VERSION to install a specific version."
    }
    Write-Host "Could not resolve $registryPath from Sentry's release registry. Trying GitHub..." -ForegroundColor DarkGray
    Write-Warning 'GitHub fallback downloads are not checksum-verified.'
    $base = "https://github.com/getsentry/toolkit/releases/download/cli@$version/$asset"
    return @{
      Version = $version
      Gz = @{ Url = "$base.gz"; Sha256 = '' }
      Raw = @{ Url = $base; Sha256 = '' }
    }
  }

  # Returns the registry's metadata for 'latest' or a version, or $null when
  # the registry is unreachable or answers with something unusable. Stops
  # when a pinned version does not exist.
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

    # Ignore an answer that is not the release that was asked for.
    $registryVersion = "$($metadata.version)"
    if ($Path -eq 'latest' -and $registryVersion -notmatch '^\d+\.\d+\.\d+$') { return $null }
    if ($Path -ne 'latest' -and $registryVersion -ne $Path) { return $null }
    return $metadata
  }

  # Returns @{ Url; Sha256 } for one entry in the registry's `files`, or $null.
  function Get-RegistryFile($Metadata, [string]$Name) {
    $entry = $Metadata.files.PSObject.Properties[$Name]
    if ($null -eq $entry -or "$($entry.Value.url)" -notmatch '^https://') { return $null }
    return @{ Url = "$($entry.Value.url)"; Sha256 = "$($entry.Value.checksums.'sha256-hex')" }
  }

  # -------------------------------------------------------------------------
  # Step 3: download and verify the binary
  # -------------------------------------------------------------------------

  # Downloads the release to a temporary .exe and returns its path. Prefers
  # the gzip download (~60% smaller) and falls back to the plain binary when
  # it is missing. A checksum mismatch is fatal, never a reason to fall back.
  function Save-Binary($Release) {
    $state.Step = 'download'
    $binary = Join-Path ([System.IO.Path]::GetTempPath()) "sentry-install-$([guid]::NewGuid().ToString('N')).exe"
    $archive = "$binary.gz"

    Write-Host "Downloading sentry v$($Release.Version)..." -ForegroundColor DarkGray
    try {
      if ($null -ne $Release.Gz -and (Save-Download $Release.Gz $archive)) {
        Confirm-Download $Release.Gz $archive
        Expand-Gzip $archive $binary
      } elseif ($null -ne $Release.Raw) {
        if (-not (Save-Download $Release.Raw $binary)) {
          Stop-Install "Failed to download $($Release.Raw.Url)"
        }
        Confirm-Download $Release.Raw $binary
      } else {
        Stop-Install "Failed to download $($Release.Gz.Url)"
      }
    } catch {
      Remove-Item -LiteralPath $binary -Force -ErrorAction SilentlyContinue
      throw
    } finally {
      Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    }
    return $binary
  }

  # Downloads $File.Url to $Path. Returns $false when the download fails.
  function Save-Download($File, [string]$Path) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $File.Url -OutFile $Path
      return $true
    } catch {
      Write-Verbose "Download of $($File.Url) failed: $_"
      return $false
    }
  }

  # Checks the download against its checksum, if it has one. A broken
  # transfer or proxy can corrupt the first copy, so a mismatch downloads it
  # once more before giving up.
  function Confirm-Download($File, [string]$Path) {
    if (Test-Sha256 $Path $File.Sha256) { return }

    Write-Host 'The download was incomplete or corrupt. Downloading it again...' -ForegroundColor DarkGray
    if (-not (Save-Download $File $Path)) {
      Stop-Install "Failed to download $($File.Url)"
    }
    if (Test-Sha256 $Path $File.Sha256) { return }

    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    Stop-Install "Checksum mismatch for $asset $($state.Version): expected $($File.Sha256), got $actual"
  }

  # True when the file matches the SHA-256 hex digest, or there is none.
  function Test-Sha256([string]$Path, [string]$Expected) {
    if (-not $Expected) { return $true }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    return $actual -eq $Expected.ToLowerInvariant()
  }

  function Expand-Gzip([string]$Archive, [string]$Destination) {
    $source = [System.IO.File]::OpenRead($Archive)
    try {
      $gzip = New-Object System.IO.Compression.GZipStream($source, [System.IO.Compression.CompressionMode]::Decompress)
      $target = [System.IO.File]::Create($Destination)
      try { $gzip.CopyTo($target) } finally { $target.Dispose(); $gzip.Dispose() }
    } finally {
      $source.Dispose()
    }
  }

  # -------------------------------------------------------------------------
  # Step 4: hand off to the binary
  # -------------------------------------------------------------------------

  # `sentry cli setup --install` places the binary and handles the user PATH,
  # completions, agent skills, install-method recording, and first-run login.
  function Invoke-Setup([string]$Binary) {
    $state.Step = 'setup'
    $setupArgs = @('cli', 'setup', '--install', '--method', 'curl', '--channel', 'stable')
    if ($env:SENTRY_NO_MODIFY_PATH -eq '1') { $setupArgs += '--no-modify-path' }

    $userPathBefore = Get-UserPathEntries
    & $Binary @setupArgs
    if ($LASTEXITCODE -ne 0) {
      Stop-Install "sentry cli setup failed with exit code $LASTEXITCODE"
    }

    # Setup saves the install directory to the user PATH, which only new
    # terminals pick up. Add what it added to this session too.
    $added = @(Get-UserPathEntries | Where-Object { $userPathBefore -notcontains $_ })
    if ($added.Count -gt 0) {
      $env:PATH = (@($added) + @("$env:PATH")) -join [System.IO.Path]::PathSeparator
    }
  }

  # Runs init from the downloaded binary, which is the one setup just
  # installed, so the installer never has to know where setup put it.
  function Invoke-Init([string]$Binary) {
    $state.Step = 'init'
    & $Binary init
    if ($LASTEXITCODE -ne 0) {
      # Like the bash installer, report init failures to the caller but not
      # to installer telemetry: init errors are not installation failures.
      throw "sentry init failed with exit code $LASTEXITCODE"
    }
  }

  # Entries of the persisted user PATH, expanded. Empty on non-Windows hosts.
  function Get-UserPathEntries {
    return @("$([Environment]::GetEnvironmentVariable('Path', 'User'))" -split ';' | Where-Object { $_ })
  }

  # -------------------------------------------------------------------------
  # Errors
  # -------------------------------------------------------------------------

  # Reports the error, then throws it.
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

  Invoke-Install
}

Install-SentryCli
