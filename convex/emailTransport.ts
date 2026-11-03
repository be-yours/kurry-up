"use node";

/**
 * The one place a Convex action reaches an email provider.
 *
 * Four actions used to construct their own `SESv2Client` from `process.env`,
 * each repeating the region default, the credential reads and the same
 * `noreply@beindigital.fr` fallback — an address that belongs to the agency and
 * to no client, so a deployment that had not set `AWS_SES_FROM_EMAIL` sent from
 * a domain its own SES account cannot sign for, and the send was refused.
 *
 * Worse, none of it could be pointed anywhere else. Every client owns its AWS
 * account and files its own SES production-access request; approval is not
 * guaranteed and one has already been refused. `apps/site` had the escape hatch
 * — `EMAIL_PROVIDER=resend` — and the engine did not, so a refused client had
 * no path to sending email at all. See #212.
 *
 * `"use node"` because the SES operations pull in the AWS SDK. The decision
 * itself lives in `@be-yours/core/email/providers`, which imports no SDK,
 * so the choice is testable without one.
 */

import { createSESv2Operations } from "@be-yours/core";
import {
  resolveEmailProvider,
  type EmailMessage,
  type EmailProviderEnv,
  type EmailSendOutcome,
} from "@be-yours/core/email/providers";

/**
 * The environment fields a resolution depends on, as one string.
 *
 * The resolution is cached — a Convex action can run thousands of times in one
 * container, and rebuilding the SDK client per send is pure overhead — but a
 * cache keyed on nothing is a trap: change `EMAIL_PROVIDER` and the isolate
 * keeps using the transport it built before. Keyed on what it read, the cache
 * is an optimisation and not a behaviour.
 *
 * `RESEND_API_KEY` is included by presence, not by value: the key is a secret
 * and this string ends up in a comparison, not in a log, but there is no
 * reason for it to be there at all.
 */
function envKey(env: EmailProviderEnv): string {
  return [
    env.EMAIL_PROVIDER ?? "",
    env.AWS_REGION ?? "",
    env.AWS_ACCESS_KEY_ID ?? "",
    env.AWS_SES_FROM_EMAIL ?? "",
    env.RESEND_FROM_EMAIL ?? "",
    env.EMAIL_FROM ?? "",
    env.RESEND_API_KEY ? "resend-key" : "",
    env.AWS_SECRET_ACCESS_KEY ? "aws-secret" : "",
  ].join("|");
}

let cached: {
  key: string;
  resolution: ReturnType<typeof resolveEmailProvider>;
} | null = null;

function transport() {
  const env = process.env as EmailProviderEnv;
  const key = envKey(env);
  if (cached?.key !== key) {
    cached = { key, resolution: resolveEmailProvider(env, createSESv2Operations) };
  }
  return cached.resolution;
}

/**
 * The address this deployment sends from, or `null` when it has none.
 *
 * Deliberately NOT defaulted to `noreply@beindigital.fr`. That address is the
 * agency's; a client's SES account cannot sign for it, so the fallback turned
 * "you have not finished onboarding" into "your customers' confirmations bounce
 * silently". `null` lets a caller say which establishment is unconfigured.
 */
export function emailSender(): string | null {
  const resolved = transport();
  return resolved.ok ? resolved.from : null;
}

/**
 * Send one message through whichever provider is configured.
 *
 * Best-effort by contract: this reports `{ sent: false, error }` rather than
 * throwing, because its callers are scheduled actions where an exception
 * abandons a batch mid-campaign. Callers are expected to READ the result —
 * four of them historically did not, which is how a campaign could report
 * "sent (0/342)".
 */
export async function sendEmail(
  message: EmailMessage
): Promise<EmailSendOutcome> {
  const resolved = transport();
  if (!resolved.ok) {
    console.error(`[emailTransport] ${resolved.reason}`);
    return { sent: false, error: resolved.reason };
  }
  return resolved.transport.send(message);
}

/**
 * Send from the deployment's own sender, without the caller naming it.
 *
 * The transactional shape: an invitation, a winning ticket, a migration
 * notice. A campaign formats its own `from` per store and calls `sendEmail`.
 */
export async function sendFromDeployment(
  message: Omit<EmailMessage, "from">
): Promise<EmailSendOutcome> {
  const from = emailSender();
  if (!from) {
    const resolved = transport();
    const reason = resolved.ok ? "aucun expéditeur configuré" : resolved.reason;
    console.error(`[emailTransport] ${reason}`);
    return { sent: false, error: reason };
  }
  return sendEmail({ ...message, from });
}

/** The active provider's name, for a log line that has to say which. */
export function emailProviderName(): string {
  const resolved = transport();
  return resolved.ok ? resolved.transport.name : "aucun";
}
