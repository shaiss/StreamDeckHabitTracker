# Habit Tracker - Stream Deck bootstrap (Windows).
# One-liner:  irm https://stream-deck-habit-tracker.vercel.app/setup.ps1 | iex
#
# Safe to re-run: this is a CLEAN INSTALL and the supported upgrade path. It
# detects previous installs - the current plugin, the legacy com.kalmansforge
# build, and any imported "Habit Tracker*" profiles - removes them, and
# installs fresh. Ordering is deliberately fail-closed: everything is
# downloaded, extracted, and validated BEFORE anything existing is touched, so
# a network blip or corrupt download can never leave the deck stripped bare.
#
# (ASCII on purpose: irm decodes text/* without an explicit charset as
# ISO-8859-1 on Windows PowerShell 5.1, which would mangle fancy dashes.)

$ErrorActionPreference = 'Stop'
$base = 'https://stream-deck-habit-tracker.vercel.app'
$dl = Join-Path $env:USERPROFILE 'Downloads'
$sdData = Join-Path $env:APPDATA 'Elgato\StreamDeck'
$pluginsDir = Join-Path $sdData 'Plugins'
$profilesDir = Join-Path $sdData 'ProfilesV2'
$pluginId = 'com.shaiss.habit-tracker.sdPlugin'
$profileFile = 'HabitTracker-MK2.streamDeckProfile'

Write-Host ''
Write-Host '=== Habit Tracker -> Stream Deck setup ===' -ForegroundColor Cyan

# 1) Stream Deck app. Fail closed: nothing destructive may run unless the app
# is confirmed present - a half-cleaned machine with no app is the one outcome
# this script must never produce.
$findSd = {
  @(
    "$env:ProgramFiles\Elgato\StreamDeck\StreamDeck.exe",
    "${env:ProgramFiles(x86)}\Elgato\StreamDeck\StreamDeck.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
$sd = & $findSd
if (-not $sd) {
  Write-Host '[1/7] Installing the Elgato Stream Deck app (winget)...' -ForegroundColor Yellow
  winget install -e --id Elgato.StreamDeck --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) { throw "winget install failed (exit $LASTEXITCODE) - aborting before touching anything." }
  $sd = & $findSd
  if (-not $sd) { throw 'Stream Deck app still not found after install - aborting before touching anything.' }
} else {
  Write-Host '[1/7] Stream Deck app already installed.' -ForegroundColor Green
}

# 2) Download BOTH artifacts up front. Invoke-WebRequest throws on HTTP errors
# under $ErrorActionPreference = 'Stop', so failures land here - before any
# cleanup - and the existing install stays intact.
Write-Host '[2/7] Downloading plugin + profile...' -ForegroundColor Yellow
$zip = Join-Path $dl 'com.shaiss.habit-tracker.streamDeckPlugin.zip'
Invoke-WebRequest "$base/downloads/com.shaiss.habit-tracker.streamDeckPlugin" -OutFile $zip
$profilePath = Join-Path $dl $profileFile
Invoke-WebRequest "$base/downloads/$profileFile" -OutFile $profilePath

# 3) Stage + validate the plugin in a temp dir. A .streamDeckPlugin is a plain
# zip with the .sdPlugin folder at its root (Expand-Archive insists on a .zip
# extension, hence the renamed download). Only a package that extracts AND
# carries a readable manifest is allowed to replace the live install.
Write-Host '[3/7] Extracting + validating the plugin package...' -ForegroundColor Yellow
$stage = Join-Path $env:TEMP 'habit-tracker-setup-stage'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $stage -Force
$stagedPlugin = Join-Path $stage $pluginId
$stagedManifest = Join-Path $stagedPlugin 'manifest.json'
if (-not (Test-Path $stagedManifest)) { throw "downloaded plugin package is missing $pluginId/manifest.json - aborting before touching anything." }
$newVersion = (Get-Content $stagedManifest -Raw | ConvertFrom-Json).Version
Write-Host "      plugin package OK - version $newVersion" -ForegroundColor Green

# 4) Stop the app while we swap its files. It only rescans Plugins/ and
# ProfilesV2/ at launch, and swapping a live plugin folder is how installs go
# stale - the whole reason this script reinstalls clean.
$running = Get-Process -Name 'StreamDeck' -ErrorAction SilentlyContinue
if ($running) {
  Write-Host '[4/7] Stopping the Stream Deck app...' -ForegroundColor Yellow
  $running | Stop-Process -Force
  Start-Sleep -Seconds 3
} else {
  Write-Host '[4/7] Stream Deck app not running.' -ForegroundColor Green
}

# 5) Remove previous installs so nothing stale survives. Everything new is
# already staged and validated, so this is the first destructive step.
Write-Host '[5/7] Removing previous plugin/profile installs (if any)...' -ForegroundColor Yellow
$removed = @()
foreach ($id in $pluginId, 'com.kalmansforge.habit-tracker.sdPlugin') {
  $p = Join-Path $pluginsDir $id
  if (Test-Path $p) { Remove-Item $p -Recurse -Force; $removed += "plugin $id" }
}
if (Test-Path $profilesDir) {
  Get-ChildItem $profilesDir -Directory -Filter '*.sdProfile' | ForEach-Object {
    $mf = Join-Path $_.FullName 'manifest.json'
    if (Test-Path $mf) {
      $name = $null
      try { $name = (Get-Content $mf -Raw | ConvertFrom-Json).Name }
      catch { Write-Warning "skipping unreadable profile manifest: $mf" }
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
  Write-Host '      nothing to remove - fresh machine.' -ForegroundColor Green
}

# 6) Install the staged plugin and relaunch. Copy (not Move) so a TEMP on a
# different volume can never trip directory-move semantics.
Write-Host "[6/7] Installing plugin $newVersion + starting the Stream Deck app..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null
Copy-Item -Path $stagedPlugin -Destination $pluginsDir -Recurse -Force
Remove-Item $stage -Recurse -Force
Start-Process $sd
Start-Sleep -Seconds 5

# 7) Profile. Import goes through the app (it binds the profile to your deck),
# and step 5 already cleared old copies, so this never piles up duplicates.
Write-Host "[7/7] Importing profile: $profileFile ..." -ForegroundColor Yellow
Start-Process $profilePath  # Stream Deck app pops an import prompt -> confirm

Write-Host ''
Write-Host "Done. Plugin $newVersion installed. Confirm the profile-import prompt," -ForegroundColor Green
Write-Host 'plug in the deck, pick the "Habit Tracker AI" profile, and tap away.' -ForegroundColor Green
Write-Host 'Re-run this one-liner any time to upgrade - it always installs clean.' -ForegroundColor Green
Write-Host "Dashboard: $base" -ForegroundColor Cyan
