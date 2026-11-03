#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# BeYours Engine - AWS S3 & SES Setup Script
#
# Configures:
#   1. A PRIVATE S3 bucket, with PUT-only CORS, version-expiring lifecycle rules
#      and folders
#   2. SES domain identity with DKIM verification
#   3. SES email sending configuration
#   4. SES bounce and complaint feedback: an SNS topic, the identity
#      notifications that publish to it WITH the original headers, and a
#      subscription pointing at the deployment's /webhooks/ses
#   5. IAM user with minimal permissions for the app
#
# The bucket is private and nothing here makes it public. Media reaches the
# browser through the app's /api/files proxy, or through a CDN with an origin
# access control - see apps/docs/deployment/s3-bucket-policy.md. An earlier
# version of this script relaxed the public access block and attached a
# public-read policy; it now removes such a policy if it finds one (issue #198).
#
# Usage:
#   chmod +x scripts/setup-aws.sh
#   ./scripts/setup-aws.sh
#   SITE_ORIGIN=https://restaurant.example ./scripts/setup-aws.sh
#
# Prerequisites:
#   - AWS CLI configured (aws configure)
#   - Sufficient IAM permissions (S3, SES, IAM, Route53 optional)
#   - node on PATH, to classify an existing bucket policy. Without it the
#     script still blocks all public access; it just leaves any existing
#     policy in place and tells you to check it.
# ============================================================================

# ── Configuration ────────────────────────────────────────────────────────────
#
# ⚠️ THE `beindigital-*` NAMES BELOW ARE AWS RESOURCES, NOT BRANDING.
#
# They designate infrastructure that already exists in the account: an S3
# bucket (globally unique name), an IAM user, an IAM policy and an SES
# configuration set. Renaming them here does not rename anything in AWS — it
# makes the script provision a second, parallel, empty set, and points new
# clients at a bucket that holds none of the existing media. Sending mail with
# a configuration set that does not exist fails outright.
#
# This happened on 2026-08-16: the BeYours rename swept `beindigital-engine`
# into `beyours-engine` across the repository and caught these five along the
# way. Renaming them requires renaming the AWS resources first — which, for an
# S3 bucket, means creating a new one and copying the objects over.

# ── Per-client mode ──
# One AWS account per client (apps/docs/deployment/aws-ownership.md). Give a
# site slug and the client's sending domain, and every resource is named for
# that client inside whatever account the AWS CLI is pointed at:
#
#   SITE_SLUG=chez-mario DOMAIN=chez-mario.fr ./scripts/setup-aws.sh
#
# With no SITE_SLUG the script keeps the fleet-wide names above, unchanged,
# because they designate resources that already exist in the shared account.
# That is the legacy model; new clients should not be provisioned into it.

SITE_SLUG="${SITE_SLUG:-}"
REGION="${AWS_REGION:-eu-west-3}"
ENV_FILE="${ENV_FILE:-.env.local}"

if [ -n "$SITE_SLUG" ]; then
  if ! printf '%s' "$SITE_SLUG" | grep -qE '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'; then
    echo "SITE_SLUG must be lowercase letters, digits and hyphens (3-50 chars)." >&2
    exit 1
  fi
  if [ -z "${DOMAIN:-}" ]; then
    echo "DOMAIN is required with SITE_SLUG - the client's sending domain." >&2
    exit 1
  fi
  BUCKET_NAME="${BUCKET_NAME:-beyours-${SITE_SLUG}-assets}"
  IAM_USER="${IAM_USER:-beyours-${SITE_SLUG}-app}"
  SES_CONFIG_SET="${SES_CONFIG_SET:-beyours-${SITE_SLUG}}"
  POLICY_NAME="${POLICY_NAME:-BeYours-${SITE_SLUG}-policy}"
else
  DOMAIN="${DOMAIN:-beindigital.fr}"
  BUCKET_NAME="beindigital-engine-assets"
  IAM_USER="beindigital-engine-app"
  SES_CONFIG_SET="beindigital-engine"
  POLICY_NAME="BeInDigitalEnginePolicy"
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info()    { echo -e "${BLUE}[INFO]${NC}  $1"; }
log_success() { echo -e "${GREEN}[OK]${NC}    $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
log_error()   { echo -e "${RED}[ERR]${NC}   $1"; }
log_section() { echo -e "\n${BLUE}══════════════════════════════════════════════════${NC}"; echo -e "${BLUE}  $1${NC}"; echo -e "${BLUE}══════════════════════════════════════════════════${NC}\n"; }

# ── Preflight checks ────────────────────────────────────────────────────────

log_section "Preflight Checks"

# Say the legacy default out loud. The header comment above has always
# described it, and a comment is read by whoever edits the script rather than
# by whoever runs it: an operator who omits SITE_SLUG gets the fleet-wide IAM
# user and the shared bucket with no signal at all, which is how existing
# deployments came to hold credentials to other clients' data (#199,
# apps/docs/deployment/aws-ownership.md). It is still allowed — those resources
# exist and a legacy site has to be able to re-run this — so it warns rather
# than refusing.
if [ -z "$SITE_SLUG" ]; then
  log_warn "No SITE_SLUG: provisioning into the SHARED fleet account."
  log_warn "  bucket   $BUCKET_NAME"
  log_warn "  IAM user $IAM_USER"
  log_warn "  These are the fleet-wide resources every legacy site already uses,"
  log_warn "  so the credentials this writes can read every other client's media."
  log_warn "  A new client wants its own: SITE_SLUG=<slug> DOMAIN=<domain> $0"
fi

if ! command -v aws &>/dev/null; then
  log_error "AWS CLI not found. Install with: brew install awscli"
  exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null)
if [ -z "$ACCOUNT_ID" ]; then
  log_error "AWS CLI not authenticated. Run: aws configure"
  exit 1
fi

log_success "AWS CLI authenticated - Account: $ACCOUNT_ID"

# Provisioning into the wrong account is the failure mode that per-client
# ownership creates: the CLI silently uses whatever profile is default. Pin it
# with EXPECTED_ACCOUNT_ID=123456789012 to turn that into a refusal.
if [ -n "${EXPECTED_ACCOUNT_ID:-}" ] && [ "$EXPECTED_ACCOUNT_ID" != "$ACCOUNT_ID" ]; then
  log_error "Wrong AWS account: expected $EXPECTED_ACCOUNT_ID, got $ACCOUNT_ID."
  log_error "Check your AWS profile (AWS_PROFILE) before re-running."
  exit 1
fi

if [ -n "$SITE_SLUG" ]; then
  log_info "Mode: per-client - site '$SITE_SLUG'"
else
  log_warn "Mode: legacy fleet-wide (no SITE_SLUG) - shared bucket and IAM user."
  log_warn "New clients get their own account: apps/docs/deployment/aws-ownership.md"
fi
log_info "Region: $REGION"
log_info "Domain: $DOMAIN"
log_info "Bucket: $BUCKET_NAME"
log_info "IAM User: $IAM_USER"

# ════════════════════════════════════════════════════════════════════════════
# STEP 1: S3 BUCKET
# ════════════════════════════════════════════════════════════════════════════

log_section "Step 1: S3 Bucket Setup"

# Create bucket
if aws s3api head-bucket --bucket "$BUCKET_NAME" --region "$REGION" 2>/dev/null; then
  log_warn "Bucket '$BUCKET_NAME' already exists, skipping creation"
else
  log_info "Creating bucket '$BUCKET_NAME' in $REGION..."
  aws s3api create-bucket \
    --bucket "$BUCKET_NAME" \
    --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION" \
    --output text > /dev/null
  log_success "Bucket created"
fi

# ── The bucket is PRIVATE ────────────────────────────────────────────────────
# No object is readable without credentials. Media reaches the browser through
# the app's own /api/files proxy, or through a CDN with an origin access
# control. See apps/docs/deployment/s3-bucket-policy.md.
#
# This script used to do the opposite: it relaxed the public access block and
# attached a "PublicReadAssets" policy granting s3:GetObject to "*". Running it
# re-opened the bucket that #185/#187 had closed, so it now also REMEDIATES a
# bucket an earlier run may already have opened.

log_info "Checking for a pre-existing public bucket policy..."
EXISTING_POLICY=$(aws s3api get-bucket-policy --bucket "$BUCKET_NAME" \
  --query Policy --output text 2>/dev/null || true)

# Classifying this needs a real JSON parse, not a grep: a hardening policy that
# DENIES non-TLS access also carries "Principal": "*", and deleting it would
# remove a control rather than an exposure. Only Effect=Allow to * is public.
# Node is already a prerequisite of this repo; if it is missing we say so and
# leave the policy alone - the public access block set below is the actual
# control, and it closes the exposure either way.
classify_bucket_policy() {
  if ! command -v node >/dev/null 2>&1; then
    echo "unknown"
    return
  fi
  printf '%s' "$1" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const stmts = [].concat(JSON.parse(s).Statement || []);
        const isStar = (pr) =>
          pr === "*" ||
          (pr && typeof pr === "object" && [].concat(pr.AWS || []).includes("*"));
        const open = stmts.some((st) => st.Effect === "Allow" && isStar(st.Principal));
        process.stdout.write(open ? "yes" : "no");
      } catch {
        process.stdout.write("unknown");
      }
    });
  ' 2>/dev/null || echo "unknown"
}

if [ -n "$EXISTING_POLICY" ] && [ "$EXISTING_POLICY" != "None" ]; then
  case "$(classify_bucket_policy "$EXISTING_POLICY")" in
    yes)
      log_warn "Bucket policy grants read to \"*\" - removing it (issue #198)."
      aws s3api delete-bucket-policy --bucket "$BUCKET_NAME"
      log_success "Public bucket policy removed"
      ;;
    no)
      log_success "A bucket policy exists and grants nothing to \"*\" - left untouched."
      ;;
    *)
      log_warn "Could not parse the existing bucket policy - left untouched."
      log_warn "Check it by hand: aws s3api get-bucket-policy --bucket $BUCKET_NAME"
      ;;
  esac
else
  log_success "No bucket policy attached - this is the expected state"
fi

log_info "Blocking all public access..."
aws s3api put-public-access-block \
  --bucket "$BUCKET_NAME" \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
log_success "All public access blocked"

# Enable versioning
log_info "Enabling versioning..."
aws s3api put-bucket-versioning \
  --bucket "$BUCKET_NAME" \
  --versioning-configuration Status=Enabled
log_success "Versioning enabled"

# Server-side encryption (AES256)
log_info "Enabling server-side encryption..."
aws s3api put-bucket-encryption \
  --bucket "$BUCKET_NAME" \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      },
      "BucketKeyEnabled": true
    }]
  }'
log_success "Encryption enabled (AES256)"

# CORS is only needed for the presigned-PUT upload path (the CMS media library),
# and only for PUT: reads go through the app's own origin via /api/files, which
# is not a cross-origin request. See apps/docs/deployment/s3-bucket-policy.md.
#
# A client served from its own domain needs that domain here, or its media
# library cannot upload. Override it:
#   SITE_ORIGIN=https://restaurant.example ./scripts/setup-aws.sh
SITE_ORIGIN="${SITE_ORIGIN:-https://*.beindigital.fr}"
log_info "Setting CORS policy (PUT only, origin: $SITE_ORIGIN)..."
aws s3api put-bucket-cors \
  --bucket "$BUCKET_NAME" \
  --cors-configuration "{
    \"CORSRules\": [{
      \"AllowedHeaders\": [\"content-type\"],
      \"AllowedMethods\": [\"PUT\"],
      \"AllowedOrigins\": [\"http://localhost:3000\", \"$SITE_ORIGIN\"],
      \"MaxAgeSeconds\": 3000
    }]
  }"
log_success "CORS configured (PUT only)"

# No bucket policy is attached, deliberately. The IAM user created in step 4
# carries s3:GetObject / s3:PutObject / s3:DeleteObject on this bucket, plus the
# three VERSION permissions the bucket's versioning makes necessary
# (s3:ListBucketVersions, s3:GetObjectVersion, s3:DeleteObjectVersion) — without
# them the app can only write delete markers, which delete nothing. That is all
# the app needs. Adding a policy that grants s3:GetObject to "*" would make
# every uploaded file world-readable and permanently un-revocable - including a
# file uploaded by a hostile account. That is what #185/#187 closed.
#
# A CDN is the supported way to serve media without the proxy: give CloudFront
# an origin access control and let it write its own bucket policy, then set
# AWS_S3_PUBLIC_BASE_URL. The bucket stays closed to the public internet.

# ── Lifecycle rules ─────────────────────────────────────────────────────────
#
# The only rule here used to be CleanupIncompleteUploads, and that made the
# versioning enabled above a one-way ratchet: nothing ever left the bucket.
#
# On a VERSIONED bucket a DeleteObject without a VersionId deletes nothing. It
# writes a *delete marker* over the key and retains every prior version — still
# billed, still readable by anyone who can name a version id. So « definitivement
# supprime » in the media library kept every byte, the offboarding runbook ticked
# an erasure box the infrastructure could not honour, and storage grew without
# ceiling. Issue #331.
#
# The app now purges versions itself: convex/cmsMediaDelete.ts, which is the
# only media-deletion path the delivered app runs — and that is true because it
# is enforced rather than observed. convex/cmsMediaConfirmUpload.ts deletes
# too, when it reads an uploaded SVG back and refuses it for active content,
# and it shipped its own bare DeleteObjectCommand: a marker over the key, every
# version retained, for the one object on that path we have decided is hostile.
# It now calls purgeS3Objects like everything else, and
# tests/convex/cms-media-upload.test.ts asserts the version ids go with it.
# (packages/core's
# S3Service.delete does the same for a consumer of that package, and only when
# the injected S3Operations adapter implements listObjectVersions and
# deleteObjectVersion — they are optional on the interface. Nothing in apps/*
# calls it.) These two rules are the floor under all of that: they collect what
# a purge could not reach — objects deleted before the purge existed,
# deployments whose IAM policy predates s3:DeleteObjectVersion, adapters without
# the version methods, and the noncurrent versions of a file that was merely
# overwritten rather than deleted.
#
# NoncurrentVersionExpiration is 30 days rather than 1. Versioning is also an
# accident-recovery control: a client who overwrites the wrong photograph has a
# month to say so. An erasure REQUEST is not served by waiting — the app purges
# by version id for that, and NewerNoncurrentVersions keeps the window from
# meaning "keep 400 revisions of a logo for a month".
#
# Both rules are needed and neither substitutes for the other:
#   - expiring the versions leaves the delete marker, which keeps the key
#     listed as deleted and still costs a request to enumerate;
#   - expiring the marker alone UN-DELETES the file, because the newest
#     remaining version becomes current again.
#
# The fourth rule is the retention of the NIGHTLY BACKUP that convex/crons.ts
# now writes under backups/ (issue #366). Thirty daily copies, expired by the
# bucket rather than by a cron: a lifecycle rule keeps working while the
# deployment is down, which is the circumstance a backup exists for. Its
# noncurrent window is 1 day rather than 30 - each night writes a NEW key, so a
# noncurrent version of a backup only exists if one was overwritten, and keeping
# those for a month would silently triple what the retention says.
#
# `backups/` is deliberately NOT one of the eleven S3_FOLDERS. That constant
# drives the /api/files proxy's allow-list, and a backup reachable over HTTP is
# the whole database served to whoever guesses a key.
log_info "Setting lifecycle rules..."
aws s3api put-bucket-lifecycle-configuration \
  --bucket "$BUCKET_NAME" \
  --lifecycle-configuration '{
    "Rules": [
      {
        "ID": "CleanupIncompleteUploads",
        "Status": "Enabled",
        "Filter": {"Prefix": ""},
        "AbortIncompleteMultipartUpload": {
          "DaysAfterInitiation": 7
        }
      },
      {
        "ID": "ExpireNoncurrentVersions",
        "Status": "Enabled",
        "Filter": {"Prefix": ""},
        "NoncurrentVersionExpiration": {
          "NoncurrentDays": 30,
          "NewerNoncurrentVersions": 3
        }
      },
      {
        "ID": "ExpireDeleteMarkers",
        "Status": "Enabled",
        "Filter": {"Prefix": ""},
        "Expiration": {
          "ExpiredObjectDeleteMarker": true
        }
      },
      {
        "ID": "ExpireNightlyBackups",
        "Status": "Enabled",
        "Filter": {"Prefix": "backups/"},
        "Expiration": {
          "Days": 30
        },
        "NoncurrentVersionExpiration": {
          "NoncurrentDays": 1
        }
      }
    ]
  }'
log_success "Lifecycle rules set (incomplete uploads, noncurrent versions, delete markers, nightly backups)"

# Create folder structure
log_info "Creating folder structure..."
for folder in products branding stores cms blog; do
  aws s3api put-object --bucket "$BUCKET_NAME" --key "${folder}/" --content-length 0 > /dev/null
done
log_success "Folders created: products/, branding/, stores/, cms/, blog/"

# ════════════════════════════════════════════════════════════════════════════
# STEP 2: SES DOMAIN IDENTITY & DKIM
# ════════════════════════════════════════════════════════════════════════════

log_section "Step 2: SES Domain Identity & DKIM"

# Verify domain identity
log_info "Registering domain identity '$DOMAIN'..."
DKIM_TOKENS=$(aws sesv2 create-email-identity \
  --email-identity "$DOMAIN" \
  --region "$REGION" \
  --query 'DkimAttributes.Tokens' \
  --output text 2>/dev/null || echo "ALREADY_EXISTS")

if [ "$DKIM_TOKENS" = "ALREADY_EXISTS" ]; then
  log_warn "Domain '$DOMAIN' already registered in SES"
  DKIM_TOKENS=$(aws sesv2 get-email-identity \
    --email-identity "$DOMAIN" \
    --region "$REGION" \
    --query 'DkimAttributes.Tokens' \
    --output text)
fi

log_success "Domain identity registered"

# Display DNS records to configure
echo ""
log_info "=== DNS RECORDS TO ADD ==="
echo ""
echo -e "${YELLOW}Add the following CNAME records to your DNS provider for $DOMAIN:${NC}"
echo ""

TOKEN_NUM=1
for TOKEN in $DKIM_TOKENS; do
  echo -e "  ${GREEN}CNAME Record $TOKEN_NUM:${NC}"
  echo -e "    Name:  ${TOKEN}._domainkey.${DOMAIN}"
  echo -e "    Value: ${TOKEN}.dkim.amazonses.com"
  echo ""
  TOKEN_NUM=$((TOKEN_NUM + 1))
done

# SES MAIL FROM domain (for SPF)
MAIL_FROM_SUBDOMAIN="mail.${DOMAIN}"
log_info "Setting MAIL FROM domain: $MAIL_FROM_SUBDOMAIN"
aws sesv2 put-email-identity-mail-from-attributes \
  --email-identity "$DOMAIN" \
  --mail-from-domain "$MAIL_FROM_SUBDOMAIN" \
  --region "$REGION" 2>/dev/null || true
log_success "MAIL FROM configured"

echo ""
echo -e "${YELLOW}Also add these DNS records for SPF & MAIL FROM:${NC}"
echo ""
echo -e "  ${GREEN}MX Record:${NC}"
echo -e "    Name:  mail.${DOMAIN}"
echo -e "    Value: 10 feedback-smtp.${REGION}.amazonses.com"
echo ""
echo -e "  ${GREEN}TXT Record (SPF):${NC}"
echo -e "    Name:  mail.${DOMAIN}"
echo -e "    Value: \"v=spf1 include:amazonses.com ~all\""
echo ""

# Create DMARC record suggestion
echo -e "  ${GREEN}TXT Record (DMARC - recommended):${NC}"
echo -e "    Name:  _dmarc.${DOMAIN}"
echo -e "    Value: \"v=DMARC1; p=quarantine; rua=mailto:dmarc@${DOMAIN}\""
echo ""

# Set up notification email address
FROM_EMAIL="noreply@${DOMAIN}"
log_info "Registering sender email: $FROM_EMAIL"
aws sesv2 create-email-identity \
  --email-identity "$FROM_EMAIL" \
  --region "$REGION" 2>/dev/null || log_warn "$FROM_EMAIL already registered"
log_success "Sender email identity registered"

# Create a configuration set for tracking
log_info "Creating SES configuration set..."
aws sesv2 create-configuration-set \
  --configuration-set-name "$SES_CONFIG_SET" \
  --sending-options '{"SendingEnabled": true}' \
  --reputation-options '{"ReputationMetricsEnabled": true}' \
  --region "$REGION" 2>/dev/null || log_warn "Configuration set already exists"
log_success "Configuration set '$SES_CONFIG_SET' ready"

# ════════════════════════════════════════════════════════════════════════════
# STEP 2b: BOUNCE AND COMPLAINT FEEDBACK
# ════════════════════════════════════════════════════════════════════════════
#
# WHAT WAS MISSING. The configuration set above was created with no destination
# of any kind, and no SNS topic existed anywhere in this script. `POST
# /webhooks/ses` is routed in `convex/http.ts` and nothing ever caused AWS to
# call it, so `emailSubscribers.markBounced` and `markComplained` had no way to
# fire. A dead mailbox therefore stayed `active` and was re-mailed on every
# campaign, and AWS suspends a sending account at a 5 % complaint rate — with
# nothing in the product able to explain why the mail stopped.
#
# WHY IDENTITY NOTIFICATION TOPICS AND NOT AN EVENT DESTINATION. The two
# publish DIFFERENT JSON. A configuration set event destination sends the
# event-publishing envelope, keyed `eventType`; an identity notification topic
# sends the classic notification envelope, keyed `notificationType`, with
# `bounce.bounceType` and `mail.destination` beside it. `handleSesWebhook`
# switches on `notificationType` (`convex/emailHttpHandlers.ts`), so an event
# destination would deliver a body that parses, matches no case, and is dropped
# — which looks exactly like the silence it was meant to end.
#
# WHY THE HEADERS FLAG IS NOT OPTIONAL. The handler correlates a bounce to a
# subscriber through `X-Store-Id` / `X-Subscriber-Id` / `X-Campaign-Id`,
# injected at send time and readable only from `mail.headers` — and SES OMITS
# `mail.headers` from a notification unless the identity is told to include the
# original headers. Without the two commands below the endpoint receives every
# bounce and can act on none of them.
#
# Feedback forwarding is deliberately left alone: setting a topic does not turn
# the operator's own bounce emails off, and having both while a client is new is
# worth more than a tidy inbox.

log_section "Step 2b: Bounce & Complaint Feedback"

SNS_TOPIC_NAME="${SNS_TOPIC_NAME:-${SES_CONFIG_SET}-feedback}"

# Where SES notifications are delivered. `CONVEX_SITE_URL` names the Convex
# deployment's HTTP router — the `.convex.site` host, not the `.convex.cloud`
# one — and `/webhooks/ses` is the route `http.ts` registers.
SES_WEBHOOK_URL="${SES_WEBHOOK_URL:-}"
if [ -z "$SES_WEBHOOK_URL" ] && [ -n "${CONVEX_SITE_URL:-}" ]; then
  SES_WEBHOOK_URL="${CONVEX_SITE_URL%/}/webhooks/ses"
fi
# Falling back to the env file, because this script is usually run before
# anything exports the Convex variables into the shell. `|| true` throughout:
# `set -e` is on and a grep that matches nothing exits 1.
if [ -z "$SES_WEBHOOK_URL" ] && [ -f "$ENV_FILE" ]; then
  ENV_SITE_URL=$(grep -E '^CONVEX_SITE_URL=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'\''' | tr -d '\r' || true)
  if [ -n "${ENV_SITE_URL:-}" ]; then
    SES_WEBHOOK_URL="${ENV_SITE_URL%/}/webhooks/ses"
  fi
fi

log_info "Creating SNS topic '$SNS_TOPIC_NAME'..."
# `create-topic` is idempotent: an existing topic of the same name is returned
# rather than duplicated.
SNS_TOPIC_ARN=$(aws sns create-topic \
  --name "$SNS_TOPIC_NAME" \
  --region "$REGION" \
  --query TopicArn --output text)
log_success "SNS topic ready: $SNS_TOPIC_ARN"

# SES has to be allowed to publish, and a topic's default policy allows only
# its owner. Scoped to this account so another account's SES cannot publish
# into a client's feedback topic.
SNS_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowSESPublish",
      "Effect": "Allow",
      "Principal": { "Service": "ses.amazonaws.com" },
      "Action": "sns:Publish",
      "Resource": "${SNS_TOPIC_ARN}",
      "Condition": {
        "StringEquals": { "AWS:SourceAccount": "${ACCOUNT_ID}" }
      }
    }
  ]
}
EOF
)
aws sns set-topic-attributes \
  --topic-arn "$SNS_TOPIC_ARN" \
  --attribute-name Policy \
  --attribute-value "$SNS_POLICY" \
  --region "$REGION"
log_success "SNS topic policy allows SES to publish"

# Bounce and Complaint are the two that decide whether the account keeps
# sending. Delivery is wired too because `handleSesWebhook` records it as a
# campaign statistic, and a « delivered » count that is always zero reads as a
# broken campaign rather than a missing subscription.
for NOTIFICATION_TYPE in Bounce Complaint Delivery; do
  aws ses set-identity-notification-topic \
    --identity "$DOMAIN" \
    --notification-type "$NOTIFICATION_TYPE" \
    --sns-topic "$SNS_TOPIC_ARN" \
    --region "$REGION"

  # The half without which the endpoint receives every bounce and can act on
  # none: no headers, no `X-Subscriber-Id`, nothing to mark.
  aws ses set-identity-headers-in-notifications-enabled \
    --identity "$DOMAIN" \
    --notification-type "$NOTIFICATION_TYPE" \
    --enabled \
    --region "$REGION"
done
log_success "Bounce, Complaint and Delivery notifications publish to the topic, with original headers"

# ── Tell the deployment which topic it is expected to trust ──────────────────
#
# BEFORE subscribing, and that order is the whole point of this block.
#
# `sesWebhookVerify` refuses to confirm a subscription whose topic is not named
# in `SES_SNS_TOPIC_ARN` (`mayConfirmSubscription` returns false on an empty
# list, deliberately: confirming is what turns "a stranger pointed their topic
# at us" into "a stranger can publish to us"). Nothing set that variable —
# not this script, not `env:sync`, not `setup-convex-env.sh` — so a client
# provisioned exactly as instructed got:
#
#   `aws sns subscribe` → SNS POSTs a SubscriptionConfirmation → the deployment
#   refuses it → the subscription stays PendingConfirmation → SNS gives up →
#   no bounce or complaint ever arrives.
#
# Which is #428's original silence moved one step down the chain, and the
# script's own success line told the operator the opposite ("the deployment
# confirms it on the first POST"). The documentation had it right and the
# script is what an operator follows.
#
# Written to the Convex env file — the verifier reads it from the CONVEX
# deployment, not from Next.js — and pushed straight onto the deployment when
# the CLI can reach one, so a re-run of this script is not needed.
CONVEX_ENV_FILE="${CONVEX_ENV_FILE:-.env.convex}"

if grep -qE '^SES_SNS_TOPIC_ARN=' "$CONVEX_ENV_FILE" 2>/dev/null; then
  # Rewrite in place rather than appending a second line: `setup-convex-env.sh`
  # takes the LAST occurrence, so an append would work by luck and read as a
  # duplicate to anyone opening the file.
  tmp_env=$(mktemp)
  grep -vE '^SES_SNS_TOPIC_ARN=' "$CONVEX_ENV_FILE" > "$tmp_env" || true
  printf 'SES_SNS_TOPIC_ARN=%s
' "$SNS_TOPIC_ARN" >> "$tmp_env"
  mv "$tmp_env" "$CONVEX_ENV_FILE"
  log_success "SES_SNS_TOPIC_ARN updated in $CONVEX_ENV_FILE"
else
  printf 'SES_SNS_TOPIC_ARN=%s
' "$SNS_TOPIC_ARN" >> "$CONVEX_ENV_FILE"
  log_success "SES_SNS_TOPIC_ARN written to $CONVEX_ENV_FILE"
fi

# Push it now if a deployment is reachable. `|| true` because this script is
# routinely run before `convex dev` has ever created one, and a missing
# deployment must not fail the AWS provisioning that already succeeded — the
# file above is the durable record either way.
if command -v pnpx >/dev/null 2>&1 && [ -n "${CONVEX_DEPLOYMENT:-}" ]; then
  if pnpx convex env set SES_SNS_TOPIC_ARN "$SNS_TOPIC_ARN" >/dev/null 2>&1; then
    log_success "SES_SNS_TOPIC_ARN set on the Convex deployment"
  else
    log_warn "Could not reach the Convex deployment to set SES_SNS_TOPIC_ARN."
    log_warn "Run this before the subscription is confirmed:"
    log_warn "  pnpx convex env set SES_SNS_TOPIC_ARN $SNS_TOPIC_ARN"
  fi
else
  log_warn "No Convex deployment in this shell, so SES_SNS_TOPIC_ARN is only in $CONVEX_ENV_FILE."
  log_warn "Push it before the subscription below can be confirmed:"
  log_warn "  pnpm env:sync   # or: pnpx convex env set SES_SNS_TOPIC_ARN $SNS_TOPIC_ARN"
fi

if [ -n "$SES_WEBHOOK_URL" ]; then
  # Only subscribe once. Re-subscribing the same endpoint leaves a second
  # PendingConfirmation subscription behind for ever, and every notification is
  # then delivered twice to the one that did confirm.
  EXISTING_SUB=$(aws sns list-subscriptions-by-topic \
    --topic-arn "$SNS_TOPIC_ARN" \
    --region "$REGION" \
    --query "Subscriptions[?Endpoint=='${SES_WEBHOOK_URL}'] | [0].SubscriptionArn" \
    --output text 2>/dev/null || echo "None")

  if [ "$EXISTING_SUB" = "None" ] || [ -z "$EXISTING_SUB" ]; then
    log_info "Subscribing $SES_WEBHOOK_URL..."
    aws sns subscribe \
      --topic-arn "$SNS_TOPIC_ARN" \
      --protocol https \
      --notification-endpoint "$SES_WEBHOOK_URL" \
      --region "$REGION" > /dev/null
    # SNS POSTs a SubscriptionConfirmation immediately; `handleSesWebhook`
    # verifies Amazon's signature and then fetches the SubscribeURL itself, so
    # a deployed backend confirms without anyone doing anything. A backend that
    # is not up yet leaves the subscription PendingConfirmation, and SNS does
    # not retry indefinitely — re-run this script once it is.
    # Conditional on the variable actually having reached the deployment. The
    # unconditional version of this line was false whenever it had not, which
    # is the case it most needed to warn about.
    log_success "Subscription requested"
    log_info "The deployment confirms it on the first POST — provided SES_SNS_TOPIC_ARN"
    log_info "is set there. If the warning above says it is not, set it and re-run:"
    log_info "  aws sns subscribe --topic-arn $SNS_TOPIC_ARN --protocol https \\"
    log_info "    --region $REGION --notification-endpoint $SES_WEBHOOK_URL"
  else
    log_success "Already subscribed: $SES_WEBHOOK_URL"
  fi

  # WITHOUT THIS THE SUBSCRIPTION CAN NEVER CONFIRM.
  #
  # `handleSesWebhook` verifies Amazon's signature, which proves Amazon sent
  # the message and NOT that our topic did — so it refuses any notification
  # whose TopicArn is not named by `SES_SNS_TOPIC_ARN`. That includes the
  # SubscriptionConfirmation SNS posts seconds after the `subscribe` above.
  # The script created the topic, subscribed the endpoint, and never told the
  # backend which topic to accept, so the confirmation was refused, SNS gave
  # up retrying, and the subscription sat PendingConfirmation for ever. Every
  # bounce and complaint published to the topic and reached nobody.
  #
  # It goes on the CONVEX deployment, not in `.env.local`: the verifier runs
  # there. It is written to $ENV_FILE too, further down, so `pnpm env:sync`
  # and `setup-convex-env.sh` carry it on any later run.
  if command -v pnpx >/dev/null 2>&1 || command -v npx >/dev/null 2>&1; then
    CONVEX_RUNNER=$(command -v pnpx || command -v npx)
    log_info "Naming the topic on the Convex deployment (SES_SNS_TOPIC_ARN)..."
    if "$CONVEX_RUNNER" convex env set SES_SNS_TOPIC_ARN "$SNS_TOPIC_ARN" >/dev/null 2>&1; then
      log_success "SES_SNS_TOPIC_ARN set — the deployment will accept the confirmation"
    else
      log_warn "Could not set SES_SNS_TOPIC_ARN on the Convex deployment."
      log_warn "Until it is set, /webhooks/ses refuses EVERY notification from"
      log_warn "this topic, the subscription stays PendingConfirmation, and"
      log_warn "bounces reach nobody. Run this from the app directory:"
      log_warn "  npx convex env set SES_SNS_TOPIC_ARN $SNS_TOPIC_ARN"
    fi
  else
    log_warn "No npx/pnpx on PATH, so SES_SNS_TOPIC_ARN was not set on Convex."
    log_warn "  npx convex env set SES_SNS_TOPIC_ARN $SNS_TOPIC_ARN"
  fi
else
  log_warn "CONVEX_SITE_URL is unknown, so nothing is subscribed to the topic."
  log_warn "Bounces and complaints will publish to SNS and reach nobody."
  log_warn "Once the Convex deployment exists, re-run this script, or:"
  log_warn "  aws sns subscribe --topic-arn $SNS_TOPIC_ARN \\"
  log_warn "    --protocol https --region $REGION \\"
  log_warn "    --notification-endpoint https://<deployment>.convex.site/webhooks/ses"
fi

# ════════════════════════════════════════════════════════════════════════════
# STEP 3: IAM USER FOR THE APP
# ════════════════════════════════════════════════════════════════════════════

log_section "Step 3: IAM User & Permissions"

# Create IAM user
if aws iam get-user --user-name "$IAM_USER" &>/dev/null; then
  log_warn "IAM user '$IAM_USER' already exists"
else
  log_info "Creating IAM user '$IAM_USER'..."
  aws iam create-user --user-name "$IAM_USER" > /dev/null
  log_success "IAM user created"
fi

# Create policy with minimal permissions
POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}"

POLICY_DOC=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "S3BucketAccess",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:ListBucketVersions",
        "s3:GetObjectVersion",
        "s3:DeleteObjectVersion"
      ],
      "Resource": [
        "arn:aws:s3:::${BUCKET_NAME}",
        "arn:aws:s3:::${BUCKET_NAME}/*"
      ]
    },
    {
      "Sid": "SESSendEmail",
      "Effect": "Allow",
      "Action": [
        "ses:SendEmail",
        "ses:SendRawEmail",
        "ses:SendTemplatedEmail",
        "ses:SendBulkTemplatedEmail"
      ],
      "Resource": [
        "arn:aws:ses:${REGION}:${ACCOUNT_ID}:identity/${DOMAIN}",
        "arn:aws:ses:${REGION}:${ACCOUNT_ID}:identity/${FROM_EMAIL}",
        "arn:aws:ses:${REGION}:${ACCOUNT_ID}:configuration-set/${SES_CONFIG_SET}"
      ]
    },
    {
      "Sid": "SESTemplates",
      "Effect": "Allow",
      "Action": [
        "ses:CreateTemplate",
        "ses:UpdateTemplate",
        "ses:GetTemplate",
        "ses:ListTemplates",
        "ses:DeleteTemplate"
      ],
      "Resource": "*"
    }
  ]
}
EOF
)

# Create or update the policy
if aws iam get-policy --policy-arn "$POLICY_ARN" &>/dev/null; then
  log_warn "Policy '$POLICY_NAME' already exists, creating new version..."
  # Delete oldest non-default version if at limit
  OLD_VERSION=$(aws iam list-policy-versions --policy-arn "$POLICY_ARN" \
    --query 'Versions[?IsDefaultVersion==`false`] | [0].VersionId' --output text 2>/dev/null)
  if [ "$OLD_VERSION" != "None" ] && [ -n "$OLD_VERSION" ]; then
    aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id "$OLD_VERSION" 2>/dev/null || true
  fi
  aws iam create-policy-version \
    --policy-arn "$POLICY_ARN" \
    --policy-document "$POLICY_DOC" \
    --set-as-default > /dev/null
  log_success "Policy updated"
else
  log_info "Creating IAM policy '$POLICY_NAME'..."
  aws iam create-policy \
    --policy-name "$POLICY_NAME" \
    --policy-document "$POLICY_DOC" > /dev/null
  log_success "Policy created"
fi

# Attach policy to user
aws iam attach-user-policy \
  --user-name "$IAM_USER" \
  --policy-arn "$POLICY_ARN" 2>/dev/null
log_success "Policy attached to user"

# Create access keys
log_info "Generating access keys..."
EXISTING_KEYS=$(aws iam list-access-keys --user-name "$IAM_USER" \
  --query 'AccessKeyMetadata[].AccessKeyId' --output text)

if [ -n "$EXISTING_KEYS" ] && [ "$EXISTING_KEYS" != "None" ]; then
  log_warn "Access keys already exist for '$IAM_USER'"
  echo -e "  Existing keys: $EXISTING_KEYS"
  echo ""
  read -p "  Delete existing keys and create new ones? (y/N): " RECREATE_KEYS
  if [[ "$RECREATE_KEYS" =~ ^[Yy]$ ]]; then
    for KEY in $EXISTING_KEYS; do
      aws iam delete-access-key --user-name "$IAM_USER" --access-key-id "$KEY"
    done
    log_info "Old keys deleted"
  else
    log_warn "Keeping existing keys. Skipping key creation."
    NEW_ACCESS_KEY=""
    NEW_SECRET_KEY=""
  fi
fi

if [ -z "${NEW_ACCESS_KEY:-}" ]; then
  KEY_OUTPUT=$(aws iam create-access-key --user-name "$IAM_USER" --output json)
  NEW_ACCESS_KEY=$(echo "$KEY_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['AccessKey']['AccessKeyId'])")
  NEW_SECRET_KEY=$(echo "$KEY_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['AccessKey']['SecretAccessKey'])")
  log_success "New access keys generated"
fi

# ════════════════════════════════════════════════════════════════════════════
# STEP 4: UPDATE .env.local
# ════════════════════════════════════════════════════════════════════════════

log_section "Step 4: Update .env.local"

# Hoisted out of the branch below: the SES topic is written to the env file
# whether or not new credentials were minted, and BSD sed needs the empty
# backup suffix that GNU sed refuses. A `${SED_I:-sed -i}` fallback would have
# been wrong on macOS exactly when no key was generated.
if [[ "$OSTYPE" == "darwin"* ]]; then
  SED_I="sed -i ''"
else
  SED_I="sed -i"
fi

if [ -n "${NEW_ACCESS_KEY:-}" ]; then
  log_info "Updating $ENV_FILE with new credentials..."

  # Update AWS credentials
  $SED_I "s|^AWS_REGION=.*|AWS_REGION=$REGION|" "$ENV_FILE"
  $SED_I "s|^AWS_ACCESS_KEY_ID=.*|AWS_ACCESS_KEY_ID=$NEW_ACCESS_KEY|" "$ENV_FILE"
  $SED_I "s|^AWS_SECRET_ACCESS_KEY=.*|AWS_SECRET_ACCESS_KEY=$NEW_SECRET_KEY|" "$ENV_FILE"
  $SED_I "s|^AWS_S3_BUCKET_NAME=.*|AWS_S3_BUCKET_NAME=$BUCKET_NAME|" "$ENV_FILE"
  $SED_I "s|^AWS_SES_FROM_EMAIL=.*|AWS_SES_FROM_EMAIL=$FROM_EMAIL|" "$ENV_FILE"

  # Add SES config set if not present
  if ! grep -q "AWS_SES_CONFIGURATION_SET" "$ENV_FILE"; then
    echo "" >> "$ENV_FILE"
    echo "# SES Configuration" >> "$ENV_FILE"
    echo "AWS_SES_CONFIGURATION_SET=$SES_CONFIG_SET" >> "$ENV_FILE"
  fi

  log_success ".env.local updated"
else
  log_warn "No new keys generated, .env.local not updated"
  log_info "Manually update .env.local with your existing credentials"
fi

# The feedback topic, recorded whether or not new keys were minted: a re-run
# that generates no credentials still has a topic, and this is the value the
# SES webhook verifier checks a notification's TopicArn against.
if [ -n "${SNS_TOPIC_ARN:-}" ] && [ -f "$ENV_FILE" ]; then
  if grep -q '^SES_SNS_TOPIC_ARN=' "$ENV_FILE"; then
    $SED_I "s|^SES_SNS_TOPIC_ARN=.*|SES_SNS_TOPIC_ARN=$SNS_TOPIC_ARN|" "$ENV_FILE"
  else
    echo "" >> "$ENV_FILE"
    echo "# Which SNS topic /webhooks/ses accepts. Must also be set on the" >> "$ENV_FILE"
    echo "# Convex deployment — that is where the verifier runs." >> "$ENV_FILE"
    echo "SES_SNS_TOPIC_ARN=$SNS_TOPIC_ARN" >> "$ENV_FILE"
  fi
  log_success "SES_SNS_TOPIC_ARN recorded in $ENV_FILE"
fi

# ════════════════════════════════════════════════════════════════════════════
# SUMMARY
# ════════════════════════════════════════════════════════════════════════════

log_section "Setup Complete!"

echo -e "${GREEN}S3 Bucket:${NC}"
echo "  Name: $BUCKET_NAME"
echo "  Region: $REGION"
echo "  Folders: products/, branding/, stores/, cms/, blog/"
echo "  Encryption: AES256"
echo "  Versioning: Enabled"
echo "  Lifecycle: incomplete uploads 7d, noncurrent versions 30d (keep 3), delete markers expired, backups/ 30d"
echo ""

echo -e "${GREEN}SES:${NC}"
echo "  Domain: $DOMAIN"
echo "  From: $FROM_EMAIL"
echo "  Config Set: $SES_CONFIG_SET"
echo "  Region: $REGION"
echo "  Feedback topic: ${SNS_TOPIC_ARN:-none}"
echo "  Topic named to the backend: SES_SNS_TOPIC_ARN=${SNS_TOPIC_ARN:-unset}"
if [ -n "${SES_WEBHOOK_URL:-}" ]; then
  echo "  Bounces & complaints: $SES_WEBHOOK_URL"
else
  echo -e "  Bounces & complaints: ${YELLOW}not subscribed — see the warning above${NC}"
fi
echo ""

if [ -n "${NEW_ACCESS_KEY:-}" ]; then
  echo -e "${GREEN}IAM User:${NC}"
  echo "  User: $IAM_USER"
  echo "  Access Key: $NEW_ACCESS_KEY"
  echo -e "  Secret Key: ${YELLOW}(saved in .env.local)${NC}"
  echo ""
fi

echo -e "${YELLOW}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${YELLOW}║  ACTION REQUIRED: Add DNS records to your domain provider   ║${NC}"
echo -e "${YELLOW}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "After adding DNS records, verify with:"
echo "  aws sesv2 get-email-identity --email-identity $DOMAIN --region $REGION"
echo ""
echo "Check DKIM status (PENDING until SES reads the CNAMEs; SES gives up after 72h):"
echo "  aws sesv2 get-email-identity --email-identity $DOMAIN --region $REGION \\"
echo "    --query 'DkimAttributes.Status'"
echo ""

echo -e "${YELLOW}NOTE: a new account is in the SES sandbox — verified recipients only,${NC}"
echo -e "${YELLOW}      200 messages/24h. Real customers receive nothing until AWS grants${NC}"
echo -e "${YELLOW}      production access, and that is a review, not a switch.${NC}"
echo ""
echo "Request it:  https://console.aws.amazon.com/ses/home?region=$REGION#/account"
echo "Then ask where it stands, instead of guessing:"
echo "  DOMAIN=$DOMAIN ./scripts/check-ses-status.sh"
echo ""
echo "Full procedure: tasks/client-aws-onboarding-runbook.md"
echo ""
