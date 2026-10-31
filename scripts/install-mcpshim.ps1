[CmdletBinding()]
param(
    [string]$Version,
    [string]$PairingCode,
    [switch]$ReplaceUserHealth
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$temporary = $null
try {
    if ($Version -cnotmatch '\A(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\z') { throw 'An explicit stable version is required.' }
    if (-not $PairingCode -or -not $PairingCode.StartsWith('mtmcp1.') -or $PairingCode.Length -le 7) { throw 'A Med Tracker pairing code is required.' }
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Use install.sh on macOS, Linux, or WSL.' }
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw 'Install Claude Code first, then retry.' }
    $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    $arch = switch ($architecture) { 'X64' { 'amd64' } 'Arm64' { 'arm64' } default { throw 'Unsupported CPU architecture.' } }
    if (-not $env:LOCALAPPDATA -or $env:LOCALAPPDATA -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)') { throw 'LOCALAPPDATA must be an absolute user data directory.' }
    $asset = "mcpshim_${Version}_windows_${arch}.exe"
    $base = "https://github.com/korjavin/medicationtrackerbot/releases/download/mcpshim-v$Version"
    # A new user-owned directory inherits the user's temporary-directory ACL.
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ('medtracker-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($temporary) | Out-Null
    $acl = Get-Acl -LiteralPath $temporary
    $acl.SetAccessRuleProtection($true, $false)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $temporary -AclObject $acl
    $manifest = Join-Path $temporary 'SHA256SUMS'
    $download = Join-Path $temporary 'mcpshim.exe'
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $manifest
        $matchesForAsset = @(Get-Content -LiteralPath $manifest | Where-Object { $_ -match ('\s\*?' + [regex]::Escape($asset) + '$') })
        if ($matchesForAsset.Count -ne 1 -or $matchesForAsset[0] -cnotmatch ('^([0-9a-fA-F]{64}) [ *]' + [regex]::Escape($asset) + '$')) { throw 'manifest' }
        $expected = $Matches[1].ToLowerInvariant()
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $download
    } catch { throw 'Cannot download the pinned helper or validate its unique checksum entry.' }
    if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Helper checksum mismatch; nothing was installed or registered.' }
    $directory = Join-Path $env:LOCALAPPDATA "MedTracker/mcpshim/$Version"
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $binary = Join-Path $directory 'mcpshim.exe'
    if (((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing a reparse-point installation target.' }
    if (Test-Path -LiteralPath $binary) {
        $existing = Get-Item -LiteralPath $binary
        if (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $existing.PSIsContainer -or (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'This version already contains different bytes; preserve it and choose another version.' }
    } else {
        $stage = Join-Path $directory ('.mcpshim-' + [Guid]::NewGuid().ToString('N'))
        try {
            [IO.File]::Copy($download, $stage, $false)
            # Same-filesystem rename is atomic and refuses an existing target.
            [IO.File]::Move($stage, $binary)
        } finally { if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Force } }
    }
    # Execute only the verified file, without the pairing-code environment or
    # shell, before any removal/registration. Capture/discard native diagnostics.
    $probe = [Diagnostics.Process]::new()
    try {
        $probe.StartInfo = [Diagnostics.ProcessStartInfo]::new()
        $probe.StartInfo.FileName = $binary
        $probe.StartInfo.Arguments = '--version'
        $probe.StartInfo.UseShellExecute = $false
        $probe.StartInfo.CreateNoWindow = $true
        $probe.StartInfo.RedirectStandardOutput = $true
        $probe.StartInfo.RedirectStandardError = $true
        $probe.StartInfo.EnvironmentVariables.Remove('MEDTRACKER_MCP_CODE')
        if (-not $probe.Start()) { throw 'probe' }
        $probeOutput = $probe.StandardOutput.ReadToEndAsync()
        $probeError = $probe.StandardError.ReadToEndAsync()
        if (-not $probe.WaitForExit(15000)) { $probe.Kill(); throw 'probe timeout' }
        $reportedVersion = $probeOutput.GetAwaiter().GetResult().Trim()
        $null = $probeError.GetAwaiter().GetResult()
        if ($probe.ExitCode -ne 0 -or $reportedVersion -cnotmatch ('\Amcpshim ' + [regex]::Escape($Version) + '\+[0-9a-f]{40}\z')) { throw 'probe version' }
    } catch { throw 'The verified helper could not run with the expected version. Check host execution policy; nothing was registered.' }
    finally { $probe.Dispose() }
    if ($ReplaceUserHealth) {
        & claude mcp remove --scope user health *> $null
        if ($LASTEXITCODE -ne 0) { throw 'Could not remove user-scope health. Other scopes were left unchanged.' }
    }
    & claude mcp add --env "MEDTRACKER_MCP_CODE=$PairingCode" --transport stdio --scope user health -- $binary *> $null
    if ($LASTEXITCODE -ne 0) {
        if ($ReplaceUserHealth) { throw 'Claude registration failed after removing user-scope health. Retry the original command without -ReplaceUserHealth. Local/project entries were left unchanged.' }
        throw 'Claude registration failed. Retry with -ReplaceUserHealth only to explicitly replace user-scope health. Local/project entries are never removed.'
    }
    Write-Output 'Installed and registered user-scope health. Reconnect Claude; an unlocked paired browser must be online. Local/project health entries can shadow this registration.'
} catch {
    # Only our own fixed messages are exposed, never native/download diagnostics.
    $safe = @('An explicit stable version is required.', 'A Med Tracker pairing code is required.', 'Use install.sh on macOS, Linux, or WSL.', 'Install Claude Code first, then retry.', 'Unsupported CPU architecture.', 'LOCALAPPDATA must be an absolute user data directory.', 'Cannot download the pinned helper or validate its unique checksum entry.', 'Helper checksum mismatch; nothing was installed or registered.', 'Refusing a reparse-point installation target.', 'This version already contains different bytes; preserve it and choose another version.', 'The verified helper could not run with the expected version. Check host execution policy; nothing was registered.', 'Could not remove user-scope health. Other scopes were left unchanged.', 'Claude registration failed. Retry with -ReplaceUserHealth only to explicitly replace user-scope health. Local/project entries are never removed.')
    $safe += 'Claude registration failed after removing user-scope health. Retry the original command without -ReplaceUserHealth. Local/project entries were left unchanged.'
    if ($safe -contains $_.Exception.Message) { [Console]::Error.WriteLine($_.Exception.Message) } else { [Console]::Error.WriteLine('Installation failed; existing versions were preserved.') }
    exit 1
} finally {
    if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue }
}
