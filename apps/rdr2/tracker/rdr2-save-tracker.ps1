param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot "rdr2-tracker-config.json"),
  [switch]$Once,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Read-TrackerConfig {
  if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Missing config: $ConfigPath. Copy rdr2-tracker-config.example.json to rdr2-tracker-config.json and fill it in."
  }
  $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  if (-not $config.panelUrl -or -not $config.apiKey) {
    throw "panelUrl and apiKey are required in rdr2-tracker-config.json."
  }
  return $config
}

function Find-Rdr2SaveFolder([object]$Config) {
  if ($Config.saveFolder) {
    if (-not (Test-Path -LiteralPath $Config.saveFolder)) {
      throw "Configured saveFolder does not exist: $($Config.saveFolder)"
    }
    return $Config.saveFolder
  }

  $profiles = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "Rockstar Games\Red Dead Redemption 2\Profiles"
  if (-not (Test-Path -LiteralPath $profiles)) {
    throw "RDR2 Profiles folder was not found: $profiles"
  }
  $latest = Get-ChildItem -LiteralPath $profiles -Recurse -File -Filter "SRDR3*" |
    Where-Object { $_.Name -notlike "*.bak" } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
  if (-not $latest) { throw "No RDR2 save files were found below $profiles" }
  return $latest.DirectoryName
}

function Get-LatestSave([string]$SaveFolder) {
  return Get-ChildItem -LiteralPath $SaveFolder -File -Filter "SRDR3*" |
    Where-Object { $_.Name -notlike "*.bak" } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
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
  $match = [regex]::Match($header, '^(?:\(Autosave\)\s*)?(?<title>.+?)\s+\((?<percent>\d+(?:\.\d+)?)%\)\s+-\s+')
  if (-not $match.Success) { throw "Unknown RDR2 save header: $header" }
  return [pscustomobject]@{
    Title = $match.Groups['title'].Value.Trim()
    Percent = [double]::Parse($match.Groups['percent'].Value, [Globalization.CultureInfo]::InvariantCulture)
    Header = $header
  }
}

function Send-LatestSave([object]$Config, [string]$SaveFolder, [ref]$LastFingerprint) {
  $save = Get-LatestSave $SaveFolder
  if (-not $save) { return }
  $fingerprint = "$($save.FullName)|$($save.LastWriteTimeUtc.Ticks)|$($save.Length)"
  if ($fingerprint -eq $LastFingerprint.Value) { return }

  Start-Sleep -Milliseconds 500
  $data = Read-SaveHeader $save.FullName
  if ($DryRun) {
    $LastFingerprint.Value = $fingerprint
    Write-Host "Dry run: $($data.Title) ($($data.Percent)%) from $($save.Name)"
    return
  }

  $uri = "$($Config.panelUrl.TrimEnd('/'))/rdr2/api/tracker"
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
$saveFolder = Find-Rdr2SaveFolder $config
Write-Host "RDR2 save tracker starting (profile: $(if ($config.profile) { $config.profile } else { 'main' }))"
Write-Host "Watching: $saveFolder"
$lastFingerprint = ""
Send-LatestSave $config $saveFolder ([ref]$lastFingerprint)
if ($Once) { exit 0 }

while ($true) {
  try {
    Send-LatestSave $config $saveFolder ([ref]$lastFingerprint)
  } catch {
    Write-Warning $_.Exception.Message
  }
  Start-Sleep -Seconds 2
}
