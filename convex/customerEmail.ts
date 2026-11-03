"use node";

/**
 * The emails a diner receives (AWS SES).
 *
 * Two of them, and neither is marketing:
 *  - the order confirmation, sent the moment an order is paid for;
 *  - the prize email, sent after a winner claims their lot.
 *
 * Both are best effort — a delivery failure never breaks the flow that
 * triggered it. The diner has already seen the outcome on screen.
 *
 * WHY THEY SHARE A FILE (this was `gameEmail.ts`, and the rename is the point):
 * Convex bundles every `"use node"` module separately with its dependencies,
 * and the e2e workflow pushes all of them into a local backend under a hard
 * five-minute ceiling — #315 measured the push already running at ~60% of it,
 * and a further Node bundle carrying its own copy of the AWS SDK took three of
 * four shards over. So a new transactional email joins an existing SES module
 * rather than opening another one. `emailAutomationActions.ts` made the same
 * call for the double opt-in confirmation and says so in the same words.
 *
 * It is also where the confirmation belongs, and why the file is no longer
 * named after the game: these are the establishment's transactional emails to
 * its customers, as opposed to the marketing ones in
 * `emailCampaignActions.ts` and `emailAutomationActions.ts`. The distinction is
 * load-bearing — `orders.ts` refuses to turn a buyer into a marketing
 * subscriber ("an order is a purchase, not consent"), so a receipt cannot ride
 * on the automation engine.
 */

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { emailSender, sendEmail } from "./emailTransport";
import { renderOrderConfirmation } from "@be-yours/core/aws/ses/order-confirmation";
import { renderOrderReady } from "@be-yours/core/aws/ses/order-ready";
import {
  renderExperienceSeatsFreed,
  renderReservationNotice,
  renderWaitlistLink,
  renderWaitlistOffer,
} from "@be-yours/core/aws/ses/reservation-notice";
import { renderAlertDigest, renderDailyReport } from "@be-yours/core/aws/ses/reservation-digest";

async function sendViaSES(params: {
  toEmail: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  /** Overrides the deployment sender with the establishment's own identity. */
  fromEmail?: string;
  replyToEmail?: string;
}) {
  // No `noreply@beindigital.fr` fallback any more. That address is the
  // agency's: a client's own SES account cannot sign for it, so the fallback
  // turned "onboarding is not finished" into a confirmation that bounces
  // without anyone being told. Refusing names the problem instead — and the
  // caller at :252 already handles a missing sender that way.
  const fromEmail = params.fromEmail || emailSender();
  if (!fromEmail) {
    throw new Error(
      "aucun expéditeur : ni la configuration de l'établissement ni AWS_SES_FROM_EMAIL n'est renseigné"
    );
  }

  const outcome = await sendEmail({
    from: fromEmail,
    to: params.toEmail,
    subject: params.subject,
    html: params.htmlBody,
    text: params.textBody,
    ...(params.replyToEmail ? { replyTo: params.replyToEmail } : {}),
  });

  // This one THROWS where the transport reports, because its caller runs under
  // a confirmation claim it has to release on failure — see
  // `releaseConfirmationClaim`. Swallowing here would strand the claim and the
  // diner would never get a second attempt.
  if (!outcome.sent) {
    throw new Error(outcome.error ?? "envoi refusé par le fournisseur");
  }
}

/**
 * A display name that cannot break the `From` header.
 *
 * `Chez Luigi <no-reply@…>` is fine; « Pizzeria Luigi, Lyon 3e » is not — an
 * unquoted comma makes RFC 5322 read it as two addresses, SES rejects the whole
 * send, and the establishment never sends a confirmation again. The trading
 * name is a public, owner-typed string, so commas are ordinary rather than
 * exotic, and an angle bracket in it would let the name carry an address of its
 * own.
 */
function quoteDisplayName(name: string): string {
  const cleaned = name.replace(/[\r\n]+/g, " ").trim();
  if (!cleaned) return "";
  // A bare atom only when every character is safe unquoted.
  if (/^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]+$/.test(cleaned)) return cleaned;
  return `"${cleaned.replace(/([\\"])/g, "\\$1")}"`;
}

/**
 * A subject line with no control characters in it.
 *
 * SESv2's `Content.Simple` builds and encodes the MIME itself, so this is not
 * header injection — but a CR or LF reaching SES gets the send rejected, and a
 * rejected send is a diner who hears nothing.
 */
function sanitiseSubject(subject: string): string {
  return subject.replace(/[\r\n\t]+/g, " ").trim();
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function buildPrizeHtml(params: {
  firstName: string;
  storeName: string;
  prizeName: string;
  prizeDescription?: string;
  code: string;
  expiresAt: number;
  ticketUrl?: string;
}): string {
  const ticketButton = params.ticketUrl
    ? `<div style="text-align:center;margin:28px 0 8px;">
        <a href="${params.ticketUrl}" style="display:inline-block;background:#f97316;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 32px;border-radius:999px;">Voir mon ticket gagnant</a>
      </div>`
    : "";

  return `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"></head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#1a1a1a;margin:0;padding:0;background:#120d1a;">
    <div style="max-width:560px;margin:0 auto;padding:40px 20px;">
      <div style="background:#ffffff;border-radius:16px;overflow:hidden;">
        <div style="background:linear-gradient(135deg,#f97316,#fbbf24);padding:36px 40px;text-align:center;">
          <div style="font-size:44px;line-height:1;">🎉</div>
          <h1 style="margin:12px 0 0;font-size:24px;color:#ffffff;">Félicitations ${params.firstName} !</h1>
          <p style="margin:8px 0 0;font-size:15px;color:rgba(255,255,255,0.9);">Vous avez gagné chez ${params.storeName}</p>
        </div>
        <div style="padding:32px 40px;">
          <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:20px;text-align:center;">
            <p style="margin:0;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#9a3412;">Votre lot</p>
            <p style="margin:8px 0 0;font-size:20px;font-weight:700;color:#1a1a1a;">${params.prizeName}</p>
            ${params.prizeDescription ? `<p style="margin:6px 0 0;font-size:14px;color:#6b7280;">${params.prizeDescription}</p>` : ""}
          </div>
          <div style="margin:28px 0;text-align:center;">
            <p style="margin:0 0 10px;font-size:13px;color:#6b7280;">Présentez ce code au personnel du restaurant :</p>
            <div style="display:inline-block;background:#111827;border-radius:10px;padding:14px 28px;">
              <span style="font-family:'Courier New',monospace;font-size:26px;font-weight:700;letter-spacing:6px;color:#fbbf24;">${params.code}</span>
            </div>
          </div>
          ${ticketButton}
          <p style="margin:24px 0 0;font-size:13px;color:#9ca3af;text-align:center;">Valable jusqu'au ${formatDate(params.expiresAt)}. Une seule utilisation, sur place.</p>
        </div>
      </div>
      <p style="text-align:center;margin:20px 0 0;font-size:12px;color:#6b7280;">${params.storeName} — à très vite !</p>
    </div>
  </body>
</html>`;
}

export const sendPrizeEmail = internalAction({
  args: {
    toEmail: v.string(),
    firstName: v.string(),
    storeName: v.string(),
    prizeName: v.string(),
    prizeDescription: v.optional(v.string()),
    code: v.string(),
    expiresAt: v.number(),
  },
  handler: async (_ctx, args) => {
    const siteUrl = process.env.BID_APP_URL ?? process.env.SITE_URL ?? "";
    const ticketUrl = siteUrl
      ? `${siteUrl.replace(/\/$/, "")}/game/prize/${args.code}`
      : undefined;

    try {
      await sendViaSES({
        toEmail: args.toEmail,
        subject: `🎁 Votre lot chez ${args.storeName} — code ${args.code}`,
        htmlBody: buildPrizeHtml({ ...args, ticketUrl }),
        textBody: [
          `Félicitations ${args.firstName} !`,
          `Vous avez gagné : ${args.prizeName}`,
          `Votre code : ${args.code}`,
          ticketUrl ? `Votre ticket : ${ticketUrl}` : "",
          `Valable jusqu'au ${formatDate(args.expiresAt)}. Présentez ce code au personnel.`,
        ]
          .filter(Boolean)
          .join("\n"),
      });
      return { sent: true };
    } catch (error) {
      console.error("Échec envoi email lot gagné:", error);
      return { sent: false };
    }
  },
});

/**
 * Tell a diner their order is confirmed, and what they paid for.
 *
 * WHY THIS EXISTS: it did not. Five SES senders shipped — team invitations,
 * campaigns, maintenance notices, prizes, automations — and not one of them was
 * transactional. A guest paid and received nothing: no confirmation, no
 * receipt, no note of where to collect their food. This is the day-one support
 * call the product had built no answer to.
 *
 * Scheduled from `orders.markCashPaid` and `orders.internalUpdatePaymentStatus`
 * — the two seams where an order becomes paid — after
 * `planOrderConfirmation` has decided the diner qualifies and claimed the send
 * on the order. By the time this runs the decision is made; all that is left is
 * to render and hand it to SES.
 *
 * Best effort, and deliberately so: it is scheduled rather than awaited, so a
 * refused SES call cannot roll back a payment that has already been taken.
 */
export const sendOrderConfirmation = internalAction({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args): Promise<{ sent: boolean }> => {
    const payload = await ctx.runQuery(
      internal.orders.confirmationPayload,
      { orderId: args.orderId }
    );
    // The order, its establishment or its email went away between the mutation
    // claiming the send and this running. Nothing to do, and nothing wrong.
    if (!payload) {
      // The order was cancelled, refunded or deleted between the claim and
      // this running, or its establishment went away. Nothing to send, and the
      // claim goes back so a later legitimate settlement can still write.
      await ctx.runMutation(internal.orders.releaseConfirmationClaim, {
        orderId: args.orderId,
      });
      return { sent: false };
    }

    // `||`, not `??`: `emailConfig.fromEmail` is a required `v.string()` that
    // `upsert` accepts empty, and `??` would hand SES "" rather than falling
    // back to the deployment sender.
    const config = await ctx.runQuery(internal.emailConfig.getInternal, {
      // The payload crosses the query boundary as plain JSON, so the branded id
      // has to be reasserted. It is the order's own `storeId`, read a moment ago.
      storeId: payload.storeId as Id<"stores">,
    });
    const fromAddress =
      (config?.fromEmail as string | undefined) ||
      process.env.AWS_SES_FROM_EMAIL ||
      "";
    if (!fromAddress) {
      // Nothing was attempted, so the claim made in the settling mutation has
      // to go back: `AWS_SES_FROM_EMAIL` is a per-client onboarding step, so
      // "not set yet" is the day-one state of a new backend, and keeping the
      // claim would silence that establishment's very first confirmation for
      // ever — including after the address was configured.
      console.error(
        "[orderConfirmation] no sender address: neither the establishment's email config nor AWS_SES_FROM_EMAIL is set"
      );
      // The one failure an owner can fix themselves, so it is the one most worth
      // putting on the order (#530). No `detail`: nothing was attempted, so
      // there is no provider message to quote.
      await ctx.runMutation(internal.orders.releaseConfirmationClaim, {
        orderId: args.orderId,
        failure: { reason: "no_sender_address" },
      });
      return { sent: false };
    }
    const senderName = quoteDisplayName(
      (config?.senderName as string | undefined) || payload.email.store.name
    );
    const fromEmail = senderName ? `${senderName} <${fromAddress}>` : fromAddress;

    // The link to the live order page. Composed here rather than in the query
    // because `SITE_URL` is an environment variable and a Convex query has no
    // business reading one. Absent deployment URL or absent view token both
    // mean "no button", which the renderer handles.
    const siteUrl = (process.env.SITE_URL ?? process.env.BID_APP_URL ?? "").replace(/\/$/, "");
    const trackingUrl =
      siteUrl && payload.viewToken
        ? `${siteUrl}/order/${encodeURIComponent(payload.orderId)}?token=${encodeURIComponent(payload.viewToken)}`
        : undefined;

    const rendered = renderOrderConfirmation(
      { ...payload.email, trackingUrl },
      { timeZone: payload.timeZone }
    );

    try {
      await sendViaSES({
        toEmail: payload.toEmail,
        subject: sanitiseSubject(rendered.subject),
        htmlBody: rendered.html,
        textBody: rendered.text,
        fromEmail,
        replyToEmail:
          (config?.replyToEmail as string | undefined) || undefined,
      });
      return { sent: true };
    } catch (error) {
      // The claim goes back, for the reason the branch above already gives
      // about a missing sender: nothing was delivered, so holding the claim
      // silences this order's confirmation for ever. The diner has seen the
      // confirmation SCREEN, which is not the same thing — the email is what
      // carries the tracking link out of the browser session.
      //
      // Same reasoning as `sendOrderReady` on both counts: releasing is not
      // retrying, and there is no transient-versus-permanent sort to make,
      // because every refusal this product chooses is made before the claim.
      //
      // `error.message` and the order id, never the raw SDK error object.
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `[orderConfirmation] send failed for order ${args.orderId}:`,
        detail
      );
      // And the order says so, so an owner is no longer left comparing an
      // outage with a delivered receipt (#530). The same string the log gets:
      // the message, never the SDK object.
      await ctx.runMutation(internal.orders.releaseConfirmationClaim, {
        orderId: args.orderId,
        failure: { reason: "transport", detail },
      });
      return { sent: false };
    }
  },
});

/**
 * « Votre commande est prête » (#96).
 *
 * Scheduled from `orders.updateStatus` — the one seam every status change goes
 * through — after `planOrderReady` has decided the diner qualifies and claimed
 * the send on the order. By the time this runs the decision is made; all that is
 * left is to render and hand it to the transport.
 *
 * WHAT IT DOES NOT DO. It does not fire on `preparing`, `out_for_delivery` or
 * `completed`, and it never fires on a delivery order — see
 * `convex-functions/orderReady.ts` for both decisions. One email, at the one
 * moment the diner has to act.
 *
 * Best effort, like the confirmation beside it: scheduled rather than awaited, so
 * a refused send cannot roll back a status the kitchen has already moved.
 */
export const sendOrderReady = internalAction({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args): Promise<{ sent: boolean }> => {
    const payload = await ctx.runQuery(internal.orders.readyNoticePayload, {
      orderId: args.orderId,
    });
    if (!payload) {
      // Cancelled, deleted, or its establishment gone between the claim and
      // this running. The claim goes back so a later legitimate `ready` can
      // still write.
      await ctx.runMutation(internal.orders.releaseReadyNoticeClaim, {
        orderId: args.orderId,
      });
      return { sent: false };
    }

    const config = await ctx.runQuery(internal.emailConfig.getInternal, {
      storeId: payload.storeId as Id<"stores">,
    });
    // `||`, not `??`: `fromEmail` is a required `v.string()` that `upsert`
    // accepts empty.
    const fromAddress =
      (config?.fromEmail as string | undefined) ||
      process.env.AWS_SES_FROM_EMAIL ||
      "";
    if (!fromAddress) {
      console.error(
        "[orderReady] no sender address: neither the establishment's email config nor AWS_SES_FROM_EMAIL is set"
      );
      // Put on the order, as the confirmation's is (#530).
      await ctx.runMutation(internal.orders.releaseReadyNoticeClaim, {
        orderId: args.orderId,
        failure: { reason: "no_sender_address" },
      });
      return { sent: false };
    }

    const senderName = quoteDisplayName(
      (config?.senderName as string | undefined) || payload.email.store.name
    );
    const fromEmail = senderName ? `${senderName} <${fromAddress}>` : fromAddress;

    const siteUrl = (process.env.SITE_URL ?? process.env.BID_APP_URL ?? "").replace(
      /\/$/,
      ""
    );
    const trackingUrl =
      siteUrl && payload.viewToken
        ? `${siteUrl}/order/${encodeURIComponent(payload.orderId)}?token=${encodeURIComponent(payload.viewToken)}`
        : undefined;

    const rendered = renderOrderReady(
      { ...payload.email, ...(trackingUrl ? { trackingUrl } : {}) } as never,
      { timeZone: payload.timeZone }
    );

    try {
      await sendViaSES({
        toEmail: payload.toEmail,
        subject: sanitiseSubject(rendered.subject),
        htmlBody: rendered.html,
        textBody: rendered.text,
        fromEmail,
        replyToEmail: (config?.replyToEmail as string | undefined) || undefined,
      });
      return { sent: true };
    } catch (error) {
      // THE CLAIM GOES BACK. `readyEmailAt` was stamped transactionally before
      // SES was called, and keeping it here is the one outcome that loses the
      // notice for ever — silently, and looking exactly like a sent mail to the
      // owner and to the diner alike.
      //
      // The previous comment argued against "a scheduled function retrying
      // against a provider that already refused it". Releasing is not retrying:
      // nothing reschedules this action, and the claim only makes a LATER
      // legitimate `ready` transition able to send. The fear was real and it
      // was about a different act.
      //
      // NOT SORTED INTO TRANSIENT AND PERMANENT, deliberately, and the reason
      // is that the set to exclude is empty here. Every refusal this product
      // CHOOSES is made before the claim, by `orderReadyRefusal` — no address,
      // a suppressed address, cancelled, delivery — so what is left to reach
      // this catch is the transport failing, and an outage is not a refusal.
      // The `deliberateSettlementRefusal` pattern exists because a payment
      // webhook must answer 2xx or 5xx on the strength of that distinction.
      // Nothing here consumes it.
      //
      // WHAT IT COSTS, stated rather than discovered later: if SES accepted the
      // message and only the response was lost, the claim goes back over a mail
      // that was delivered, and staff moving the order out of `ready` and back
      // would send a second one. A duplicate « c'est prêt » is a smaller harm
      // than a diner never told, and it takes a human to produce.
      //
      // `error.message` and the order id, never the raw SDK error: some SES
      // rejections carry the recipient's address inside the object, and this
      // line lands in a log an operator reads.
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `[orderReady] send failed for order ${args.orderId}:`,
        detail
      );
      // And the order says so (#530), with the same string the log gets.
      await ctx.runMutation(internal.orders.releaseReadyNoticeClaim, {
        orderId: args.orderId,
        failure: { reason: "transport", detail },
      });
      return { sent: false };
    }
  },
});

/**
 * Tell a guest where their table booking stands.
 *
 * Scheduled from the reservation mutations (`create`, `setStatus`,
 * `cancelByToken`, `modifyByToken`, `updateByStaff`) after `planReservationNotice`
 * has decided the guest qualifies and claimed the send on the booking. By the time this runs the decision is
 * made; all that is left is to render and hand it to the transport.
 *
 * Best effort, like the order notices beside it: scheduled rather than awaited,
 * so a refused send cannot roll back a booking that has been made. A send that
 * could not be attempted, or that the provider refused, gives its claim back
 * and records why on the booking — releasing is not retrying: nothing
 * reschedules this action.
 */
export const sendReservationNotice = internalAction({
  args: {
    reservationId: v.id("reservations"),
    kind: v.union(
      v.literal("pending"),
      v.literal("confirmed"),
      v.literal("declined"),
      v.literal("cancelled_by_restaurant"),
      v.literal("cancelled_by_guest"),
      v.literal("reminder"),
      v.literal("modified"),
      v.literal("modified_restaurant"),
      v.literal("post_visit"),
      v.literal("payment_refunded"),
      v.literal("fee_charged"),
      v.literal("payment_failed"),
      v.literal("payment_failed_restaurant"),
      v.literal("group_received"),
      v.literal("group_approved"),
      v.literal("group_declined"),
      v.literal("group_counter"),
      v.literal("group_expired"),
    ),
  },
  handler: async (ctx, args): Promise<{ sent: boolean }> => {
    const payload = await ctx.runQuery(internal.reservations.noticePayload, {
      reservationId: args.reservationId,
      kind: args.kind,
    });
    if (!payload) {
      // The booking moved on, or was erased, between the claim and this running
      // (confirmed, then cancelled before the mail went out). Nothing is true to
      // say, and the claim goes back so the notice that is true can still write.
      await ctx.runMutation(internal.reservations.releaseNoticeClaim, {
        reservationId: args.reservationId,
        kind: args.kind,
      });
      return { sent: false };
    }

    // Config lookup and rendering sit inside the same guard as the send: a
    // throw from either would otherwise leave the notice claimed and never sent.
    try {
      const config = await ctx.runQuery(internal.emailConfig.getInternal, {
        storeId: payload.storeId as Id<"stores">,
      });
      // `||`, not `??`: `fromEmail` is a required `v.string()` that `upsert`
      // accepts empty.
      const fromAddress =
        (config?.fromEmail as string | undefined) || process.env.AWS_SES_FROM_EMAIL || "";
      if (!fromAddress) {
        console.error(
          "[reservationNotice] no sender address: neither the establishment's email config nor AWS_SES_FROM_EMAIL is set",
        );
        await ctx.runMutation(internal.reservations.releaseNoticeClaim, {
          reservationId: args.reservationId,
          kind: args.kind,
          failure: { reason: "no_sender_address" },
        });
        return { sent: false };
      }

      const senderName = quoteDisplayName(
        (config?.senderName as string | undefined) || payload.email.store.name,
      );
      const fromEmail = senderName ? `${senderName} <${fromAddress}>` : fromAddress;

      const siteUrl = (process.env.SITE_URL ?? process.env.BID_APP_URL ?? "").replace(/\/$/, "");
      const manageUrl = siteUrl
        ? `${siteUrl}/reservation/manage/${encodeURIComponent(payload.manageToken)}`
        : undefined;

      // The thank-you is only worth sending with somewhere to answer: the five scores
      // are links to the guest's own page, and a mail with none asks for nothing.
      const feedbackUrl =
        args.kind === "post_visit" && siteUrl
          ? `${siteUrl}/reservation/feedback/${encodeURIComponent(payload.manageToken)}`
          : undefined;
      if (args.kind === "post_visit" && !feedbackUrl) {
        console.error("[reservationNotice] post_visit not sent: SITE_URL is not set");
        await ctx.runMutation(internal.reservations.releaseNoticeClaim, {
          reservationId: args.reservationId,
          kind: args.kind,
          failure: { reason: "transport", detail: "SITE_URL n'est pas renseigné" },
        });
        return { sent: false };
      }

      // A group the host accepted with a deposit is not confirmed until it is paid: the mail
      // is only worth sending with the payment page to go to, as the thank-you is with its
      // five scores.
      const payUrl =
        args.kind === "group_approved" && payload.email.group?.awaitingPayment && siteUrl
          ? `${siteUrl}/reservation/payment/${encodeURIComponent(payload.manageToken)}`
          : undefined;
      if (args.kind === "group_approved" && payload.email.group?.awaitingPayment && !payUrl) {
        console.error("[reservationNotice] group_approved not sent: SITE_URL is not set");
        await ctx.runMutation(internal.reservations.releaseNoticeClaim, {
          reservationId: args.reservationId,
          kind: args.kind,
          failure: { reason: "transport", detail: "SITE_URL n'est pas renseigné" },
        });
        return { sent: false };
      }

      const rendered = renderReservationNotice(
        {
          ...payload.email,
          ...(manageUrl ? { manageUrl } : {}),
          ...(feedbackUrl ? { feedbackUrl } : {}),
          ...(payUrl ? { payUrl } : {}),
        },
        { timeZone: payload.timeZone },
      );

      await sendViaSES({
        toEmail: payload.toEmail,
        subject: sanitiseSubject(rendered.subject),
        htmlBody: rendered.html,
        textBody: rendered.text,
        fromEmail,
        // The establishment's own copy: answering it writes to the guest.
        replyToEmail:
          (args.kind === "modified_restaurant" || args.kind === "payment_failed_restaurant"
            ? payload.email.guestEmail
            : (config?.replyToEmail as string | undefined)) || undefined,
      });
      return { sent: true };
    } catch (error) {
      // `error.message` and the booking id, never the raw SDK error: some SES
      // rejections carry the recipient's address inside the object, and this line
      // lands in a log an operator reads.
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `[reservationNotice] ${args.kind} send failed for booking ${args.reservationId}:`,
        detail,
      );
      await ctx.runMutation(internal.reservations.releaseNoticeClaim, {
        reservationId: args.reservationId,
        kind: args.kind,
        failure: { reason: "transport", detail },
      });
      return { sent: false };
    }
  },
});

/**
 * Tell a waitlisted guest a table has freed up for them.
 *
 * Scheduled by every transaction that made an offer (`matchWaitlist`), after it
 * claimed the send on the entry. All that is left is to read the offer again — it
 * may have lapsed, been claimed or been withdrawn in between, in which case there
 * is nothing true to say — render it and hand it to the transport.
 *
 * Best effort, like the booking notices: an offer nobody could be told about holds
 * a table for no one, so a failed send gives the offer back (the entry returns to
 * waiting, the hold is released) and records why for the host to see.
 */
export const sendWaitlistOffer = internalAction({
  args: { waitlistEntryId: v.id("waitlistEntries") },
  handler: async (ctx, args): Promise<{ sent: boolean }> => {
    const payload = await ctx.runQuery(internal.reservationWaitlist.offerPayload, {
      waitlistEntryId: args.waitlistEntryId,
    });
    if (!payload) {
      await ctx.runMutation(internal.reservationWaitlist.releaseOfferClaim, {
        waitlistEntryId: args.waitlistEntryId,
      });
      return { sent: false };
    }

    try {
      const config = await ctx.runQuery(internal.emailConfig.getInternal, {
        storeId: payload.storeId as Id<"stores">,
      });
      const fromAddress =
        (config?.fromEmail as string | undefined) || process.env.AWS_SES_FROM_EMAIL || "";
      if (!fromAddress) {
        console.error(
          "[waitlistOffer] no sender address: neither the establishment's email config nor AWS_SES_FROM_EMAIL is set",
        );
        await ctx.runMutation(internal.reservationWaitlist.releaseOfferClaim, {
          waitlistEntryId: args.waitlistEntryId,
          failure: { reason: "no_sender_address" },
        });
        return { sent: false };
      }

      const senderName = quoteDisplayName(
        (config?.senderName as string | undefined) || payload.store.name,
      );
      const fromEmail = senderName ? `${senderName} <${fromAddress}>` : fromAddress;
      const siteUrl = (process.env.SITE_URL ?? process.env.BID_APP_URL ?? "").replace(/\/$/, "");
      const offerUrl = siteUrl
        ? `${siteUrl}/reservation/waitlist/${encodeURIComponent(payload.token)}`
        : undefined;

      const rendered = renderWaitlistOffer(
        {
          guestName: payload.guestName,
          partySize: payload.partySize,
          startsAt: payload.startsAt,
          expiresAt: payload.expiresAt,
          minutes: payload.minutes,
          store: payload.store,
          ...(offerUrl ? { offerUrl } : {}),
        },
        { timeZone: payload.timeZone },
      );

      await sendViaSES({
        toEmail: payload.toEmail,
        subject: sanitiseSubject(rendered.subject),
        htmlBody: rendered.html,
        textBody: rendered.text,
        fromEmail,
        replyToEmail: (config?.replyToEmail as string | undefined) || undefined,
      });
      return { sent: true };
    } catch (error) {
      // `error.message` and the entry id, never the raw SDK error: some SES
      // rejections carry the recipient's address inside the object.
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `[waitlistOffer] send failed for entry ${args.waitlistEntryId}:`,
        detail,
      );
      await ctx.runMutation(internal.reservationWaitlist.releaseOfferClaim, {
        waitlistEntryId: args.waitlistEntryId,
        failure: { reason: "transport", detail },
      });
      return { sent: false };
    }
  },
});

/**
 * Mail a waitlist entry's own link to the address stored on it.
 *
 * Scheduled by `reservationWaitlist.join` after it claimed the send (`linkNoticeAt`). The
 * entry's token is never returned to the caller of `join`: whoever typed the address proved
 * nothing, so the credential goes only where the guest can read it. A failed send gives the
 * claim back, so the guest's next try is mailed at once.
 */
export const sendWaitlistLink = internalAction({
  args: { waitlistEntryId: v.id("waitlistEntries") },
  handler: async (ctx, args): Promise<{ sent: boolean }> => {
    const payload = await ctx.runQuery(internal.reservationWaitlist.linkPayload, {
      waitlistEntryId: args.waitlistEntryId,
    });
    if (!payload) {
      await ctx.runMutation(internal.reservationWaitlist.releaseLinkClaim, {
        waitlistEntryId: args.waitlistEntryId,
      });
      return { sent: false };
    }
    try {
      const config = await ctx.runQuery(internal.emailConfig.getInternal, {
        storeId: payload.storeId as Id<"stores">,
      });
      const fromAddress =
        (config?.fromEmail as string | undefined) || process.env.AWS_SES_FROM_EMAIL || "";
      if (!fromAddress) {
        console.error(
          "[waitlistLink] no sender address: neither the establishment's email config nor AWS_SES_FROM_EMAIL is set",
        );
        await ctx.runMutation(internal.reservationWaitlist.releaseLinkClaim, {
          waitlistEntryId: args.waitlistEntryId,
          failure: { reason: "no_sender_address" },
        });
        return { sent: false };
      }
      const senderName = quoteDisplayName(
        (config?.senderName as string | undefined) || payload.store.name,
      );
      const fromEmail = senderName ? `${senderName} <${fromAddress}>` : fromAddress;
      const siteUrl = (process.env.SITE_URL ?? process.env.BID_APP_URL ?? "").replace(/\/$/, "");
      const rendered = renderWaitlistLink({
        guestName: payload.guestName,
        partySize: payload.partySize,
        date: payload.date,
        store: payload.store,
        ...(siteUrl
          ? { pageUrl: `${siteUrl}/reservation/waitlist/${encodeURIComponent(payload.token)}` }
          : {}),
      });
      await sendViaSES({
        toEmail: payload.toEmail,
        subject: sanitiseSubject(rendered.subject),
        htmlBody: rendered.html,
        textBody: rendered.text,
        fromEmail,
        replyToEmail: (config?.replyToEmail as string | undefined) || undefined,
      });
      return { sent: true };
    } catch (error) {
      // `error.message` and the entry id, never the raw SDK error: some SES rejections
      // carry the recipient's address inside the object.
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[waitlistLink] send failed for entry ${args.waitlistEntryId}:`, detail);
      await ctx.runMutation(internal.reservationWaitlist.releaseLinkClaim, {
        waitlistEntryId: args.waitlistEntryId,
        failure: { reason: "transport", detail },
      });
      return { sent: false };
    }
  },
});

/**
 * Tell a guest that seats came back at a sold-out event they asked about.
 *
 * Scheduled by `reservationExperiences.mailSeatAlerts` after it claimed the send on the
 * entry. Read again here — the event may have been cancelled in between — rendered and
 * handed to the transport. Best effort: a send that could not be attempted gives its claim
 * back, which retries the entry an hour later; nothing is held for the guest either way.
 */
export const sendExperienceSeatAlert = internalAction({
  args: { waitlistEntryId: v.id("waitlistEntries") },
  handler: async (ctx, args): Promise<{ sent: boolean }> => {
    const payload = await ctx.runQuery(internal.reservationExperiences.alertPayload, {
      waitlistEntryId: args.waitlistEntryId,
    });
    if (!payload) {
      await ctx.runMutation(internal.reservationExperiences.releaseAlertClaim, {
        waitlistEntryId: args.waitlistEntryId,
      });
      return { sent: false };
    }
    try {
      const config = await ctx.runQuery(internal.emailConfig.getInternal, {
        storeId: payload.storeId as Id<"stores">,
      });
      const fromAddress =
        (config?.fromEmail as string | undefined) || process.env.AWS_SES_FROM_EMAIL || "";
      if (!fromAddress) {
        console.error(
          "[experienceAlert] no sender address: neither the establishment's email config nor AWS_SES_FROM_EMAIL is set",
        );
        await ctx.runMutation(internal.reservationExperiences.releaseAlertClaim, {
          waitlistEntryId: args.waitlistEntryId,
          failure: { reason: "no_sender_address" },
        });
        return { sent: false };
      }
      const senderName = quoteDisplayName(
        (config?.senderName as string | undefined) || payload.store.name,
      );
      const fromEmail = senderName ? `${senderName} <${fromAddress}>` : fromAddress;
      const siteUrl = (process.env.SITE_URL ?? process.env.BID_APP_URL ?? "").replace(/\/$/, "");
      const rendered = renderExperienceSeatsFreed(
        {
          guestName: payload.guestName,
          title: payload.title,
          startsAt: payload.startsAt,
          store: payload.store,
          ...(siteUrl ? { eventUrl: `${siteUrl}/reservation#events` } : {}),
        },
        { timeZone: payload.timeZone },
      );
      await sendViaSES({
        toEmail: payload.toEmail,
        subject: sanitiseSubject(rendered.subject),
        htmlBody: rendered.html,
        textBody: rendered.text,
        fromEmail,
        replyToEmail: (config?.replyToEmail as string | undefined) || undefined,
      });
      return { sent: true };
    } catch (error) {
      // `error.message` and the entry id, never the raw SDK error: some SES rejections
      // carry the recipient's address inside the object.
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[experienceAlert] send failed for entry ${args.waitlistEntryId}:`, detail);
      await ctx.runMutation(internal.reservationExperiences.releaseAlertClaim, {
        waitlistEntryId: args.waitlistEntryId,
        failure: { reason: "transport", detail },
      });
      return { sent: false };
    }
  },
});

/**
 * Send the team the daily report of the book.
 *
 * Scheduled by `reservationAutomations.sendDue` after it claimed the day's report. All
 * that is left is to read it (the book may have changed in between, and the owner may
 * have turned the report off), render it and send it to each recipient on its own: the
 * addresses of colleagues are nobody's business but the sender's.
 *
 * Best effort. The claim is given back when NO recipient could be reached, so the next
 * quarter-hour sweep tries again inside the catch-up window; one reached recipient is
 * a report sent.
 */
export const sendDailyReport = internalAction({
  args: { storeId: v.id("stores"), date: v.string() },
  handler: async (ctx, args): Promise<{ sent: number }> => {
    const buildReport = () =>
      ctx.runQuery(internal.reservationAutomations.reportPayload, {
        storeId: args.storeId,
        date: args.date,
      });
    let payload: Awaited<ReturnType<typeof buildReport>> = null;
    try {
      payload = await buildReport();
    } catch (error) {
      // The book could not be read (a day too busy, a refusal): give the claim back so the
      // next quarter of an hour tries again inside the catch-up window, and say why.
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[dailyReport] report not built for store ${args.storeId}:`, detail);
      await ctx.runMutation(internal.reservationAutomations.releaseReportClaim, {
        storeId: args.storeId,
        date: args.date,
        failure: { reason: "transport", detail },
      });
      return { sent: 0 };
    }
    if (!payload) {
      await ctx.runMutation(internal.reservationAutomations.releaseReportClaim, {
        storeId: args.storeId,
        date: args.date,
      });
      return { sent: 0 };
    }

    try {
      const config = await ctx.runQuery(internal.emailConfig.getInternal, {
        storeId: args.storeId,
      });
      const fromAddress =
        (config?.fromEmail as string | undefined) || process.env.AWS_SES_FROM_EMAIL || "";
      if (!fromAddress) {
        console.error(
          "[dailyReport] no sender address: neither the establishment's email config nor AWS_SES_FROM_EMAIL is set",
        );
        await ctx.runMutation(internal.reservationAutomations.releaseReportClaim, {
          storeId: args.storeId,
          date: args.date,
          failure: { reason: "no_sender_address" },
        });
        return { sent: 0 };
      }
      const senderName = quoteDisplayName(
        (config?.senderName as string | undefined) || payload.input.store.name,
      );
      const fromEmail = senderName ? `${senderName} <${fromAddress}>` : fromAddress;
      const siteUrl = (process.env.SITE_URL ?? process.env.BID_APP_URL ?? "").replace(/\/$/, "");
      const rendered = renderDailyReport({
        ...payload.input,
        ...(siteUrl
          ? {
              bookUrl: `${siteUrl}/dashboard/reservations`,
              settingsUrl: `${siteUrl}/dashboard/reservations/settings`,
            }
          : {}),
      });

      let sent = 0;
      let lastError = "";
      for (const toEmail of payload.toEmails) {
        try {
          await sendViaSES({
            toEmail,
            subject: sanitiseSubject(rendered.subject),
            htmlBody: rendered.html,
            textBody: rendered.text,
            fromEmail,
          });
          sent += 1;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      if (sent === 0) {
        console.error(`[dailyReport] send failed for store ${args.storeId}:`, lastError);
        await ctx.runMutation(internal.reservationAutomations.releaseReportClaim, {
          storeId: args.storeId,
          date: args.date,
          failure: { reason: "transport", detail: lastError },
        });
      }
      return { sent };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[dailyReport] send failed for store ${args.storeId}:`, detail);
      await ctx.runMutation(internal.reservationAutomations.releaseReportClaim, {
        storeId: args.storeId,
        date: args.date,
        failure: { reason: "transport", detail },
      });
      return { sent: 0 };
    }
  },
});

/**
 * Send the team the alerts the sweep just claimed, in one message per recipient.
 *
 * The alerts are read again here: one whose cause was settled since the claim is
 * dropped, and a digest left with nothing is not sent. A failed send is NOT retried —
 * the alerts are still in the centre on the reservation screens.
 */
export const sendAlertDigest = internalAction({
  args: { storeId: v.id("stores"), keys: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ sent: number }> => {
    const payload = await ctx.runQuery(internal.reservationAlerts.digestPayload, {
      storeId: args.storeId,
      keys: args.keys,
    });
    if (!payload) return { sent: 0 };

    try {
      const config = await ctx.runQuery(internal.emailConfig.getInternal, {
        storeId: args.storeId,
      });
      const fromAddress =
        (config?.fromEmail as string | undefined) || process.env.AWS_SES_FROM_EMAIL || "";
      if (!fromAddress) {
        console.error("[alertDigest] no sender address: the alerts stay in the centre");
        return { sent: 0 };
      }
      const senderName = quoteDisplayName(
        (config?.senderName as string | undefined) || payload.storeName,
      );
      const fromEmail = senderName ? `${senderName} <${fromAddress}>` : fromAddress;
      const siteUrl = (process.env.SITE_URL ?? process.env.BID_APP_URL ?? "").replace(/\/$/, "");
      const rendered = renderAlertDigest({
        store: { name: payload.storeName },
        alerts: payload.alerts,
        ...(siteUrl ? { bookUrl: `${siteUrl}/dashboard/reservations` } : {}),
      });

      let sent = 0;
      for (const toEmail of payload.toEmails) {
        try {
          await sendViaSES({
            toEmail,
            subject: sanitiseSubject(rendered.subject),
            htmlBody: rendered.html,
            textBody: rendered.text,
            fromEmail,
          });
          sent += 1;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          console.error(`[alertDigest] send failed for store ${args.storeId}:`, detail);
        }
      }
      return { sent };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[alertDigest] send failed for store ${args.storeId}:`, detail);
      return { sent: 0 };
    }
  },
});
