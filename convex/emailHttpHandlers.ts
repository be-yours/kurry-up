import { httpAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { captureBackendError } from "./errorReporting";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { normalizeBounceType } from "@be-yours/convex-functions/emailSubscribers";


// ─── Helper: minimal HTML response page ─────────────────────────────────────

const ESC_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function esc(str: string): string {
  return str.replace(/[&<>"']/g, (ch) => ESC_MAP[ch] ?? ch);
}

/**
 * @param bodyExtra raw HTML appended after the message — callers pass only
 *   markup they built themselves, never anything taken from a request.
 */
function htmlPage(title: string, message: string, bodyExtra = ""): string {
  const safeTitle = esc(title);
  const safeMessage = esc(message);
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; color: #1a1a1a; }
    .card { background: #fff; border-radius: 12px; padding: 48px; max-width: 440px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    h1 { font-size: 22px; margin: 0 0 12px; }
    p { font-size: 15px; color: #666; margin: 0; line-height: 1.6; }
    button { margin-top: 24px; font: inherit; font-size: 15px; padding: 12px 28px; border: 0; border-radius: 8px; background: #1a1a1a; color: #fff; cursor: pointer; }
    button:hover { background: #333; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
    ${bodyExtra}
  </div>
</body>
</html>`;
}

// ─── GET /email/unsubscribe?id=<subscriberId> ───────────────────────────────

const HTML = { "Content-Type": "text/html; charset=utf-8" } as const;

const INVALID_LINK = htmlPage("Erreur", "Lien de désabonnement invalide.");

const UNSUBSCRIBED = htmlPage(
  "Désabonnement confirmé",
  "Vous ne recevrez plus d'emails de notre part. Cette action peut prendre quelques instants."
);

/**
 * GET only ASKS. It used to unsubscribe.
 *
 * A GET that mutates is fetched by things that are not the recipient: Outlook
 * Safe Links, corporate mail scanners and the Gmail image proxy all follow
 * links in delivered mail to check them. Every one of those fetches
 * unsubscribed a paying customer who never clicked anything, silently, and the
 * restaurant's list quietly shrank with no explanation available to anyone.
 *
 * The link in the email is unchanged, so everything already in an inbox keeps
 * working — it now lands on a button instead of firing on arrival.
 */
// @public-by-design: the recipient of a marketing email has no session and must
// be able to reach this from the link alone; this branch only renders a page
export const handleUnsubscribe = httpAction(async (_ctx, request) => {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  // Which campaign's mail carried this link, so the POST can charge the
  // unsubscribe to it. Absent for an automation's mail, for a link sent before
  // campaigns stamped one, and for the preferences page — all of which must
  // still unsubscribe.
  const campaignId = url.searchParams.get("c");

  if (!id) return new Response(INVALID_LINK, { status: 400, headers: HTML });

  // Both values are echoed into hidden fields, so both go through `esc` — they
  // are attacker-controlled text on their way into HTML.
  const confirm = `<form method="POST" action="/email/unsubscribe">
      <input type="hidden" name="id" value="${esc(id)}" />
      ${campaignId ? `<input type="hidden" name="c" value="${esc(campaignId)}" />` : ""}
      <button type="submit">Confirmer le désabonnement</button>
    </form>`;

  return new Response(
    htmlPage(
      "Confirmer le désabonnement",
      "Cliquez pour ne plus recevoir nos emails.",
      confirm
    ),
    { status: 200, headers: HTML }
  );
});

/**
 * POST does it — from the button above, or from a mail client's one-click.
 *
 * RFC 8058 one-click sends `List-Unsubscribe=One-Click` as the body with no
 * further interaction, which is exactly this endpoint. That is why there is no
 * CSRF token here and why there must not be one: the caller is Gmail or Yahoo,
 * not a browser carrying a session.
 */
// @public-by-design: RFC 8058 one-click is a machine POST from the mail
// provider, and the unguessable id in the link is the only credential it has
export const handleUnsubscribePost = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  let id = url.searchParams.get("id");
  let campaignId = url.searchParams.get("c");

  // The button posts a form body; one-click keeps both in the query string.
  if (!id) {
    try {
      const form = await request.formData();
      const field = form.get("id");
      if (typeof field === "string") id = field;
      const campaignField = form.get("c");
      if (typeof campaignField === "string" && campaignField) {
        campaignId = campaignField;
      }
    } catch {
      // No form body — the query string was the only source, and it was empty.
    }
  }

  if (!id) return new Response(INVALID_LINK, { status: 400, headers: HTML });

  try {
    await ctx.runMutation(internal.emailSubscribers.unsubscribe, {
      id: id as Id<"emailSubscribers">,
      // Charged to the campaign that sent the link — which is what makes
      // « Désabonnements » on the campaign report a real figure rather than a
      // count of SES spam complaints. The mutation refuses a campaign that
      // does not belong to this subscriber's store: the value arrives in a URL
      // the recipient holds.
      ...(campaignId
        ? { campaignId: campaignId as Id<"emailCampaigns"> }
        : {}),
    });
  } catch (error) {
    // Reported as success on purpose, but only for the recipient's benefit:
    // an id that no longer exists or is already unsubscribed means they are
    // not on the list, which is what they asked for, and distinguishing the
    // cases would turn this page into an oracle for which ids are live.
    //
    // It is logged, because the previous version swallowed a genuine failure
    // and told the customer they had been unsubscribed when they had not.
    console.error("Unsubscribe failed:", error);
    await captureBackendError(ctx, {
      error,
      source: "emailHttpHandlers.handleUnsubscribePost",
    });
  }

  return new Response(UNSUBSCRIBED, { status: 200, headers: HTML });
});

// ─── GET /email/confirm?token=<doubleOptInToken> ────────────────────────────

// @guarded-inline: the single-use doubleOptInToken is the credential, and
// the mutation clears it on use
export const handleConfirmOptIn = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return new Response(
      htmlPage("Erreur", "Lien de confirmation invalide."),
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  try {
    await ctx.runMutation(internal.emailSubscribers.confirmDoubleOptIn, {
      token,
    });

    return new Response(
      htmlPage(
        "Inscription confirmée !",
        "Merci, votre adresse email a bien été confirmée. Vous recevrez bientôt nos prochaines communications."
      ),
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Erreur inconnue";
    const userMsg =
      msg === "Token expiré"
        ? "Ce lien de confirmation a expiré (48h). Veuillez vous réinscrire."
        : msg === "Abonné déjà confirmé"
          ? "Votre inscription est déjà confirmée."
          : msg === "Adresse non distribuable"
            ? "Nous n'avons pas pu livrer d'email à cette adresse. Vérifiez-la, puis réinscrivez-vous."
            : "Ce lien de confirmation est invalide.";

    return new Response(htmlPage("Erreur", userMsg), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
});

// ─── POST /webhooks/ses ─────────────────────────────────────────────────────
//
// Receives SNS notifications from an SES Configuration Set.
// Tracked events: Bounce, Complaint, Delivery, Open, Click.
//
// Correlation relies on custom headers injected at send time:
//   X-Campaign-Id, X-Subscriber-Id, X-Store-Id
// ─────────────────────────────────────────────────────────────────────────────

interface SNSMessage {
  Type:
    | "SubscriptionConfirmation"
    | "Notification"
    | "UnsubscribeConfirmation";
  Message: string;
  SubscribeURL?: string;
  TopicArn?: string;
  SigningCertURL?: string;
}

interface SESNotification {
  notificationType:
    | "Bounce"
    | "Complaint"
    | "Delivery"
    | "Open"
    | "Click";
  mail: {
    messageId: string;
    source: string;
    destination: string[];
    headers?: Array<{ name: string; value: string }>;
  };
  bounce?: {
    bounceType: "Permanent" | "Transient" | "Undetermined";
    bouncedRecipients: Array<{ emailAddress: string }>;
  };
  complaint?: {
    complainedRecipients: Array<{ emailAddress: string }>;
  };
  open?: { timestamp: string; userAgent?: string };
  click?: { timestamp: string; link?: string };
}

function getMailHeader(
  headers: Array<{ name: string; value: string }> | undefined,
  name: string
): string | undefined {
  return headers?.find((h) => h.name === name)?.value;
}

/**
 * Record one feedback event against one subscriber.
 *
 * WHY THIS IS A FUNCTION. There are two feedback transports now — Amazon SNS
 * for an SES deployment and Svix for a Resend one — and they carry the same six
 * facts under different names. Written twice they would drift, and the half
 * that drifts is the one nobody runs: a client on Resend is by definition a
 * client whose SES request was refused, so a bug here reaches the deployment
 * that has no second path to fall back on. One function, two callers, and the
 * SES suite proves it for both.
 *
 * `bounced` and `complained` also suppress the address; `delivered`, `opened`,
 * `clicked` and `sent` are statistics and only move counters.
 */
async function recordFeedbackEvent(
  ctx: ActionCtx,
  event: {
    type: "sent" | "delivered" | "opened" | "clicked" | "bounced" | "complained";
    storeId: Id<"stores">;
    subscriberId: Id<"emailSubscribers">;
    campaignId?: Id<"emailCampaigns">;
    occurredAt: number;
    /** Only read for `bounced`; normalised by the caller. */
    bounceType?: "Permanent" | "Transient" | "Undetermined";
    metadata?: { userAgent?: string; linkUrl?: string };
  }
): Promise<void> {
  if (event.type === "bounced") {
    await ctx.runMutation(internal.emailSubscribers.markBounced, {
      id: event.subscriberId,
      bounceType: event.bounceType,
    });
  } else if (event.type === "complained") {
    await ctx.runMutation(internal.emailSubscribers.markComplained, {
      id: event.subscriberId,
    });
  }

  await ctx.runMutation(internal.emailEvents.create, {
    storeId: event.storeId,
    campaignId: event.campaignId,
    subscriberId: event.subscriberId,
    type: event.type,
    metadata: event.metadata,
    occurredAt: event.occurredAt,
  });

  if (!event.campaignId) return;

  // A spam report also removes the recipient from the list, so it is counted
  // as an unsubscribe — but it was for a long time the ONLY writer of that
  // field, which made « Désabonnements » on the campaign report a count of
  // complaints wearing the wrong label. The unsubscribe link now carries its
  // campaign and charges itself; see `emailSubscribers.unsubscribe`.
  //
  // `sent` is not counted here: the sender increments it when it hands the
  // message over, and counting the provider's echo of the same message would
  // double every campaign's « Envoyés ».
  const field =
    event.type === "complained"
      ? "unsubscribed"
      : event.type === "sent"
        ? null
        : event.type;
  if (!field) return;

  await ctx.runMutation(internal.emailCampaigns.incrementStats, {
    id: event.campaignId,
    field,
  });
}


// @guarded-inline: verifies Amazon's RSA signature over the raw body before
// reading a single field out of it
export const handleSesWebhook = httpAction(async (ctx, request) => {
  const rawBody = await request.text();

  let snsMessage: SNSMessage;
  try {
    snsMessage = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // The check that used to stand here asked whether the body's own
  // `SigningCertURL` field looked like an Amazon host, and treated a yes as
  // authentication. The attacker writes that field. Everything below —
  // `markBounced`, `markComplained`, the campaign counters — was reachable by
  // anyone who could POST, for any subscriber id they cared to name.
  //
  // Amazon signs every message; that signature is the only thing here that an
  // attacker cannot produce. The host check still runs, in
  // `sesWebhookVerify`, doing the job it can actually do: deciding which host
  // we are willing to fetch a certificate from.
  const verdict = await ctx.runAction(internal.sesWebhookVerify.verify, {
    body: rawBody,
  });
  if (!verdict.valid) {
    console.error("Rejected SES webhook:", verdict.reason);
    // A SubscriptionConfirmation this deployment will not accept is answered
    // 200, not 403, and the reason is the same one the refusal below gives:
    // SNS retries a non-2xx, and there is nothing here to retry. The topic is
    // not on the list and re-sending will not put it there — an operator has
    // to set `SES_SNS_TOPIC_ARN` (the log line above names the ARN to paste)
    // or confirm from the AWS console. Refusing is still refusing: nothing is
    // fetched and no subscription is created.
    //
    // A NOTIFICATION gets the 403. Those are worth retrying — the variable may
    // be set in the meantime — and an unauthenticated caller is owed the
    // status code that says so.
    const isConfirmation = snsMessage.Type === "SubscriptionConfirmation";
    return new Response(isConfirmation ? "OK" : "Unauthorized", {
      status: isConfirmation ? 200 : 403,
    });
  }

  // Handle subscription confirmation (first-time setup)
  //
  // THE STEP THAT MADE A FORGED TOPIC SELF-SERVICE. This fetched any
  // `SubscribeURL` on an `sns.*.amazonaws.com` host, and that host check is
  // satisfied by every SNS topic in every AWS account — including one an
  // attacker owns. They pointed their own topic at this endpoint and the
  // endpoint confirmed the subscription for them; from then on their messages
  // carried a genuine Amazon signature, and the handler below marks
  // subscribers bounced and complained from ids in the message body.
  //
  // `mayConfirm` comes from `sesWebhookVerify`, which decides it against
  // `SES_SNS_TOPIC_ARN` AFTER the signature has made `TopicArn` trustworthy. A
  // deployment that has not been told its topic confirms nothing and logs what
  // to set — the subscription is also confirmable from the AWS console, which
  // is where an operator doing it deliberately would be.
  if (snsMessage.Type === "SubscriptionConfirmation") {
    if (!verdict.mayConfirm) {
      console.error(
        "[SES] refusing to confirm an SNS subscription for an unconfigured topic:",
        snsMessage.TopicArn,
        "— set SES_SNS_TOPIC_ARN on this deployment to allow it."
      );
      return new Response("OK", { status: 200 });
    }
    if (snsMessage.SubscribeURL) {
      // Still checked, and still for SSRF: `SubscribeURL` is a field in the
      // body, and a signed message is not thereby a safe URL to fetch.
      try {
        const subUrl = new URL(snsMessage.SubscribeURL);
        if (
          subUrl.protocol === "https:" &&
          /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(subUrl.hostname)
        ) {
          await fetch(snsMessage.SubscribeURL);
          console.log("SNS subscription confirmed for:", snsMessage.TopicArn);
        } else {
          console.error("Invalid SubscribeURL origin:", snsMessage.SubscribeURL);
        }
      } catch {
        console.error("Invalid SubscribeURL:", snsMessage.SubscribeURL);
      }
    }
    return new Response("OK", { status: 200 });
  }

  // Only process Notification type
  if (snsMessage.Type !== "Notification") {
    return new Response("OK", { status: 200 });
  }

  let notification: SESNotification;
  try {
    notification = JSON.parse(snsMessage.Message);
  } catch {
    return new Response("Invalid SES notification", { status: 400 });
  }

  // Extract correlation headers injected at send time
  const campaignId = getMailHeader(
    notification.mail.headers,
    "X-Campaign-Id"
  );
  const subscriberId = getMailHeader(
    notification.mail.headers,
    "X-Subscriber-Id"
  );
  const storeId = getMailHeader(notification.mail.headers, "X-Store-Id");

  const now = Date.now();
  const typedCampaignId = campaignId
    ? (campaignId as Id<"emailCampaigns">)
    : undefined;

  /* Who this notification is about.

     The headers above are the precise answer and are usually there. They are
     not always: SES omits `mail.headers` from a notification unless the sending
     identity is configured to include the original headers, and nothing
     configured that until `scripts/setup-aws.sh` grew its Step 2b. This
     function's whole body used to sit behind
     `if (!storeId || !subscriberId) return 200`, so on a deployment provisioned
     before then EVERY bounce and EVERY complaint was read as "sent outside the
     campaign system" and dropped — silently, with the 200 that tells SNS the
     delivery succeeded and never to send it again.

     So a bounce or a complaint falls back to the address. SES always names the
     recipient, and the recipient is what the notification is about: a hard
     bounce says the mailbox does not exist and a complaint says this person
     reported us, and neither fact depends on knowing which campaign carried the
     message. Both suppress, and suppression is what keeps the account sending —
     AWS suspends at a 5 % complaint rate, per ACCOUNT, and one AWS account
     holds every store an owner runs.

     Deliveries, opens and clicks do NOT fall back. Those are campaign
     statistics, and attributing one to a store that did not send the message
     would corrupt the figure rather than complete it. */
  const targets: Array<{
    storeId: Id<"stores">;
    subscriberId: Id<"emailSubscribers">;
  }> = [];

  if (storeId && subscriberId) {
    targets.push({
      storeId: storeId as Id<"stores">,
      subscriberId: subscriberId as Id<"emailSubscribers">,
    });
  } else if (
    notification.notificationType === "Bounce" ||
    notification.notificationType === "Complaint"
  ) {
    // The per-recipient lists first — one notification can carry several — with
    // `mail.destination` behind them, which SES always sets.
    const addresses = new Set(
      [
        ...(notification.bounce?.bouncedRecipients ?? []).map(
          (r) => r.emailAddress
        ),
        ...(notification.complaint?.complainedRecipients ?? []).map(
          (r) => r.emailAddress
        ),
        ...(notification.mail.destination ?? []),
      ]
        .filter((address): address is string => typeof address === "string")
        .map((address) => address.toLowerCase())
    );

    for (const address of addresses) {
      const matches = await ctx.runQuery(
        internal.emailSubscribers.listByEmailInternal,
        { email: address }
      );
      for (const subscriber of matches) {
        targets.push({
          storeId: subscriber.storeId,
          subscriberId: subscriber._id,
        });
      }
    }
  }

  if (targets.length === 0) {
    /* Genuinely nobody: a transactional mail to an address no list holds, or a
       Delivery/Open/Click whose headers did not survive. Nothing to record.

       But a bounce or a complaint reaching here is a misconfiguration rather
       than a stray, so it is reported instead of dropped. A silent 200 is
       exactly how this stayed invisible: the endpoint answered correctly, SES
       stopped mentioning it, and the first symptom available to anyone was the
       account being suspended. */
    if (
      notification.notificationType === "Bounce" ||
      notification.notificationType === "Complaint"
    ) {
      await captureBackendError(ctx, {
        error: new Error(
          `SES ${notification.notificationType} matched no subscriber` +
            (notification.mail.headers
              ? ""
              : " and carried no original headers — the sending identity is not" +
                " configured to include them (scripts/setup-aws.sh, Step 2b)")
        ),
        source: "emailHttpHandlers.handleSesWebhook",
      });
    }
    return new Response("OK", { status: 200 });
  }

  try {
    for (const {
      storeId: typedStoreId,
      subscriberId: typedSubscriberId,
    } of targets) {
      switch (notification.notificationType) {
        case "Bounce":
          await recordFeedbackEvent(ctx, {
            type: "bounced",
            storeId: typedStoreId,
            subscriberId: typedSubscriberId,
            campaignId: typedCampaignId,
            occurredAt: now,
            // The classification is the whole point of reading this branch.
            // Without it every dead mailbox was mailed three times, and it is
            // the bounce ratio — not the number of distinct bad addresses —
            // that AWS suspends an account over. The body is signed, so this is
            // trustworthy by the time execution reaches here.
            //
            // Normalised rather than forwarded raw: `markBounced`'s validator is
            // a closed union, and this whole dispatch sits inside a catch that
            // only logs — so an unrecognised value would fail validation, be
            // swallowed, and lose the bounce entirely.
            bounceType: normalizeBounceType(notification.bounce?.bounceType),
          });
          break;

        case "Complaint":
          await recordFeedbackEvent(ctx, {
            type: "complained",
            storeId: typedStoreId,
            subscriberId: typedSubscriberId,
            campaignId: typedCampaignId,
            occurredAt: now,
          });
          break;

        case "Delivery":
          await recordFeedbackEvent(ctx, {
            type: "delivered",
            storeId: typedStoreId,
            subscriberId: typedSubscriberId,
            campaignId: typedCampaignId,
            occurredAt: now,
          });
          break;

        case "Open":
          await recordFeedbackEvent(ctx, {
            type: "opened",
            storeId: typedStoreId,
            subscriberId: typedSubscriberId,
            campaignId: typedCampaignId,
            occurredAt: now,
            metadata: notification.open?.userAgent
              ? { userAgent: notification.open.userAgent }
              : undefined,
          });
          break;

        case "Click":
          await recordFeedbackEvent(ctx, {
            type: "clicked",
            storeId: typedStoreId,
            subscriberId: typedSubscriberId,
            campaignId: typedCampaignId,
            occurredAt: now,
            metadata: notification.click?.link
              ? { linkUrl: notification.click.link }
              : undefined,
          });
          break;
      }
    }
  } catch (error) {
    console.error("SES webhook processing error:", error);
    await captureBackendError(ctx, {
      error,
      source: "emailHttpHandlers.handleSesWebhook",
    });
  }

  return new Response("OK", { status: 200 });
});

// ─── POST /webhooks/resend ──────────────────────────────────────────────────
//
// The feedback path for a deployment running `EMAIL_PROVIDER=resend`.
//
// WHY IT EXISTS. Resend is the escape hatch for a client whose AWS SES
// production-access request was refused — every client owns its own AWS
// account, files its own request, and approval is not guaranteed; one has been
// refused. That client shipped with `/webhooks/ses` as the only feedback
// endpoint in the whole app, and SNS never calls it, so nothing suppressed a
// dead address and nothing recorded a spam report. The list grew, the bounce
// rate climbed, and the first symptom available to anyone was the sending
// domain being throttled.
//
// Resend signs with Svix: HMAC-SHA256 over `<svix-id>.<svix-timestamp>.<body>`.
// Symmetric, so unlike the SNS path this needs no Node runtime — `crypto.subtle`
// is in the Convex V8 runtime and `deliverooWebhookHandler.ts` already uses it.
//
// Correlation uses the same three headers the SES path reads, which the Resend
// transport carries (`packages/core/src/email/providers.ts`), and falls back to
// the recipient address for a bounce or a complaint for the same reason: those
// two suppress whatever campaign carried them.
// ─────────────────────────────────────────────────────────────────────────────

interface ResendWebhookPayload {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    from?: string;
    subject?: string;
    headers?: Array<{ name: string; value: string }> | Record<string, string>;
    bounce?: { type?: string; subType?: string; message?: string };
    click?: { link?: string; userAgent?: string };
    open?: { userAgent?: string };
  };
}

/**
 * One named header out of whichever shape Resend sent.
 *
 * Resend echoes the headers a message was sent with, and has used both an array
 * of `{name, value}` and a flat object over the life of the API. Reading only
 * one shape is how a correlation quietly stops working after a provider-side
 * change — and it fails INVISIBLY here, because the fallback below still finds
 * the subscriber by address and the campaign attribution is simply lost.
 *
 * Header names are matched case-insensitively: HTTP header names are, and a
 * provider that lower-cases them on the way out is within its rights.
 */
type ResendHeaders =
  | Array<{ name?: string; value?: string }>
  | Record<string, string>
  | undefined;

function getResendHeader(
  headers: ResendHeaders,
  name: string
): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  if (Array.isArray(headers)) {
    return headers.find((h) => h?.name?.toLowerCase() === wanted)?.value;
  }
  if (typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === wanted && typeof value === "string") return value;
    }
  }
  return undefined;
}

/** Base64 to bytes, for the HMAC key and for the signature being compared. */
function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Is this POST really from Resend?
 *
 * Everything the handler does afterwards — `markBounced`, `markComplained`,
 * the campaign counters — acts on ids and addresses taken out of this body,
 * so this function is the whole authorisation. An `httpAction` has no session
 * to check; the HMAC over the raw body IS the caller's identity.
 *
 * Separated from the handler so it runs on the path EVERY caller takes and its
 * verdict is read on that same path. A check reached only from inside a branch
 * is the `validateIntegration` defect (#441), where the permission call sat in
 * `if (!identity) {…}` and every signed-in account skipped it.
 */
async function verifyResendSignature(
  request: Request,
  rawBody: string
): Promise<{ valid: boolean; status: number; reason: string }> {
  const {
    RESEND_WEBHOOK_SECRET_ENV,
    buildSvixSignedPayload,
    isFreshTimestamp,
    parseSignatureHeader,
    parseWebhookSecret,
    readSvixHeaders,
    timingSafeEqual,
  } = await import("@be-yours/convex-functions/resendSignature");

  const secret = parseWebhookSecret(process.env[RESEND_WEBHOOK_SECRET_ENV]);
  if (!secret) {
    // FAILS CLOSED, and says what to set. The alternative — processing an
    // unverified body — is the exact defect `/webhooks/ses` shipped with.
    //
    // 401, not 200: Svix retries a non-2xx for a day, so an operator who sets
    // the secret in that window gets the backlog rather than a silent hole.
    console.error(
      `[Resend] refusing a webhook: ${RESEND_WEBHOOK_SECRET_ENV} is not set on this` +
        " deployment. Copy the signing secret from the Resend dashboard" +
        " (Webhooks → your endpoint) and run:" +
        ` npx convex env set ${RESEND_WEBHOOK_SECRET_ENV} whsec_...`
    );
    return { valid: false, status: 401, reason: "secret_not_configured" };
  }

  const svix = readSvixHeaders(request.headers);
  if (!svix) {
    return { valid: false, status: 400, reason: "missing_signature_headers" };
  }

  if (!isFreshTimestamp(svix.timestamp, Date.now())) {
    // The signature covers the timestamp, so this is what stops a captured
    // delivery being replayed for ever. 400 rather than 401: the message may
    // well have been genuine when it was signed.
    console.error("[Resend] rejected a webhook outside the replay window");
    return { valid: false, status: 400, reason: "stale_signature" };
  }

  const candidates = parseSignatureHeader(svix.signature);
  if (candidates.length === 0) {
    return { valid: false, status: 400, reason: "unsupported_signature_version" };
  }

  let expected: string;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      base64ToBytes(secret) as unknown as ArrayBuffer,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signed = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(
        buildSvixSignedPayload(svix.id, svix.timestamp, rawBody)
      ) as unknown as ArrayBuffer
    );
    expected = bytesToBase64(new Uint8Array(signed));
  } catch (error) {
    // A secret that is not base64 lands here. It is a misconfiguration, not an
    // attack, and it must not be reported as a valid signature.
    console.error("[Resend] could not compute the expected signature:", error);
    return { valid: false, status: 401, reason: "unusable_secret" };
  }

  // Svix signs one delivery with both secrets while a secret is being rotated,
  // so ANY candidate matching is a pass. Every candidate is compared, in
  // constant time, with no early exit on the first match.
  let matched = false;
  for (const candidate of candidates) {
    if (timingSafeEqual(candidate, expected)) matched = true;
  }
  if (!matched) {
    console.error("[Resend] rejected a webhook: signature mismatch");
    return { valid: false, status: 401, reason: "signature_mismatch" };
  }

  return { valid: true, status: 200, reason: "ok" };
}

// @guarded-inline: `verifyResendSignature` runs on the path every caller takes
// and its verdict is read on that same path — the HMAC over the raw body is
// the only identity an httpAction has, and an unset secret refuses rather than
// falling open
export const handleResendWebhook = httpAction(async (ctx, request) => {
  const rawBody = await request.text();

  const verdict = await verifyResendSignature(request, rawBody);
  if (!verdict.valid) {
    return new Response(verdict.status === 401 ? "Unauthorized" : verdict.reason, {
      status: verdict.status,
    });
  }

  const { recordedEventFor, suppressesRecipient } = await import(
    "@be-yours/convex-functions/resendSignature"
  );

  let payload: ResendWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const recorded = recordedEventFor(payload.type);
  if (!recorded) {
    // `email.delivery_delayed` and anything Resend adds later. Answered 200 so
    // it is not retried: there is nothing here to retry, the event simply is
    // not one this product records.
    return new Response("OK", { status: 200 });
  }

  const headers = payload.data?.headers;
  const campaignId = getResendHeader(headers, "X-Campaign-Id");
  const subscriberId = getResendHeader(headers, "X-Subscriber-Id");
  const storeId = getResendHeader(headers, "X-Store-Id");

  const now = Date.now();
  const typedCampaignId = campaignId
    ? (campaignId as Id<"emailCampaigns">)
    : undefined;

  const targets: Array<{
    storeId: Id<"stores">;
    subscriberId: Id<"emailSubscribers">;
  }> = [];

  if (storeId && subscriberId) {
    targets.push({
      storeId: storeId as Id<"stores">,
      subscriberId: subscriberId as Id<"emailSubscribers">,
    });
  } else if (suppressesRecipient(payload.type)) {
    // Same rule as the SES path, and the same reason: a hard bounce says the
    // mailbox does not exist and a complaint says this person reported us.
    // Neither depends on knowing which campaign carried the message, and both
    // must suppress or the account's own reputation pays for it. Deliveries,
    // opens and clicks do NOT fall back — attributing one to a store that did
    // not send the message would corrupt the figure rather than complete it.
    const to = payload.data?.to;
    const addresses = new Set(
      (Array.isArray(to) ? to : to ? [to] : [])
        .filter((address): address is string => typeof address === "string")
        .map((address) => address.toLowerCase())
    );
    for (const address of addresses) {
      const matches = await ctx.runQuery(
        internal.emailSubscribers.listByEmailInternal,
        { email: address }
      );
      for (const subscriber of matches) {
        targets.push({
          storeId: subscriber.storeId,
          subscriberId: subscriber._id,
        });
      }
    }
  }

  if (targets.length === 0) {
    // A bounce or a complaint reaching here is a misconfiguration rather than a
    // stray, so it is reported instead of dropped — a silent 200 is exactly how
    // the SES hole stayed invisible.
    if (suppressesRecipient(payload.type)) {
      await captureBackendError(ctx, {
        error: new Error(
          `Resend ${payload.type} matched no subscriber` +
            (headers
              ? ""
              : " and carried no original headers — the send did not set" +
                " X-Store-Id / X-Subscriber-Id")
        ),
        source: "emailHttpHandlers.handleResendWebhook",
      });
    }
    return new Response("OK", { status: 200 });
  }

  try {
    for (const { storeId: typedStoreId, subscriberId: typedSubscriberId } of targets) {
      await recordFeedbackEvent(ctx, {
        type: recorded,
        storeId: typedStoreId,
        subscriberId: typedSubscriberId,
        campaignId: typedCampaignId,
        occurredAt: now,
        // Resend classifies a bounce the way SES does, so the same normaliser
        // applies. `email.failed` carries none, which suppresses only on the
        // third strike — the cautious reading, and the one `markBounced`
        // already implements for a bounce with no classification.
        bounceType: normalizeBounceType(payload.data?.bounce?.type),
        metadata:
          recorded === "clicked" && payload.data?.click?.link
            ? { linkUrl: payload.data.click.link }
            : recorded === "opened" && payload.data?.open?.userAgent
              ? { userAgent: payload.data.open.userAgent }
              : undefined,
      });
    }
  } catch (error) {
    console.error("Resend webhook processing error:", error);
    await captureBackendError(ctx, {
      error,
      source: "emailHttpHandlers.handleResendWebhook",
    });
  }

  return new Response("OK", { status: 200 });
});
