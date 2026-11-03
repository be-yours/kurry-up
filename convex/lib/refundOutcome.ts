/**
 * After a refund call fails: do we know the money is still where we left it?
 *
 * WHAT WAS BROKEN. `payments.refundPayment` commits the amount before calling
 * the provider and releases it in a `catch`, so the operator can retry. The
 * `catch` was unconditional — one block, no classification — while
 * `sumup.ts` carried a comment stating the opposite in as many words:
 *
 *     released only when the provider REFUSES. A timeout is not a refusal, so
 *     the release does not run and the balance stays committed.
 *
 * Nothing in the code distinguished the two. A 48 € SumUp refund that timed out
 * released the reservation, the operator pressed the button again, and 96 €
 * left the restaurant's account. The comment was the only thing standing
 * between the product and a double refund, and it described code that did not
 * exist.
 *
 * WHY IT IS SAFE FOR THE OTHER TWO. #448 gave Stripe and PayPal an idempotency
 * key derived from the reservation — `refund-<paymentId>-<index>` — which is
 * stable across retries of one refund. A retry there reaches the same key and
 * the provider returns the ORIGINAL refund instead of making a second one, so
 * releasing on any failure is correct: the worst case is one refund reported
 * twice, not two refunds paid. SumUp's `POST /v0.1/me/refund/{txid}` documents
 * no such field, and inventing a header it does not read would be worse than
 * nothing — it would look like the same protection.
 *
 * So the rule is not about which provider is trusted. It is about whether the
 * RETRY this release enables is idempotent. Where it is, release freely. Where
 * it is not, release only when the provider has told us it did nothing.
 */

import { ConvexError } from "convex/values";

/**
 * The provider answered, and its answer was "no". No money moved.
 *
 * The reservation is safe to release: a retry starts from the same place the
 * first attempt did.
 */
export const REFUND_REFUSED = "REFUND_REFUSED";

/**
 * The provider did not answer, or answered that it had failed internally.
 *
 * A refund may or may not have been issued. The reservation must STAND: an
 * operator who retries from a released balance can pay twice, and no key exists
 * to stop them. Reconcile at the provider before retrying.
 */
export const REFUND_OUTCOME_UNKNOWN = "REFUND_OUTCOME_UNKNOWN";

/**
 * Providers whose refund request carries an idempotency key.
 *
 * The list is the point of the whole module: add a provider here only once its
 * `internalRefund` actually sends a key, or a lost response starts costing the
 * restaurant money again. `sumup` is deliberately absent.
 */
export const IDEMPOTENT_REFUND_PROVIDERS = ["stripe", "paypal"] as const;

/**
 * Read the `code` off a thrown `ConvexError`, in either serialised form.
 *
 * Convex redacts the message of a plainly thrown `Error` in production, so a
 * refusal a caller must tell apart travels as `ConvexError({ code })` — see
 * `lib/convex-error.ts` for the same reader on the browser side. `data` arrives
 * as an object across a real deployment and as a JSON string under
 * `convex-test`, and a rule that worked under only one of the two would be
 * wrong on precisely the side nobody exercises.
 *
 * Kept here rather than imported from `lib/convex-error.ts`: nothing under
 * `convex/` imports from the Next.js half of the app, and the engine packages
 * are pinned to their last PUBLISHED version in a client site, so neither is a
 * home a backend module can rely on.
 */
export function refundErrorCode(error: unknown): string | null {
  const raw = (error as { data?: unknown } | null | undefined)?.data;
  if (raw == null) return null;

  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (typeof data !== "object" || data === null) return null;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * May the committed amount be given back after `error`?
 *
 * `true` releases the reservation and lets the operator retry. `false` leaves
 * the balance committed, which is the safe answer whenever a second attempt
 * could pay a second time.
 *
 * The default is `false` for a non-idempotent provider: an error this module
 * does not recognise is an error whose outcome it does not know, and guessing
 * "refused" is the guess that costs money.
 */
export function mayReleaseRefundReservation(
  provider: string,
  error: unknown,
): boolean {
  if ((IDEMPOTENT_REFUND_PROVIDERS as readonly string[]).includes(provider)) {
    return true;
  }
  return refundErrorCode(error) === REFUND_REFUSED;
}

/**
 * Did the provider decide, or did we merely fail to hear it?
 *
 * `status` is an HTTP status, or `null` for a request that never produced a
 * response at all — a DNS failure, a dropped connection, a timeout.
 *
 * A 4xx is the provider having received the request and rejected it: no money
 * moved. A 5xx is the provider failing to complete something it may already
 * have started. 408 and 425 are 4xx by number and ambiguous in fact — a proxy
 * can emit either after the origin has processed the request — so they are
 * counted with the unknowns. The bias throughout is towards `false`, because
 * the two answers cost different things: a wrong "unknown" makes an operator
 * check SumUp's dashboard, and a wrong "refused" refunds the diner twice.
 */
export function providerRefusedOutright(status: number | null): boolean {
  if (status === null) return false;
  if (status === 408 || status === 425) return false;
  return status >= 400 && status < 500;
}

/**
 * The error a non-idempotent refund throws, carrying which of the two it is.
 *
 * `ConvexError` rather than `Error` so the code survives both the action
 * boundary and Convex's production redaction. The message is written for the
 * operator reading it in the admin, because they are the one who has to decide
 * whether to retry.
 */
export function refundFailure(
  status: number | null,
  detail: string,
): ConvexError<{ code: string; message: string }> {
  const refused = providerRefusedOutright(status);
  const where = status === null ? "no response" : `HTTP ${status}`;
  return new ConvexError({
    code: refused ? REFUND_REFUSED : REFUND_OUTCOME_UNKNOWN,
    message: refused
      ? `Le remboursement a été refusé par SumUp (${where}${detail ? `: ${detail}` : ""}). Aucun montant n'a été renvoyé ; vous pouvez réessayer.`
      : `SumUp n'a pas confirmé le remboursement (${where}${detail ? `: ${detail}` : ""}). Le montant reste engagé : vérifiez le remboursement dans SumUp avant de réessayer, sinon le client peut être remboursé deux fois.`,
  });
}
