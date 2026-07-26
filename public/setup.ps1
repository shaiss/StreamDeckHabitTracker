# Habit Tracker — Stream Deck bootstrap (Windows).
# One-liner:  irm https://stream-deck-habit-tracker.vercel.app/setup.ps1 | iex
#
# Safe to re-run: this is a CLEAN INSTALL. It detects previous installs — the
# current plugin, the legacy com.kalmansforge build, and any imported
# "Habit Tracker*" profiles — removes them, and installs fresh. Re-running the
# one-liner is the supported upgrade path.

$ErrorActionPreference = 'Stop'
$base = 'https://stream-deck-habit-tracker.vercel.app'
$dl = Join-Path $env:USERPROFILE 'Downloads'
$sdData = Join-Path $env:APPDATA 'Elgato\StreamDeck'
$pluginsDir = Join-Path $sdData 'Plugins'
$profilesDir = Join-Path $sdData 'ProfilesV2'

Write-Host ''
Write-Host '=== Habit Tracker -> Stream Deck setup ===' -ForegroundColor Cyan

# 1) Stream Deck app
$findSd = {
  @(
    "$env:ProgramFiles\Elgato\StreamDeck\StreamDeck.exe",
    "${env:ProgramFiles(x86)}\Elgato\StreamDeck\StreamDeck.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
$sd = & $findSd
if (-not $sd) {
  Write-Host '[1/6] Installing the Elgato Stream Deck app (winget)...' -ForegroundColor Yellow
  winget install -e --id Elgato.StreamDeck --accept-source-agreements --accept-package-agreements
  $sd = & $findSd
} else {
  Write-Host '[1/6] Stream Deck app already installed.' -ForegroundColor Green
}

# 2) Stop the app while we touch its files. It only rescans Plugins/ and
# ProfilesV2/ at launch, and swapping a live plugin folder is how installs go
# stale — the whole reason this script reinstalls clean.
$running = Get-Process -Name 'StreamDeck' -ErrorAction SilentlyContinue
if ($running) {
  Write-Host '[2/6] Stopping the Stream Deck app...' -ForegroundColor Yellow
  $running | Stop-Process -Force
  Start-Sleep -Seconds 3
} else {
  Write-Host '[2/6] Stream Deck app not running.' -ForegroundColor Green
}

# 3) Remove previous installs so nothing stale survives.
Write-Host '[3/6] Removing previous plugin/profile installs (if any)...' -ForegroundColor Yellow
$removed = @()
foreach ($id in 'com.shaiss.habit-tracker.sdPlugin', 'com.kalmansforge.habit-tracker.sdPlugin') {
  $p = Join-Path $pluginsDir $id
  if (Test-Path $p) { Remove-Item $p -Recurse -Force; $removed += "plugin $id" }
}
if (Test-Path $profilesDir) {
  Get-ChildItem $profilesDir -Directory -Filter '*.sdProfile' | ForEach-Object {
    $mf = Join-Path $_.FullName 'manifest.json'
    if (Test-Path $mf) {
      $name = $null
      try { $name = (Get-Content $mf -Raw | ConvertFrom-Json).Name } catch { }
      # Only delete profiles we recognizably shipped; never guess.
      if ($name -like 'Habit Tracker*') {
        Remove-Item $_.FullName -Recurse -Force
        $removed += "profile '$name'"
      }
    }
  }
}
if ($removed.Count) {
  $removed | ForEach-Object { Write-Host "      removed $_" -ForegroundColor DarkYellow }
} else {
  Write-Host '      nothing to remove — fresh machine.' -ForegroundColor Green
}

# 4) Install the plugin by extracting it directly into Plugins/. The
# .streamDeckPlugin file is a plain zip with the .sdPlugin folder at its root,
# so this is a silent install: no app prompt, and no "already installed"
# refusal on upgrades. (Expand-Archive insists on a .zip extension.)
Write-Host '[4/6] Downloading + installing the Habit Tracker AI plugin...' -ForegroundColor Yellow
$zip = Join-Path $dl 'com.shaiss.habit-tracker.streamDeckPlugin.zip'
Invoke-WebRequest "$base/downloads/com.shaiss.habit-tracker.streamDeckPlugin" -OutFile $zip
New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null
Expand-Archive -Path $zip -DestinationPath $pluginsDir -Force

# 5) Relaunch the app so it loads the fresh plugin.
if ($sd) {
  Write-Host '[5/6] Starting the Stream Deck app...' -ForegroundColor Yellow
  Start-Process $sd
  Start-Sleep -Seconds 5
} else {
  Write-Host '[5/6] Stream Deck app not found — start it manually, then re-run.' -ForegroundColor Red
}

# 6) Profile. Import goes through the app (it binds the profile to your deck),
# and step 3 already cleared old copies, so this never piles up duplicates.
$profileFile = 'HabitTracker-MK2.streamDeckProfile'
Write-Host "[6/6] Downloading + importing profile: $profileFile ..." -ForegroundColor Yellow
$profilePath = Join-Path $dl $profileFile
Invoke-WebRequest "$base/downloads/$profileFile" -OutFile $profilePath
Start-Process $profilePath  # Stream Deck app pops an import prompt -> confirm

Write-Host ''
Write-Host 'Done. Confirm the profile-import prompt in the Stream Deck app,' -ForegroundColor Green
Write-Host 'plug in the deck, pick the "Habit Tracker AI" profile, and tap away.' -ForegroundColor Green
Write-Host 'Re-run this one-liner any time to upgrade — it always installs clean.' -ForegroundColor Green
Write-Host "Dashboard: $base" -ForegroundColor Cyan
