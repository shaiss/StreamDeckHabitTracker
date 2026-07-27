# Habit Tracker - Stream Deck bootstrap (Windows).
# One-liner:  irm https://stream-deck-habit-tracker.vercel.app/setup.ps1 | iex
#
# Safe to re-run: this is a CLEAN INSTALL and the supported upgrade path. It
# detects previous installs - the current plugin, the legacy com.kalmansforge
# build, and any imported "Habit Tracker*" profiles - removes them, and
# installs fresh. The profile ships INSIDE the plugin (manifest Profiles[]
# with AutoInstall, issue #50). Stream Deck auto-installs a bundled profile
# only on the FIRST install of a plugin it has never seen - it does NOT re-fire
# that step when an already-known plugin is upgraded (the app keeps its own
# install record outside the plugin folder). So: a fresh machine ends with ZERO
# prompts, and an UPGRADE (where step 5 just cleared the old profile) imports
# the bundled copy directly - one confirm prompt. Either way you never end up
# with no profile. Ordering is deliberately fail-closed: everything is
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
# Profile storage moved between app generations: ProfilesV2 (Stream Deck 6.x)
# vs ProfilesV3 (7.x). Clean both - an upgraded machine can carry either.
# Still needed after the import step went away: machines set up before the
# profile was bundled carry an IMPORTED copy that would coexist with (and
# confuse) the bundled one.
$profileDirs = @((Join-Path $sdData 'ProfilesV2'), (Join-Path $sdData 'ProfilesV3'))
$pluginId = 'com.shaiss.habit-tracker.sdPlugin'
# The bundled profile, relative to the .sdPlugin root - validated while staged,
# then imported from the installed copy if the app's AutoInstall doesn't cover it.
$profileRel = 'profiles\Habit Tracker AI.streamDeckProfile'

# Is a "Habit Tracker*" profile already present in either store? Used to tell a
# fresh install (AutoInstall did the work, no prompt) from an upgrade (we must
# import). Same recognize-by-manifest-Name rule as the step 5 cleanup.
$findHtProfile = {
  foreach ($profilesDir in $profileDirs) {
    if (-not (Test-Path $profilesDir)) { continue }
    foreach ($d in (Get-ChildItem $profilesDir -Directory -Filter '*.sdProfile' -ErrorAction SilentlyContinue)) {
      $mf = Join-Path $d.FullName 'manifest.json'
      if (-not (Test-Path $mf)) { continue }
      $name = $null
      try { $name = (Get-Content $mf -Raw | ConvertFrom-Json).Name } catch { }
      if ($name -like 'Habit Tracker*') { return $d.FullName }
    }
  }
  return $null
}

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

# 2) Download the plugin up front (the profile ships inside it).
# Invoke-WebRequest throws on HTTP errors under $ErrorActionPreference =
# 'Stop', so failures land here - before any cleanup - and the existing
# install stays intact.
Write-Host '[2/7] Downloading the plugin...' -ForegroundColor Yellow
$zip = Join-Path $dl 'com.shaiss.habit-tracker.streamDeckPlugin.zip'
Invoke-WebRequest "$base/downloads/com.shaiss.habit-tracker.streamDeckPlugin" -OutFile $zip

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
# Validate the bundled profile too - step 5 deletes the existing profile, so a
# package with a good manifest but a missing/corrupt profile would otherwise
# strip the deck bare. Open it as a real ZIP and require the .sdProfile
# manifest entry: a truncated or malformed file (which passes a magic-byte
# check) fails to open here. Fail closed like the manifest check above.
$stagedProfile = Join-Path $stagedPlugin $profileRel
$profileOk = $false
if (Test-Path $stagedProfile) {
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zipArchive = [System.IO.Compression.ZipFile]::OpenRead($stagedProfile)
    try {
      # A real Habit Tracker profile is a zip whose entries include the
      # <UUID>.sdProfile/manifest.json outer manifest.
      $profileOk = [bool]($zipArchive.Entries | Where-Object { $_.FullName -like '*.sdProfile/manifest.json' })
    } finally { $zipArchive.Dispose() }
  } catch { $profileOk = $false }
}
if (-not $profileOk) { throw "downloaded plugin package has a missing, unreadable, or corrupt bundled profile ($profileRel) - aborting before touching anything." }
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
# Track whether OUR plugin UUID was already installed: AutoInstall fires only on
# a plugin the app has never seen, so if it was present this is an upgrade and
# there is no point waiting for AutoInstall in step 7 (the legacy id is a
# different UUID and doesn't count).
$pluginWasPresent = $false
foreach ($id in $pluginId, 'com.kalmansforge.habit-tracker.sdPlugin') {
  $p = Join-Path $pluginsDir $id
  if (Test-Path $p) {
    Remove-Item $p -Recurse -Force
    $removed += "plugin $id"
    if ($id -eq $pluginId) { $pluginWasPresent = $true }
  }
}
foreach ($profilesDir in $profileDirs) {
  if (-not (Test-Path $profilesDir)) { continue }
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

# 7) Make sure the profile actually landed. On a first-ever install of this
# plugin, Stream Deck auto-installs the bundled profile on launch (no prompt).
# On an upgrade of a plugin it already knows, that step does NOT re-fire - and
# step 5 just removed any prior copy - so nothing would appear. Detect that and
# import the bundled profile directly (the app's normal import: one confirm
# prompt). The bundled profile carries a fixed UUID, so if AutoInstall did land
# a copy, the app treats this as the same profile rather than a duplicate.
Write-Host '[7/7] Verifying the Habit Tracker AI profile...' -ForegroundColor Yellow
# On a first install, wait (poll) for AutoInstall to register the profile - a
# slow launch can take longer than a fixed delay, and we don't want to prompt
# for an import the app is about to do itself. On an upgrade AutoInstall won't
# fire at all, so only give it a short grace before importing.
$pollSeconds = if ($pluginWasPresent) { 4 } else { 25 }
$haveProfile = $false
$deadline = (Get-Date).AddSeconds($pollSeconds)
do {
  if (& $findHtProfile) { $haveProfile = $true; break }
  Start-Sleep -Seconds 1
} while ((Get-Date) -lt $deadline)
$prompted = $false
if ($haveProfile) {
  Write-Host '      profile installed automatically - no prompt needed.' -ForegroundColor Green
} else {
  $installedProfile = Join-Path (Join-Path $pluginsDir $pluginId) $profileRel
  if (Test-Path $installedProfile) {
    Write-Host '      importing the bundled profile - confirm the one prompt...' -ForegroundColor Yellow
    Start-Process $installedProfile
    $prompted = $true
  } else {
    Write-Warning "bundled profile not found at $installedProfile - in Stream Deck, open the profile menu and import it manually."
  }
}

Write-Host ''
if ($prompted) {
  Write-Host "Done. Plugin $newVersion installed. Confirm the profile-import prompt," -ForegroundColor Green
  Write-Host 'then plug in the deck, pick the "Habit Tracker AI" profile, and tap away.' -ForegroundColor Green
} else {
  Write-Host "Done. Plugin $newVersion installed - the Habit Tracker AI profile is" -ForegroundColor Green
  Write-Host 'ready. Plug in the deck, pick the "Habit Tracker AI" profile, and tap away.' -ForegroundColor Green
}
Write-Host 'Re-run this one-liner any time to upgrade - it always installs clean.' -ForegroundColor Green
Write-Host "Dashboard: $base" -ForegroundColor Cyan
