#!/usr/bin/env bash
# ===========================================================================
# scripts/setup-convex-env.sh
# ---------------------------------------------------------------------------
# Pushes the Convex-side environment variables onto the deployment selected by
# CONVEX_DEPLOYMENT in .env.local (or onto prod with --prod).
#
# Two sources, and the split is the point:
#
#   .env.convex   PER-CLIENT values — the restaurant's AWS keys, its Stripe
#                 account, its own Deliveroo brand/site ids. One file per
#                 client repo, gitignored, shared with nobody.
#   Infisical     BEYOURS' OWN credentials, byte-identical on every client
#                 deployment: the Uber Eats / Deliveroo partner apps, the
#                 OpenAI key, the BeYours billing Stripe. Opt in with
#                 --infisical.
#
# Why bother: rotating a partner-app secret meant editing N copies of
# .env.convex by hand and hoping none was missed. tasks/secret-rotation-runbook.md
# (A.1) spells that out — "propagate the new value to every store that needs
# it" — and the number of stores grows with every client signed. With
# --infisical the shared half has ONE source, and this script is how it reaches
# a deployment.
#
# Setup and conventions: apps/docs/deployment/infisical.md
#
# Usage:
#   bash scripts/setup-convex-env.sh                      # .env.convex only
#   bash scripts/setup-convex-env.sh .env.convex.staging  # another file
#   bash scripts/setup-convex-env.sh --infisical          # shared + per-client
#   bash scripts/setup-convex-env.sh --infisical --prod   # ...onto prod
#   bash scripts/setup-convex-env.sh --infisical --dry-run
#   bash scripts/setup-convex-env.sh --infisical --path=/demo
#
# --infisical needs the CLI (https://infisical.com/docs/cli/overview) and:
#   INFISICAL_PROJECT_ID   the BeYours platform project
#   INFISICAL_ENV          environment slug — deliberately no default
#   INFISICAL_PATH         folder, defaults to /platform (--path= overrides)
#   INFISICAL_TOKEN        machine identity token, or run `infisical login`
#
# INFISICAL_ENV has no default because the CLI's own default is `dev`, and this
# script writes to a live deployment: an unset variable would quietly push
# development values onto a restaurant's site.
#
# INFISICAL_PATH defaults to /platform and REFUSES `/`. The root folder holds
# zero keys in every environment — every secret lives in /platform, /site,
# /reference, /themes or /demo — so the old `/` default made this script print
# a confident green "0 variables set" and propagate nothing. A rotation done
# per the runbook left every restaurant on the revoked credential. A zero-key
# export is now a hard error for the same reason: reading nothing is never a
# successful push.
#
# LIMIT: values are pushed one line at a time, so a value containing a newline
# (a PEM key, say) cannot travel through here. None does today.
#
# This script never prints a secret value — only key names.
# ===========================================================================
set -euo pipefail

usage() {
  sed -n '3,56p' "$0" | sed 's/^# \{0,1\}//'
}

# The folder the shared half lives in. Not `/` — see the header.
DEFAULT_INFISICAL_PATH="/platform"

ENV_FILE=""
USE_INFISICAL=false
DRY_RUN=false
PATH_FLAG=""
CONVEX_TARGET=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --infisical) USE_INFISICAL=true ;;
    --prod) CONVEX_TARGET=(--prod) ;;
    --dry-run) DRY_RUN=true ;;
    --path=*) PATH_FLAG="${1#--path=}" ;;
    --path)
      # A bare trailing `--path` would otherwise shift past the end of "$@" and
      # die on the loop's own shift, with no message at all.
      [[ $# -ge 2 ]] || { echo "Error: --path needs a folder, e.g. --path=/platform" >&2; exit 2; }
      PATH_FLAG="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; echo "Try --help." >&2; exit 2 ;;
    *) ENV_FILE="$1" ;;
  esac
  shift
done

ENV_FILE="${ENV_FILE:-.env.convex}"

# `${arr[@]}` on an empty array is an unbound variable under `set -u` in bash
# 3.2, which is what macOS still ships. This form expands to nothing instead.
convex_target() { echo "${CONVEX_TARGET[@]+${CONVEX_TARGET[@]}}"; }

if [[ ${#CONVEX_TARGET[@]} -gt 0 ]]; then
  echo "Target: PRODUCTION deployment (--prod)."
else
  echo "Target: the deployment named by CONVEX_DEPLOYMENT in .env.local."
fi
$DRY_RUN && echo "Dry run — nothing will be written."
echo

# Names Convex provides itself. Setting one is refused by the API with
# `EnvVarNameForbidden`, which under `set -e` aborted the whole push after
# writing whatever came before it alphabetically. Found by running this against
# a fresh deployment on 2026-09-01: `.env.convex.example` listed CONVEX_SITE_URL
# as something to set, so every client provisioning would have died there.
CONVEX_BUILT_IN=" CONVEX_CLOUD_URL CONVEX_SITE_URL "
is_built_in() { case "$CONVEX_BUILT_IN" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
built_in_skipped=""

# Secrets a DEPLOYMENT owns. Same list as DEPLOYMENT_OWNED in
# scripts/infisical-bootstrap.mjs, which documents why each one is on it; the
# two are held together by setup-convex-env.test.mjs, because this file ships
# inside a client clone where that script does not exist.
#
# They must never arrive from the shared store. Each is generated for ONE
# backend: push one deployment's ENCRYPTION_KEY onto another and every merchant
# on the receiving side has to redo the OAuth connect flow, push one
# BETTER_AUTH_SECRET and a single client's leak logs everybody out. The
# ownership table in apps/docs/deployment/infisical.md states the rule; before
# this list nothing enforced it, and a dry run against /themes really did
# answer `would set JWT_PRIVATE_KEY / JWKS / ENCRYPTION_KEY /
# BETTER_AUTH_SECRET`.
#
# They are still perfectly legitimate in .env.convex — that file IS one
# deployment's own half, and .env.convex.example asks for four of them.
DEPLOYMENT_OWNED=" JWT_PRIVATE_KEY JWKS BETTER_AUTH_SECRET EMAIL_API_SECRET ENCRYPTION_KEY ADMIN_BOOTSTRAP_TOKEN SEED_PASSWORD "
is_deployment_owned() { case "$DEPLOYMENT_OWNED" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# The two of those that no file may carry, from either source. `@convex-dev/auth`
# generates them with its own CLI and writes them straight onto the deployment;
# nothing else may name them, and a copy in a dotenv is a mistake wherever it is.
AUTH_KEYPAIR=" JWT_PRIVATE_KEY JWKS "
is_auth_keypair() { case "$AUTH_KEYPAIR" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

deployment_owned_skipped=""

# Keys already pushed, so the local file cannot silently undo the shared store.
# A plain string rather than an associative array, for the same bash 3.2 reason.
seen=""
is_seen() { case " $seen " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

overridden=""
count=0
# Every KEY= line the shared export carried, before any filtering. `count` is
# what got pushed and cannot answer "did the store have anything to say" — a
# folder holding only deployment-owned keys pushes nothing and is a different
# problem from a folder holding nothing at all.
shared_keys_read=0

set_var() {
  local key="$1" value="$2"
  if $DRY_RUN; then
    echo "  would set $key"
  else
    echo "  -> set $key"
    # shellcheck disable=SC2046
    pnpx convex env set "$key" "$value" $(convex_target) >/dev/null
  fi
  seen="$seen $key"
  count=$((count + 1))
}

# Turns the right-hand side of a KEY=VALUE line into the value.
#
# This is the same rule as `parseValue` in apps/reference/e2e/load-env.ts, on
# purpose: the two must agree about what a line means. It is not academic.
# `npx convex dev` writes
#
#   CONVEX_DEPLOYMENT=dev:youthful-goose-352 # team: …, project: beyours-reference
#
# and taking everything after the `=` pushes the comment into the value. The
# Convex CLI then answers "InvalidDeploymentName", pointing nowhere near the
# file that caused it. An inline comment needs whitespace before the `#`, so a
# value containing `#` with no space survives; anything stranger must be quoted.
parse_value() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"          # ltrim
  v="${v%"${v##*[![:space:]]}"}"          # rtrim
  case "$v" in
    '"'*) v="${v#\"}"; v="${v%%\"*}" ;;
    "'"*) v="${v#\'}"; v="${v%%\'*}" ;;
    *)
      # %% takes the LONGEST matching suffix, which is the FIRST " #".
      if [[ "$v" == *[[:space:]]#* ]]; then
        v="${v%%[[:space:]]#*}"
        v="${v%"${v##*[![:space:]]}"}"
      fi
      ;;
  esac
  printf '%s' "$v"
}

# Reads KEY=VALUE lines. $2 is "shared" for the Infisical export (authoritative)
# or "local" for the .env.convex file (yields to whatever the shared store set).
read_dotenv() {
  local file="$1" origin="$2" line key value raw
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^(export[[:space:]]+)?([A-Z_][A-Z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[2]}"
      raw="${BASH_REMATCH[3]}"
      if [[ "$origin" == "shared" ]]; then shared_keys_read=$((shared_keys_read + 1)); fi
      # `KEY=   # left blank on purpose` is a line with a comment and no value.
      # parse_value returns "# left blank..." for it — and so does load-env.ts,
      # which is why the rule above is not the place to fix this. There it lands
      # in process.env; here it would be pushed onto a live deployment, so the
      # push is where it gets caught.
      [[ "$(printf '%s' "$raw" | sed -E 's/^[[:space:]]+//')" == "#"* ]] && continue
      value="$(parse_value "$raw")"
      [[ -z "$value" ]] && continue
      if is_built_in "$key"; then
        built_in_skipped="$built_in_skipped $key"
        continue
      fi
      if is_auth_keypair "$key" || { [[ "$origin" == "shared" ]] && is_deployment_owned "$key"; }; then
        case " $deployment_owned_skipped " in
          *" $key "*) ;;
          *) deployment_owned_skipped="$deployment_owned_skipped $key" ;;
        esac
        continue
      fi
      if [[ "$origin" == "local" ]] && is_seen "$key"; then
        overridden="$overridden $key"
        continue
      fi
      set_var "$key" "$value"
    fi
  done < "$file"
}

# ── Shared half — BeYours' own credentials ─────────────────────────────────
if $USE_INFISICAL; then
  if ! command -v infisical >/dev/null 2>&1; then
    echo "Error: the Infisical CLI is not on PATH." >&2
    echo "  brew install infisical/get-cli/infisical" >&2
    echo "  See apps/docs/deployment/infisical.md" >&2
    exit 1
  fi
  : "${INFISICAL_PROJECT_ID:?set INFISICAL_PROJECT_ID (see apps/docs/deployment/infisical.md)}"
  : "${INFISICAL_ENV:?set INFISICAL_ENV — there is no default, see the header}"

  infisical_path="${PATH_FLAG:-${INFISICAL_PATH:-$DEFAULT_INFISICAL_PATH}}"
  case "$infisical_path" in
    /) infisical_path="" ;;                 # root: refused below
    /*) ;;
    # `:-` above means nothing empty reaches here today. The branch is here so
    # that if anything ever does, it falls into the refusal below — without it
    # the `*` case would turn "" into "/", the one value this must not accept.
    "") ;;
    *) infisical_path="/$infisical_path" ;; # `--path=demo` means /demo
  esac
  if [[ -z "$infisical_path" ]]; then
    echo "Error: refusing to read the Infisical ROOT folder (/)." >&2
    echo "It holds zero keys in every environment — every secret lives one" >&2
    echo "level down, so a run against / pushes nothing and says so in green." >&2
    echo >&2
    echo "Name a folder instead:" >&2
    echo "  --path=/platform   BeYours' shared credentials — the usual answer" >&2
    echo "  --path=/demo       the one demo backend BeYours runs itself" >&2
    echo "  --path=/themes     the defaults a client clone starts from" >&2
    echo >&2
    echo "Or leave INFISICAL_PATH unset to get $DEFAULT_INFISICAL_PATH." >&2
    echo "See apps/docs/deployment/infisical.md" >&2
    exit 1
  fi

  umask 077
  export_file="$(mktemp)"
  trap 'rm -f "$export_file"' EXIT

  echo "Reading Infisical (env=$INFISICAL_ENV path=$infisical_path)..."
  # --include-imports defaults to true, so a client folder that imports the
  # platform folder exports both halves in one call.
  INFISICAL_DISABLE_UPDATE_CHECK=true infisical export \
    --format=dotenv \
    --projectId="$INFISICAL_PROJECT_ID" \
    --env="$INFISICAL_ENV" \
    --path="$infisical_path" > "$export_file"

  read_dotenv "$export_file" "shared"

  # A folder that answers with nothing is the failure this whole flag exists to
  # prevent: the run is green, the operator ticks "propagated" in the runbook,
  # and every deployment keeps the credential that was just revoked.
  if [[ $shared_keys_read -eq 0 ]]; then
    echo >&2
    echo "Error: $infisical_path holds no keys in env=$INFISICAL_ENV." >&2
    echo "Nothing was read, so nothing shared can have been propagated —" >&2
    echo "refusing to report success on an empty rotation." >&2
    echo >&2
    echo "Check the folder and the environment slug:" >&2
    echo "  infisical secrets --projectId=\$INFISICAL_PROJECT_ID \\" >&2
    echo "    --env=$INFISICAL_ENV --path=$infisical_path" >&2
    echo "  node scripts/infisical-bootstrap.mjs check --env=$INFISICAL_ENV" >&2
    echo "See apps/docs/deployment/infisical.md" >&2
    exit 1
  fi
  echo
fi

# ── Per-client half ────────────────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  if $USE_INFISICAL; then
    echo "Note: $ENV_FILE not found — shared half only."
  else
    echo "Error: $ENV_FILE not found." >&2
    echo "Create it from .env.convex.example, then run again." >&2
    exit 1
  fi
else
  echo "Reading $ENV_FILE..."
  read_dotenv "$ENV_FILE" "local"
fi

echo
if $DRY_RUN; then
  echo "$count variables would be set on Convex."
else
  echo "$count variables set on Convex."
fi

if [[ -n "$built_in_skipped" ]]; then
  echo
  echo "Skipped — Convex provides these itself and refuses to have them set:"
  for key in $built_in_skipped; do echo "  - $key"; done
fi

if [[ -n "$deployment_owned_skipped" ]]; then
  echo
  echo "NOT PUSHED — this deployment owns these, they are never shared:"
  for key in $deployment_owned_skipped; do echo "  - $key"; done
  echo "Each is generated for ONE backend. Two deployments holding the same"
  echo "ENCRYPTION_KEY means one client's leak decrypts another's OAuth tokens;"
  echo "the JWT pair belongs to the auth tooling and to nothing else."
  echo "Set this deployment's own values in $ENV_FILE, or let the auth CLI"
  echo "write them. See apps/docs/deployment/infisical.md."
fi

if [[ -n "$overridden" ]]; then
  echo
  echo "Ignored in $ENV_FILE — the shared store is authoritative for these:"
  for key in $overridden; do echo "  - $key"; done
  echo "They are stale local copies of BeYours credentials. Delete them from"
  echo "$ENV_FILE so the next rotation has one place to change, not two."
fi
