#!/usr/bin/env bash
# ==============================================================================
# Chrome Kiosk Print — Auto-print tickets with no dialog box
# ==============================================================================
#
# This script launches Google Chrome in kiosk-printing mode.
# When the KDS page calls window.print(), Chrome prints straight to the
# default printer without showing the "Print" dialog.
#
# REQUIREMENTS:
#   1. Google Chrome installed
#   2. A thermal printer set as the system default printer
#   3. The KDS URL (e.g. http://localhost:3000/kitchen)
#
# USAGE:
#   ./scripts/kiosk-print.sh [URL]
#
# EXAMPLES:
#   ./scripts/kiosk-print.sh                                # default: localhost:3000/kitchen
#   ./scripts/kiosk-print.sh http://192.168.1.100:3000/kitchen
#   ./scripts/kiosk-print.sh https://monrestaurant.com/kitchen
#
# OPTIONS:
#   --printer NAME   Print to NAME instead of the current default. Sets NAME
#                    as the OS default printer for this run and restores the
#                    previous default on exit (normal, Ctrl+C, or kill).
#   --profile PATH   Use a dedicated Chrome profile
#   --kiosk          Full kiosk mode (fullscreen, no address bar)
#   --help           Show this help
#
# NOTES:
#   - The --kiosk-printing flag suppresses the print dialog
#   - The optional --kiosk flag puts Chrome fullscreen (ideal for a kitchen tablet)
#   - Use a dedicated Chrome profile to avoid clashing with your own session
#   - --printer refuses to start if NAME is not in `lpstat -p`
#   - Default-printer restore uses `lpoptions -d`; SIGKILL (kill -9) skips it
#     and NAME stays the default
#
# ==============================================================================

set -euo pipefail

# --- Default configuration ---------------------------------------------------
DEFAULT_URL="http://localhost:3000/kitchen"
PROFILE_DIR=""
KIOSK_MODE=false
PRINTER_NAME=""

# --- Colors ------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# --- Functions ---------------------------------------------------------------

print_help() {
  head -39 "$0" | tail -37 | sed 's/^# //' | sed 's/^#//'
}

log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[OK]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# --- Detect Chrome -----------------------------------------------------------

detect_chrome() {
  local chrome_path=""

  case "$(uname -s)" in
    Darwin)
      # macOS
      if [ -d "/Applications/Google Chrome.app" ]; then
        chrome_path="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      elif [ -d "$HOME/Applications/Google Chrome.app" ]; then
        chrome_path="$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      fi
      ;;
    Linux)
      # Linux — look in the standard paths
      for bin in google-chrome google-chrome-stable chromium-browser chromium; do
        if command -v "$bin" &>/dev/null; then
          chrome_path="$(command -v "$bin")"
          break
        fi
      done
      ;;
    *)
      log_error "Systeme non supporte: $(uname -s)"
      exit 1
      ;;
  esac

  if [ -z "$chrome_path" ]; then
    log_error "Google Chrome non trouve."
    log_info "Installez Chrome: https://www.google.com/chrome/"
    exit 1
  fi

  echo "$chrome_path"
}

# --- List printers -----------------------------------------------------------

list_printers() {
  case "$(uname -s)" in
    Darwin)
      lpstat -p 2>/dev/null | awk '{print $2}' || true
      ;;
    Linux)
      lpstat -p 2>/dev/null | awk '{print $2}' || true
      ;;
  esac
}

get_default_printer() {
  case "$(uname -s)" in
    Darwin)
      lpstat -d 2>/dev/null | awk -F': ' '{print $2}' || echo ""
      ;;
    Linux)
      lpstat -d 2>/dev/null | awk -F': ' '{print $2}' || echo ""
      ;;
  esac
}

printer_exists() {
  list_printers | grep -Fxq "$1"
}

# --- Parse arguments ---------------------------------------------------------

URL="$DEFAULT_URL"

while [[ $# -gt 0 ]]; do
  case $1 in
    --help|-h)
      print_help
      exit 0
      ;;
    --kiosk)
      KIOSK_MODE=true
      shift
      ;;
    --printer)
      PRINTER_NAME="$2"
      shift 2
      ;;
    --profile)
      PROFILE_DIR="$2"
      shift 2
      ;;
    http://*|https://*)
      URL="$1"
      shift
      ;;
    *)
      log_error "Option inconnue: $1"
      print_help
      exit 1
      ;;
  esac
done

# --- Execution ---------------------------------------------------------------

CHROME="$(detect_chrome)"
log_success "Chrome detecte: $CHROME"

# Dedicated profile to avoid conflicts
if [ -z "$PROFILE_DIR" ]; then
  PROFILE_DIR="$HOME/.chrome-kiosk-print"
fi
log_info "Profil Chrome: $PROFILE_DIR"

# --- Printer targeting --------------------------------------------------------
# --printer sets NAME as the CUPS user default for the life of this script and
# restores the previous default on exit, since --kiosk-printing always prints
# to whatever is the OS default at print time.

ORIGINAL_DEFAULT_PRINTER=""
PRINTER_OVERRIDDEN=false

restore_default_printer() {
  if [ "$PRINTER_OVERRIDDEN" = true ]; then
    PRINTER_OVERRIDDEN=false
    if [ -n "$ORIGINAL_DEFAULT_PRINTER" ]; then
      if lpoptions -d "$ORIGINAL_DEFAULT_PRINTER" >/dev/null 2>&1; then
        log_info "Imprimante par defaut restauree: $ORIGINAL_DEFAULT_PRINTER"
      else
        log_warn "Impossible de restaurer l'imprimante par defaut: $ORIGINAL_DEFAULT_PRINTER"
      fi
    fi
  fi
}

on_signal() {
  trap - EXIT INT TERM
  restore_default_printer
  exit "$1"
}

trap restore_default_printer EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

# Check the printer
DEFAULT_PRINTER="$(get_default_printer)"
if [ -n "$PRINTER_NAME" ]; then
  if ! command -v lpoptions &>/dev/null; then
    log_error "lpoptions introuvable (CUPS requis). Impossible de cibler une imprimante."
    exit 1
  fi
  if ! printer_exists "$PRINTER_NAME"; then
    log_error "Imprimante introuvable: $PRINTER_NAME"
    log_info "Imprimantes disponibles:"
    list_printers | while read -r p; do echo "  - $p"; done
    exit 1
  fi
  if [ "$PRINTER_NAME" != "$DEFAULT_PRINTER" ]; then
    ORIGINAL_DEFAULT_PRINTER="$DEFAULT_PRINTER"
    lpoptions -d "$PRINTER_NAME"
    PRINTER_OVERRIDDEN=true
    log_success "Imprimante par defaut definie sur: $PRINTER_NAME (restauree a la fin)"
  else
    log_info "Imprimante ciblee: $PRINTER_NAME (deja par defaut)"
  fi
elif [ -n "$DEFAULT_PRINTER" ]; then
  log_info "Imprimante par defaut: $DEFAULT_PRINTER"
else
  log_warn "Aucune imprimante par defaut detectee."
  log_info "Imprimantes disponibles:"
  list_printers | while read -r p; do echo "  - $p"; done
fi

# Build the Chrome flags
CHROME_FLAGS=(
  "--kiosk-printing"
  "--user-data-dir=$PROFILE_DIR"
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
if [ "$KIOSK_MODE" = true ]; then
  CHROME_FLAGS+=("--kiosk")
  log_info "Mode kiosk (plein ecran) active"
fi

echo ""
log_info "Lancement de Chrome kiosk-print..."
log_info "URL: $URL"
echo ""
echo -e "${YELLOW}---------------------------------------------------${NC}"
echo -e "${YELLOW} Chrome va imprimer AUTOMATIQUEMENT sur l'imprimante${NC}"
echo -e "${YELLOW} par defaut quand le KDS enverra un ticket.${NC}"
echo -e "${YELLOW}---------------------------------------------------${NC}"
echo ""
echo -e "Pour arreter: ${RED}Ctrl+C${NC} ou fermez Chrome."
echo ""

# Launch Chrome as a child, not exec, so the traps above can restore the
# previous default printer after Chrome exits.
"$CHROME" "${CHROME_FLAGS[@]}" "$URL" &
wait $!
