# Habit Tracker — Stream Deck bootstrap (Windows).
# One-liner:  irm https://stream-deck-habit-tracker.vercel.app/setup.ps1 | iex
# Installs the Stream Deck app if missing, downloads the Habit Tracker AI
# plugin + your profile, and opens both so the app imports them.

$ErrorActionPreference = 'Stop'
$base = 'https://stream-deck-habit-tracker.vercel.app'
$dl = Join-Path $env:USERPROFILE 'Downloads'

Write-Host ''
Write-Host '=== Habit Tracker -> Stream Deck setup ===' -ForegroundColor Cyan

# 1) Stream Deck app
$sd = @(
  "$env:ProgramFiles\Elgato\StreamDeck\StreamDeck.exe",
  "${env:ProgramFiles(x86)}\Elgato\StreamDeck\StreamDeck.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $sd) {
  Write-Host '[1/4] Installing the Elgato Stream Deck app (winget)...' -ForegroundColor Yellow
  winget install -e --id Elgato.StreamDeck --accept-source-agreements --accept-package-agreements
  $sd = @(
    "$env:ProgramFiles\Elgato\StreamDeck\StreamDeck.exe",
    "${env:ProgramFiles(x86)}\Elgato\StreamDeck\StreamDeck.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
} else {
  Write-Host '[1/4] Stream Deck app already installed.' -ForegroundColor Green
}
if ($sd) { Start-Process $sd; Start-Sleep -Seconds 5 }

# 2) Which deck?
$choice = Read-Host '[2/4] Which Stream Deck? 1 = 15-key (Original/MK.2), 2 = 8-key Neo  [default 1]'
$profileFile = if ($choice -eq '2') { 'HabitTracker-Neo.streamDeckProfile' } else { 'HabitTracker-MK2.streamDeckProfile' }

# 3) Plugin (own plugin: habit keys + AI slot keys with live faces)
Write-Host '[3/4] Downloading + installing the Habit Tracker AI plugin...' -ForegroundColor Yellow
$pluginPath = Join-Path $dl 'com.kalmansforge.habit-tracker.streamDeckPlugin'
Invoke-WebRequest "$base/downloads/com.kalmansforge.habit-tracker.streamDeckPlugin" -OutFile $pluginPath
Start-Process $pluginPath   # Stream Deck app pops an install prompt -> click Install
Start-Sleep -Seconds 4

# 4) Profile
Write-Host "[4/4] Downloading + importing profile: $profileFile ..." -ForegroundColor Yellow
$profilePath = Join-Path $dl $profileFile
Invoke-WebRequest "$base/downloads/$profileFile" -OutFile $profilePath
Start-Process $profilePath  # Stream Deck app pops an import prompt -> confirm

Write-Host ''
Write-Host 'Done. Confirm the two Stream Deck prompts (plugin install + profile import),' -ForegroundColor Green
Write-Host 'plug in the deck, pick the "Habit Tracker AI" profile, and tap away.' -ForegroundColor Green
Write-Host "Dashboard: $base" -ForegroundColor Cyan
