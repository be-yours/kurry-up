#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# check-ses-status.sh — can this deployment email a real customer yet?
#
# A new AWS account starts in the SES *sandbox*: mail only reaches addresses
# you have verified yourself, capped at 200 messages a day. A restaurant that
# opens in the sandbox takes orders and confirms none of them, and nothing
# errors visibly — SES simply refuses the send.
#
# Leaving the sandbox is a request AWS reviews by hand, so it is the one step
# of an onboarding that cannot be done on go-live day. This script answers
# where that request stands, without opening the console.
#
# Usage:
#   ./scripts/check-ses-status.sh                     # account only
#   DOMAIN=chez-mario.fr ./scripts/check-ses-status.sh   # + that identity
#   AWS_REGION=eu-west-1 ./scripts/check-ses-status.sh
#
# Exit codes:
#   0  ready — production access granted, sending enabled, reputation healthy
#      (and, when DOMAIN is given, its DKIM verified)
#   1  not ready — every reason is named
#   2  could not tell (no AWS CLI, not authenticated, no node, an unreadable
#      response, or a state this script does not recognise). Never "ready".
#
# Prerequisites: AWS CLI authenticated to the account you mean, and node on
# PATH to read the JSON. Both are already required by setup-aws.sh.
#
# See tasks/client-aws-onboarding-runbook.md — this is its step 4 gate.
# ============================================================================

REGION="${AWS_REGION:-eu-west-3}"
DOMAIN="${DOMAIN:-}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info()    { echo -e "${BLUE}[INFO]${NC}  $1"; }
log_success() { echo -e "${GREEN}[OK]${NC}    $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
log_error()   { echo -e "${RED}[ERR]${NC}   $1"; }

# Every exit before the account is read is a 2 — "could not tell". Each one
# names the remedy, because this script is run by whoever owns the AWS account
# and not necessarily by whoever set the machine up.
for tool in aws node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    log_error "$tool not found on PATH — cannot determine SES status."
    case "$tool" in
      aws)  echo "         Install the AWS CLI (https://aws.amazon.com/cli/), then: aws configure" ;;
      node) echo "         Install Node.js 20 or later — it parses the SES response." ;;
    esac
    echo "         Procedure: tasks/client-aws-onboarding-runbook.md"
    exit 2
  fi
done

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)
if [ -z "$ACCOUNT_ID" ]; then
  log_error "No AWS credentials — cannot determine SES status."
  echo "         'aws sts get-caller-identity' returned nothing, so the CLI is"
  echo "         installed but not authenticated to any account."
  echo "         Fix: aws configure   (or set AWS_PROFILE / AWS_ACCESS_KEY_ID +"
  echo "         AWS_SECRET_ACCESS_KEY for the CLIENT's account, not your own)."
  exit 2
fi
log_info "Account: $ACCOUNT_ID   Region: $REGION"

# ── The account: sandbox or not ─────────────────────────────────────────────
# Reported verbatim from sesv2 GetAccount. ProductionAccessEnabled=false IS the
# sandbox — there is no need to infer it from a failed send.
ACCOUNT_JSON=$(aws sesv2 get-account --region "$REGION" --output json 2>/dev/null || true)
if [ -z "$ACCOUNT_JSON" ]; then
  log_error "sesv2 get-account failed. Wrong region, or the caller lacks ses:GetAccount."
  exit 2
fi

# Node rather than jq: jq is not a stated prerequisite anywhere in this repo,
# node already is. It emits ONE tab-separated record, which `read` splits below.
#
# Never `eval` this. An earlier version did, and the response is not inert: a
# field containing `$(…)` was executed by the shell, and the script then tested
# the *result* of that execution instead of what AWS said — so an enforcement
# status of `HEALTHY$(…)` was reported as HEALTHY. `read` cannot do that, which
# is what makes the values above genuinely verbatim.
#
# Tabs and newlines are the separators, so `clean` strips them from values; the
# field order here is the argument order of the `read` that follows.
ACCOUNT_TSV=$(printf '%s' "$ACCOUNT_JSON" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    let a;
    try { a = JSON.parse(s); } catch { process.stdout.write("PARSE_FAILED\n"); return; }
    if (a === null || typeof a !== "object") {
      process.stdout.write("PARSE_FAILED\n");
      return;
    }
    const q = a.SendQuota || {};
    const review = (a.Details || {}).ReviewDetails || {};
    const clean = (v) => String(v).replace(/[\t\r\n]+/g, " ");
    process.stdout.write([
      "OK",
      a.ProductionAccessEnabled === true ? "yes" : "no",
      a.SendingEnabled === true ? "yes" : "no",
      a.EnforcementStatus || "UNKNOWN",
      q.Max24HourSend == null ? "?" : q.Max24HourSend,
      q.SentLast24Hours == null ? "?" : q.SentLast24Hours,
      q.MaxSendRate == null ? "?" : q.MaxSendRate,
      review.Status || "",
      review.CaseId || "",
    ].map(clean).join("\t") + "\n");
  });
' || true)

IFS=$'\t' read -r PARSE_OK PROD_ACCESS SENDING ENFORCEMENT MAX24 SENT24 RATE \
  REVIEW_STATUS REVIEW_CASE <<< "$ACCOUNT_TSV" || true

# An unparseable response, or a node that died, must read as "could not tell"
# rather than as "not in the sandbox". Without this guard `set -u` would kill
# the script on the first unset variable below, with exit 1 — the code that
# means "not ready", which is a different claim from "I do not know".
if [ "${PARSE_OK:-}" != "OK" ]; then
  log_error "Could not parse the sesv2 get-account response."
  exit 2
fi

READY=0
UNKNOWN=0
note_blocker() { READY=1; log_error "$1"; }
# A state this script does not recognise is not a pass. Exit 0 claims
# "reputation healthy", so anything that is not known-healthy has to fall
# through to exit 2 — "could not tell" — rather than bless a go-live.
note_unknown() { UNKNOWN=1; log_warn "$1"; }

echo ""
if [ "$PROD_ACCESS" = "yes" ]; then
  log_success "Production access: GRANTED — mail can reach any address."
else
  note_blocker "Production access: NOT granted — this account is in the SANDBOX."
  echo "         Only verified identities receive mail; 200 messages / 24h; 1 per second."
  echo "         Request it: https://console.aws.amazon.com/ses/home?region=$REGION#/account"
  if [ -n "$REVIEW_STATUS" ]; then
    log_info "Review of your request: $REVIEW_STATUS${REVIEW_CASE:+  (support case $REVIEW_CASE)}"
  else
    log_warn "No review on file — the request has not been submitted yet."
  fi
fi

# if/else rather than `test && log || note_blocker`: in that idiom a failing
# `log_success` also runs the `||` branch, which would report a blocker that
# does not exist.
if [ "$SENDING" = "yes" ]; then
  log_success "Sending: enabled."
else
  note_blocker "Sending: DISABLED for this account in $REGION."
fi

case "$ENFORCEMENT" in
  HEALTHY)   log_success "Reputation: HEALTHY." ;;
  PROBATION) note_blocker "Reputation: PROBATION — AWS is reviewing this account." ;;
  SHUTDOWN)  note_blocker "Reputation: SHUTDOWN — sending is paused by AWS." ;;
  *)         note_unknown "Reputation: $ENFORCEMENT (unrecognised) — check the console." ;;
esac

log_info "Quota: $SENT24 / $MAX24 sent in the last 24h, max $RATE per second."

# ── The identity, when one is named ─────────────────────────────────────────
if [ -n "$DOMAIN" ]; then
  echo ""
  IDENTITY_JSON=$(aws sesv2 get-email-identity --email-identity "$DOMAIN" \
    --region "$REGION" --output json 2>/dev/null || true)
  if [ -z "$IDENTITY_JSON" ]; then
    note_blocker "Identity '$DOMAIN' not found in SES ($REGION). Run setup-aws.sh first."
  else
    DKIM=$(printf '%s' "$IDENTITY_JSON" | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try {
          const i = JSON.parse(s);
          const dkim = (i.DkimAttributes || {}).Status || "UNKNOWN";
          process.stdout.write(`${dkim} ${i.VerifiedForSendingStatus === true ? "yes" : "no"}`);
        } catch { process.stdout.write("UNKNOWN no"); }
      });
    ')
    DKIM_STATUS="${DKIM%% *}"
    VERIFIED="${DKIM##* }"
    case "$DKIM_STATUS" in
      SUCCESS) log_success "DKIM for $DOMAIN: SUCCESS." ;;
      PENDING) note_blocker "DKIM for $DOMAIN: PENDING — SES has not read the CNAMEs yet. It gives up after 72h." ;;
      FAILED)  note_blocker "DKIM for $DOMAIN: FAILED — the records were never found. Re-run setup-aws.sh." ;;
      *)       note_blocker "DKIM for $DOMAIN: $DKIM_STATUS." ;;
    esac
    if [ "$VERIFIED" = "yes" ]; then
      log_success "Identity verified for sending."
    else
      note_blocker "Identity '$DOMAIN' is not verified for sending."
    fi
  fi
fi

# A named blocker outranks an unrecognised state: it is the more specific and
# more useful answer. Only when nothing is known to be broken, and something is
# not understood, does the verdict fall back to "could not tell".
echo ""
if [ "$READY" -ne 0 ]; then
  log_error "NOT READY — the reasons above block customer email. Do not go live."
  exit 1
fi
if [ "$UNKNOWN" -ne 0 ]; then
  log_error "COULD NOT TELL — a check above returned a state this script does not"
  echo "         recognise, so readiness cannot be confirmed. Do not treat as ready."
  exit 2
fi
log_success "READY — this account can email real customers."
exit 0
