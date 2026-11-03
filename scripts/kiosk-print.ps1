<#
==============================================================================
 Chrome Kiosk Print (Windows) - Auto-print tickets with no dialog box
==============================================================================

 Windows companion to scripts/kiosk-print.sh (macOS/Linux). Same flags, same
 Chrome behavior - only Chrome detection and printer lookup differ, since
 Windows has neither a Darwin/Linux "open -a" style launcher nor lpstat.

 This script launches Google Chrome in kiosk-printing mode.
 When the KDS page calls window.print(), Chrome prints straight to the
 default printer without showing the "Print" dialog.

 REQUIREMENTS:
   1. Google Chrome installed
   2. A thermal printer set as the system default printer
   3. The KDS URL (e.g. http://localhost:3000/kitchen)

 USAGE:
   powershell -ExecutionPolicy Bypass -File scripts\kiosk-print.ps1 [URL] [options]

 EXAMPLES:
   .\scripts\kiosk-print.ps1                                # default: localhost:3000/kitchen
   .\scripts\kiosk-print.ps1 http://192.168.1.100:3000/kitchen
   .\scripts\kiosk-print.ps1 https://monrestaurant.com/kitchen

 OPTIONS:
   --printer NAME   Print to this specific printer. Sets NAME as the OS
                    default printer for this run and restores the previous
                    default on exit (normal, Ctrl+C, or Chrome closing).
   --profile PATH   Use a dedicated Chrome profile
   --kiosk          Full kiosk mode (fullscreen, no address bar)
   --help           Show this help

 NOTES:
   - The --kiosk-printing flag suppresses the print dialog
   - The optional --kiosk flag puts Chrome fullscreen (ideal for a kitchen tablet)
   - Use a dedicated Chrome profile to avoid clashing with your own session
   - --printer refuses to start if NAME isn't a printer Windows already knows
     about (see Win32_Printer / "Printers & scanners")
   - Default-printer restore runs in a `finally` block. Killing the process
     from Task Manager (not Ctrl+C) skips it and NAME stays the default
   - Windows blocks unsigned scripts by default. Either run with
     "-ExecutionPolicy Bypass" (as above) or unblock the file once:
     Unblock-File .\scripts\kiosk-print.ps1
==============================================================================
#>

$ErrorActionPreference = 'Stop'

# --- Default configuration ---------------------------------------------------
$DefaultUrl = "http://localhost:3000/kitchen"
$ProfileDir = ""
$KioskMode = $false
$PrinterName = ""
$Url = $DefaultUrl

# --- Functions ---------------------------------------------------------------

function Show-Help {
  @"
Chrome Kiosk Print (Windows) - Auto-print tickets with no dialog box

This script launches Google Chrome in kiosk-printing mode.
When the KDS page calls window.print(), Chrome prints straight to the
default printer without showing the "Print" dialog.

REQUIREMENTS:
  1. Google Chrome installed
  2. A thermal printer set as the system default printer
  3. The KDS URL (e.g. http://localhost:3000/kitchen)

USAGE:
  .\scripts\kiosk-print.ps1 [URL] [options]

EXAMPLES:
  .\scripts\kiosk-print.ps1
  .\scripts\kiosk-print.ps1 http://192.168.1.100:3000/kitchen
  .\scripts\kiosk-print.ps1 https://monrestaurant.com/kitchen

OPTIONS:
  --printer NAME   Print to this specific printer. Sets NAME as the OS
                   default printer for this run and restores the previous
                   default on exit (normal, Ctrl+C, or Chrome closing).
  --profile PATH   Use a dedicated Chrome profile
  --kiosk          Full kiosk mode (fullscreen, no address bar)
  --help           Show this help

NOTES:
  - Same flags as scripts/kiosk-print.sh (macOS/Linux)
  - --printer refuses to start if NAME isn't a printer Windows already knows
    about
  - Default-printer restore runs in a `finally` block; killing the process
    from Task Manager (not Ctrl+C) skips it and NAME stays the default
  - Windows blocks unsigned scripts by default. Run with
    "-ExecutionPolicy Bypass" or "Unblock-File" the script once.
"@ | Write-Host
}

function Write-LogInfo    { param([string]$Message); Write-Host "[INFO] $Message" -ForegroundColor Cyan }
function Write-LogSuccess { param([string]$Message); Write-Host "[OK] $Message" -ForegroundColor Green }
function Write-LogWarn    { param([string]$Message); Write-Host "[WARN] $Message" -ForegroundColor Yellow }
function Write-LogError   { param([string]$Message); Write-Host "[ERROR] $Message" -ForegroundColor Red }

# --- Detect Chrome -----------------------------------------------------------

function Find-Chrome {
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
  )
  if (Test-Path 'env:ProgramFiles(x86)') {
    $candidates += (Join-Path (Get-Item 'env:ProgramFiles(x86)').Value 'Google\Chrome\Application\chrome.exe')
  }
  if ($env:LOCALAPPDATA) {
    $candidates += (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  }

  foreach ($path in $candidates) {
    if ($path -and (Test-Path -LiteralPath $path -PathType Leaf)) {
      return $path
    }
  }

  $onPath = Get-Command chrome.exe -ErrorAction SilentlyContinue
  if ($onPath) {
    return $onPath.Source
  }

  return $null
}

# --- List printers -----------------------------------------------------------

function Get-PrinterList {
  try {
    Get-CimInstance -ClassName Win32_Printer -ErrorAction Stop |
      Select-Object -ExpandProperty Name
  } catch {
    @()
  }
}

function Get-DefaultPrinterName {
  try {
    $default = Get-CimInstance -ClassName Win32_Printer -ErrorAction Stop |
      Where-Object { $_.Default }
    if ($default) {
      return ($default | Select-Object -First 1 -ExpandProperty Name)
    }
  } catch {
    # Win32_Printer unavailable (locked-down WMI) - fall through to "none detected"
  }
  return ""
}

function Test-PrinterExists {
  param([string]$Name)
  (Get-PrinterList) -contains $Name
}

function Set-DefaultPrinterByName {
  param([string]$Name)
  $escaped = $Name.Replace("'", "''")
  $printer = Get-CimInstance -ClassName Win32_Printer -Filter "Name='$escaped'" -ErrorAction Stop |
    Select-Object -First 1
  if (-not $printer) {
    throw "Printer not found: $Name"
  }
  $result = Invoke-CimMethod -InputObject $printer -MethodName SetDefaultPrinter
  if ($result.ReturnValue -ne 0) {
    throw "SetDefaultPrinter returned code $($result.ReturnValue)"
  }
}

# --- Parse arguments ---------------------------------------------------------

$i = 0
while ($i -lt $args.Count) {
  $current = $args[$i]
  switch -Exact ($current) {
    '--help' { Show-Help; exit 0 }
    '-h'     { Show-Help; exit 0 }
    '--kiosk' {
      $KioskMode = $true
      $i++
    }
    '--printer' {
      if ($i + 1 -ge $args.Count) { Write-LogError "--printer requires a value"; exit 1 }
      $PrinterName = $args[$i + 1]
      $i += 2
    }
    '--profile' {
      if ($i + 1 -ge $args.Count) { Write-LogError "--profile requires a value"; exit 1 }
      $ProfileDir = $args[$i + 1]
      $i += 2
    }
    default {
      if ($current -match '^https?://') {
        $Url = $current
        $i++
      } else {
        Write-LogError "Option inconnue: $current"
        Show-Help
        exit 1
      }
    }
  }
}

# --- Execution ---------------------------------------------------------------

$Chrome = Find-Chrome
if (-not $Chrome) {
  Write-LogError "Google Chrome non trouve."
  Write-LogInfo "Installez Chrome: https://www.google.com/chrome/"
  exit 1
}
Write-LogSuccess "Chrome detecte: $Chrome"

# Dedicated profile to avoid conflicts
if (-not $ProfileDir) {
  $ProfileDir = Join-Path $env:USERPROFILE '.chrome-kiosk-print'
}
Write-LogInfo "Profil Chrome: $ProfileDir"

# --- Printer targeting --------------------------------------------------------
# --printer sets NAME as the Windows default printer for the life of this
# script and restores the previous default in the `finally` block below,
# since --kiosk-printing always prints to whatever is the OS default.

$OriginalDefaultPrinter = ""
$PrinterOverridden = $false

function Restore-DefaultPrinter {
  if ($script:PrinterOverridden) {
    $script:PrinterOverridden = $false
    if ($script:OriginalDefaultPrinter) {
      try {
        Set-DefaultPrinterByName -Name $script:OriginalDefaultPrinter
        Write-LogInfo "Imprimante par defaut restauree: $($script:OriginalDefaultPrinter)"
      } catch {
        Write-LogWarn "Impossible de restaurer l'imprimante par defaut: $($script:OriginalDefaultPrinter)"
      }
    }
  }
}

# Check the printer
$DefaultPrinter = Get-DefaultPrinterName
if ($PrinterName) {
  if (-not (Test-PrinterExists -Name $PrinterName)) {
    Write-LogError "Imprimante introuvable: $PrinterName"
    Write-LogInfo "Imprimantes disponibles:"
    foreach ($p in (Get-PrinterList)) { Write-Host "  - $p" }
    exit 1
  }
  if ($PrinterName -ne $DefaultPrinter) {
    try {
      Set-DefaultPrinterByName -Name $PrinterName
      $OriginalDefaultPrinter = $DefaultPrinter
      $PrinterOverridden = $true
      Write-LogSuccess "Imprimante par defaut definie sur: $PrinterName (restauree a la fin)"
    } catch {
      Write-LogError "Impossible de definir l'imprimante par defaut: $PrinterName ($_)"
      exit 1
    }
  } else {
    Write-LogInfo "Imprimante ciblee: $PrinterName (deja par defaut)"
  }
} elseif ($DefaultPrinter) {
  Write-LogInfo "Imprimante par defaut: $DefaultPrinter"
} else {
  Write-LogWarn "Aucune imprimante par defaut detectee."
  Write-LogInfo "Imprimantes disponibles:"
  foreach ($p in (Get-PrinterList)) { Write-Host "  - $p" }
}

# Build the Chrome flags
$ChromeFlags = @(
  "--kiosk-printing"
  "--user-data-dir=$ProfileDir"
  "--disable-translate"
  "--disable-features=TranslateUI"
  "--disable-infobars"
  "--disable-session-crashed-bubble"
  "--noerrdialogs"
  "--no-first-run"
  "--disable-default-apps"
  "--autoplay-policy=no-user-gesture-required"
)

# Full kiosk mode (tablet fullscreen)
if ($KioskMode) {
  $ChromeFlags += "--kiosk"
  Write-LogInfo "Mode kiosk (plein ecran) active"
}

Write-Host ""
Write-LogInfo "Lancement de Chrome kiosk-print..."
Write-LogInfo "URL: $Url"
Write-Host ""
Write-Host "---------------------------------------------------" -ForegroundColor Yellow
Write-Host " Chrome va imprimer AUTOMATIQUEMENT sur l'imprimante" -ForegroundColor Yellow
Write-Host " par defaut quand le KDS enverra un ticket." -ForegroundColor Yellow
Write-Host "---------------------------------------------------" -ForegroundColor Yellow
Write-Host ""
Write-Host "Pour arreter: Ctrl+C ou fermez Chrome."
Write-Host ""

# Launch Chrome as a direct child (mirrors the `exec` in kiosk-print.sh, so
# closing the terminal / Ctrl+C reaches it). Splatting the array through the
# call operator passes each argument through intact - Start-Process's
# -ArgumentList instead joins the array into one unquoted string, which
# would split a profile path or URL that contains a space. The try/finally
# guarantees the default-printer restore above runs after Chrome exits, on
# Ctrl+C, or on an unhandled error - but not if this process itself is
# killed outright (e.g. Task Manager "End task"), which no finally can catch.
$ChromeArgs = $ChromeFlags + $Url
try {
  & $Chrome @ChromeArgs
} finally {
  Restore-DefaultPrinter
}
