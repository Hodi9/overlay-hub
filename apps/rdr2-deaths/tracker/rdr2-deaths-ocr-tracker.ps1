param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot "rdr2-deaths-tracker-config.json"),
  [switch]$Once,
  [switch]$DryRun,
  [switch]$Calibrate
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

[Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime] | Out-Null

function Get-OcrEngineForRun {
  $english = [Windows.Globalization.Language]::new("en")
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($english)
  if ($engine) { return $engine }
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) { throw "No OCR language pack is available on this PC. Install the 'English (United States)' language pack (with 'Optical character recognition') under Windows Settings > Time & Language > Language & region." }
  Write-Warning "English OCR pack not found - falling back to $($engine.RecognizerLanguage.DisplayName). Recognition of the death-screen text may be less accurate."
  return $engine
}

function Read-TrackerConfig {
  if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Missing config: $ConfigPath. Copy rdr2-deaths-tracker-config.example.json to rdr2-deaths-tracker-config.json and fill it in."
  }
  $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  if (-not $config.panelUrl -or -not $config.apiKey) {
    throw "panelUrl and apiKey are required in rdr2-deaths-tracker-config.json."
  }
  return $config
}

function Get-CaptureRegion([object]$Config) {
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  if ($Config.region -and $Config.region.width -and $Config.region.height) {
    return [pscustomobject]@{
      X = [int]$Config.region.x
      Y = [int]$Config.region.y
      Width = [int]$Config.region.width
      Height = [int]$Config.region.height
    }
  }
  # Default: a wide centered band where RDR2's death screen shows its text.
  # Run with -Calibrate, look at the saved screenshot, and set a tighter
  # 'region' in the config once you've found the exact box.
  $width = [int]($screen.Width * 0.7)
  $height = [int]($screen.Height * 0.4)
  $x = [int]($screen.Width * 0.15)
  $y = [int]($screen.Height * 0.3)
  return [pscustomobject]@{ X = $x; Y = $y; Width = $width; Height = $height }
}

function Get-ScreenRegionText([object]$Region, [object]$OcrEngine) {
  $bmp = New-Object System.Drawing.Bitmap $Region.Width, $Region.Height
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.CopyFromScreen($Region.X, $Region.Y, 0, 0, $bmp.Size)
    } finally {
      $g.Dispose()
    }

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $ms.Dispose()

    $ras = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $dw = New-Object Windows.Storage.Streams.DataWriter($ras.GetOutputStreamAt(0))
    $dw.WriteBytes($bytes)
    Await ($dw.StoreAsync()) ([uint32]) | Out-Null
    Await ($ras.FlushAsync()) ([bool]) | Out-Null
    $ras.Seek(0)

    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $softwareBitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($OcrEngine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])
    return $result.Text
  } finally {
    $bmp.Dispose()
  }
}

function Send-TrackerText([object]$Config, [string]$Text) {
  $uri = "$($Config.panelUrl.TrimEnd('/'))/rdr2-deaths/api/tracker"
  $body = @{ text = $Text } | ConvertTo-Json
  $headers = @{ Authorization = "Bearer $($Config.apiKey)" }
  return Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType "application/json" -Body $body
}

if ($Calibrate) {
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
  $g.Dispose()
  $outPath = Join-Path $PSScriptRoot "calibration-screenshot.png"
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "Screen resolution: $($screen.Width)x$($screen.Height)"
  Write-Host "Saved a full screenshot to: $outPath"
  Write-Host "Open it, find the pixel box around where RDR2 shows the death-screen text, then set 'region': { x, y, width, height } in rdr2-deaths-tracker-config.json."
  exit 0
}

$config = Read-TrackerConfig
$region = Get-CaptureRegion $config
$ocrEngine = Get-OcrEngineForRun
Write-Host "RDR2 death-screen OCR tracker watching region: x=$($region.X) y=$($region.Y) w=$($region.Width) h=$($region.Height) using $($ocrEngine.RecognizerLanguage.DisplayName) OCR"

$script:lastText = $null

function Tick {
  $rawText = Get-ScreenRegionText $region $ocrEngine
  $text = ($rawText -replace '\s+', ' ').Trim()

  # Unlike the mission-progress trackers, we always send here, even when the
  # text is empty or unchanged: the server only counts a death on the tick
  # where the phrase first appears, and needs every "it's gone again" tick
  # too so it re-arms for the next death. Skipping unchanged ticks (as the
  # other trackers do) would leave it stuck after the first death.
  $script:lastText = $text

  if ($DryRun) {
    Write-Host "Dry run: '$text'"
    return
  }

  try {
    $result = Send-TrackerText $config $text
    $now = Get-Date -Format "HH:mm:ss"
    if ($result.incremented) {
      Write-Host "[$now] Death detected (+1, total $($result.count)): '$text'"
    } elseif ($result.matched) {
      Write-Host "[$now] Death screen still showing (total $($result.count)): '$text'"
    } else {
      Write-Host "[$now] No match (total $($result.count)): '$text'"
    }
  } catch {
    Write-Warning $_.Exception.Message
  }
}

Tick
if ($Once) { exit 0 }

while ($true) {
  try {
    Tick
  } catch {
    Write-Warning $_.Exception.Message
  }
  Start-Sleep -Seconds 2
}
