param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot "gta5-tracker-config.json"),
  [switch]$Once,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Read-TrackerConfig {
  if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Missing config: $ConfigPath. Copy gta5-tracker-config.example.json to gta5-tracker-config.json and fill it in."
  }
  $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  if (-not $config.panelUrl -or -not $config.apiKey) {
    throw "panelUrl and apiKey are required in gta5-tracker-config.json."
  }
  return $config
}

function Find-Gta5SaveFile([object]$Config) {
  if ($Config.saveFolder) {
    if (-not (Test-Path -LiteralPath $Config.saveFolder)) {
      throw "Configured saveFolder does not exist: $($Config.saveFolder)"
    }
    $latest = Get-ChildItem -LiteralPath $Config.saveFolder -Recurse -File -Filter "SGTA5*" |
      Where-Object { $_.Name -notlike "*.bak" } |
      Sort-Object LastWriteTimeUtc -Descending |
      Select-Object -First 1
    if (-not $latest) { throw "No GTA V save files were found below $($Config.saveFolder)" }
    return $latest
  }

  # GTA V (legacy) and GTAV Enhanced use separate save folders; check both
  # and use whichever has the most recently written save.
  $docs = [Environment]::GetFolderPath("MyDocuments")
  $roots = @(
    (Join-Path $docs "Rockstar Games\GTAV Enhanced\Profiles"),
    (Join-Path $docs "Rockstar Games\GTA V\Profiles")
  ) | Where-Object { Test-Path -LiteralPath $_ }

  if (-not $roots) {
    throw "No GTA V Profiles folder was found under $docs\Rockstar Games. Set 'saveFolder' in gta5-tracker-config.json manually."
  }

  $latest = $roots |
    ForEach-Object { Get-ChildItem -LiteralPath $_ -Recurse -File -Filter "SGTA5*" -ErrorAction SilentlyContinue } |
    Where-Object { $_.Name -notlike "*.bak" } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1

  if (-not $latest) { throw "No GTA V save files were found below any Rockstar Games Profiles folder." }
  return $latest
}

function Read-SaveHeader([string]$Path) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    $buffer = New-Object byte[] 256
    $read = $stream.Read($buffer, 0, $buffer.Length)
  } finally {
    $stream.Dispose()
  }
  if ($read -lt 8) { throw "Save file is too short: $Path" }

  $header = [Text.Encoding]::Unicode.GetString($buffer, 4, $read - 4).Split([char]0)[0].Trim()
  # Observed formats:
  #   "Grass Roots - Michael (5.2%) - 07/14/25 13:23:56"
  #   "The Long Stretch (10.7%) - 07/16/25 15:39:08"
  #   "(Autosave) Trevor Philips Industries (18.8%) - 07/21/25 00:54:31"
  $match = [regex]::Match($header, '^(?:\(Autosave\)\s*)?(?<title>.+?)\s+\((?<percent>\d+(?:\.\d+)?)%\)\s+-\s+')
  if (-not $match.Success) { throw "Unknown GTA V save header: $header" }

  $title = $match.Groups['title'].Value.Trim()
  $charMatch = [regex]::Match($title, '^(?<name>.+?)\s+-\s+(?<char>Michael|Franklin|Trevor)$')
  if ($charMatch.Success) {
    $title = $charMatch.Groups['name'].Value.Trim()
  }

  return [pscustomobject]@{
    Title = $title
    Percent = [double]::Parse($match.Groups['percent'].Value, [Globalization.CultureInfo]::InvariantCulture)
    Header = $header
  }
}

function Send-LatestSave([object]$Config, [ref]$LastFingerprint) {
  $save = Find-Gta5SaveFile $Config
  $fingerprint = "$($save.FullName)|$($save.LastWriteTimeUtc.Ticks)|$($save.Length)"
  if ($fingerprint -eq $LastFingerprint.Value) { return }

  Start-Sleep -Milliseconds 500
  $data = Read-SaveHeader $save.FullName
  if ($DryRun) {
    $LastFingerprint.Value = $fingerprint
    Write-Host "Dry run: $($data.Title) ($($data.Percent)%) from $($save.Name)"
    return
  }

  $uri = "$($Config.panelUrl.TrimEnd('/'))/gta5/api/tracker"
  if ($Config.profile) {
    $uri = "$uri`?profile=$([Uri]::EscapeDataString($Config.profile))"
  }
  $body = @{ text = $data.Title; percent = $data.Percent } | ConvertTo-Json
  $headers = @{ Authorization = "Bearer $($Config.apiKey)" }
  $result = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType "application/json" -Body $body
  $LastFingerprint.Value = $fingerprint
  $now = Get-Date -Format "HH:mm:ss"
  if ($result.matched -eq $false) {
    Write-Host "[$now] No match: '$($data.Title)' ($($data.Percent)%) - progression stays at $($result.progress.completed)/$($result.progress.total) missions"
  } else {
    Write-Host "[$now] Synced: $($data.Title) ($($data.Percent)%) -> $($result.progress.completed)/$($result.progress.total) missions"
  }
}

$config = Read-TrackerConfig
Write-Host "GTA V save tracker starting (profile: $(if ($config.profile) { $config.profile } else { 'main' }))"
$lastFingerprint = ""
Send-LatestSave $config ([ref]$lastFingerprint)
if ($Once) { exit 0 }

while ($true) {
  try {
    Send-LatestSave $config ([ref]$lastFingerprint)
  } catch {
    Write-Warning $_.Exception.Message
  }
  Start-Sleep -Seconds 2
}
