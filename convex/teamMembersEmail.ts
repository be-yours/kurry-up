"use node";

import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { sendFromDeployment } from "./emailTransport";
import { randomUUID } from "crypto";

const ROLE_LABELS: Record<string, string> = {
  manager: "Manager",
  kitchen: "Cuisine",
  waiter: "Serveur",
  delivery: "Livreur",
};

/**
 * Send an email using AWS SES v2 SDK
 */
/**
 * READS THE OUTCOME, AND THROWS WHEN THE SEND FAILED (#631).
 *
 * `sendFromDeployment` is best-effort BY CONTRACT: it reports
 * `{ sent: false, error }` rather than throwing, because its other callers are
 * scheduled actions where an exception abandons a batch mid-campaign. Its own
 * docstring warns « Callers are expected to READ the result — four of them
 * historically did not ».
 *
 * This was one of them. The call sites here wrap the `await` in a `try` and set
 * `emailSent = true` when nothing throws — and nothing ever throws, so the flag
 * could not go false and the admin reported « Invitation envoyée » whatever the
 * provider did.
 *
 * Throwing HERE rather than returning the outcome is deliberate: it makes every
 * existing call site correct without each one having to remember, and the
 * shape it produces (a `catch` that logs and leaves the flag false) is the one
 * those call sites already have. `customerEmail.ts` made the same choice for
 * the same reason.
 */
/**
 * One invitation, through whichever provider this deployment uses.
 *
 * Was an inline `SESv2Client` plus a `noreply@beindigital.fr` fallback —
 * the agency's address, which a client's own SES account cannot sign for. Both
 * now come from `emailTransport`, which reads `EMAIL_PROVIDER` (#212).
 */
async function sendViaSES(params: {
  toEmail: string;
  subject: string;
  htmlBody: string;
  textBody: string;
}) {
  const outcome = await sendFromDeployment({
    to: params.toEmail,
    subject: params.subject,
    html: params.htmlBody,
    text: params.textBody,
  });
  if (!outcome.sent) {
    throw new Error(outcome.error ?? "l'envoi a échoué");
  }
  return outcome;
}

/**
 * Build invitation HTML email
 */
function buildInvitationHtml(
  name: string,
  storeName: string,
  role: string,
  allStores: boolean,
  inviteUrl: string
) {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a1a1a; margin: 0; padding: 0; background: #f5f5f5; }
      .container { max-width: 560px; margin: 0 auto; padding: 40px 20px; }
      .card { background: white; border-radius: 12px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
      .header { text-align: center; margin-bottom: 32px; }
      .header h1 { margin: 0; font-size: 24px; color: #1a1a1a; }
      .info { background: #f8f9fa; border-radius: 8px; padding: 16px; margin: 24px 0; }
      .info-row { padding: 6px 0; font-size: 14px; overflow: hidden; }
      .info-label { color: #6b7280; }
      .info-value { font-weight: 600; float: right; }
      .button { display: block; width: fit-content; margin: 32px auto; padding: 14px 32px; background: #18181b; color: white !important; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px; }
      .footer { text-align: center; margin-top: 24px; color: #9ca3af; font-size: 13px; }
      .expire { text-align: center; color: #6b7280; font-size: 13px; margin-top: 16px; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="card">
        <div class="header">
          <h1>Invitation à rejoindre l'équipe</h1>
        </div>
        <p>Bonjour <strong>${name}</strong>,</p>
        <p>Vous avez été invité(e) à rejoindre l'équipe de <strong>${storeName}</strong>.</p>
        <div class="info">
          <div class="info-row">
            <span class="info-label">Restaurant</span>
            <span class="info-value">${storeName}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Rôle</span>
            <span class="info-value">${ROLE_LABELS[role] ?? role}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Périmètre</span>
            <span class="info-value">${allStores ? "Tous les établissements" : "1 établissement"}</span>
          </div>
        </div>
        <a href="${inviteUrl}" class="button">Accepter l'invitation</a>
        <p class="expire">Ce lien est valable pendant 7 jours.</p>
      </div>
      <p class="footer">
        Cet email a été envoyé par BeYours.<br>
        Si vous n'attendiez pas cette invitation, ignorez cet email.
      </p>
    </div>
  </body>
</html>`;
}

/**
 * Build reminder HTML email
 */
function buildReminderHtml(
  name: string,
  storeName: string,
  role: string,
  inviteUrl: string
) {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a1a1a; margin: 0; padding: 0; background: #f5f5f5; }
      .container { max-width: 560px; margin: 0 auto; padding: 40px 20px; }
      .card { background: white; border-radius: 12px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
      .header { text-align: center; margin-bottom: 32px; }
      .header h1 { margin: 0; font-size: 24px; color: #1a1a1a; }
      .button { display: block; width: fit-content; margin: 32px auto; padding: 14px 32px; background: #18181b; color: white !important; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px; }
      .footer { text-align: center; margin-top: 24px; color: #9ca3af; font-size: 13px; }
      .expire { text-align: center; color: #6b7280; font-size: 13px; margin-top: 16px; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="card">
        <div class="header">
          <h1>Rappel d'invitation</h1>
        </div>
        <p>Bonjour <strong>${name}</strong>,</p>
        <p>Pour rappel, vous avez été invité(e) à rejoindre l'équipe de <strong>${storeName}</strong> en tant que <strong>${ROLE_LABELS[role] ?? role}</strong>.</p>
        <a href="${inviteUrl}" class="button">Accepter l'invitation</a>
        <p class="expire">Ce lien est valable pendant 7 jours.</p>
      </div>
      <p class="footer">
        Cet email a été envoyé par BeYours.<br>
        Si vous n'attendiez pas cette invitation, ignorez cet email.
      </p>
    </div>
  </body>
</html>`;
}

// === ACTIONS ===

/**
 * Send team invitation email via AWS SES and create the team member record.
 */
// @guarded-inline: runs teamMembers.internalAssertCanManage, the roster policy
export const sendInvitationEmail = action({
  args: {
    storeId: v.optional(v.id("stores")),
    allStores: v.boolean(),
    name: v.string(),
    email: v.string(),
    role: v.union(
      v.literal("manager"),
      v.literal("kitchen"),
      v.literal("waiter"),
      v.literal("delivery")
    ),
    permissions: v.array(v.string()),
    storeName: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    // Being logged in is not enough: this reaches the roster through
    // `inviteInternal`, so without this check any account could invite itself
    // as manager on any store — or chain-wide.
    await ctx.runQuery(internal.teamMembers.internalAssertCanManage, {
      storeId: args.storeId,
      allStores: args.allStores,
    });

    const token = randomUUID();

    // Create the team member record with pending status
    await ctx.runMutation(internal.teamMembers.inviteInternal, {
      storeId: args.storeId,
      allStores: args.allStores,
      name: args.name,
      email: args.email,
      role: args.role,
      permissions: args.permissions,
      invitationToken: token,
    });

    // Build invitation URL
    const appUrl =
      process.env.SITE_URL ??
      process.env.NEXT_PUBLIC_APP_URL ??
      "https://app.beindigital.fr";
    const inviteUrl = `${appUrl}/invite/${token}`;

    const htmlBody = buildInvitationHtml(
      args.name,
      args.storeName,
      args.role,
      args.allStores,
      inviteUrl
    );

    const textBody = [
      `Bonjour ${args.name},`,
      "",
      `Vous avez été invité(e) à rejoindre l'équipe de ${args.storeName} en tant que ${ROLE_LABELS[args.role] ?? args.role}.`,
      "",
      `Acceptez l'invitation : ${inviteUrl}`,
      "",
      "Ce lien est valable pendant 7 jours.",
      "",
      "-- BeYours",
    ].join("\n");

    // Try to send email - don't fail if email sending fails
    let emailSent = false;
    try {
      await sendViaSES({
        toEmail: args.email,
        subject: `Invitation a rejoindre ${args.storeName}`,
        htmlBody,
        textBody,
      });
      emailSent = true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Failed to send invitation email:", message);
    }

    return { success: true, token, emailSent };
  },
});

/**
 * Resend invitation email to a pending team member.
 */
// @guarded-inline: runs teamMembers.internalAssertCanManageMember
export const resendInvitationEmail = action({
  args: {
    memberId: v.id("teamMembers"),
    storeName: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    await ctx.runQuery(internal.teamMembers.internalAssertCanManageMember, {
      id: args.memberId,
    });

    const newToken = randomUUID();

    // Update the member record with new token
    await ctx.runMutation(internal.teamMembers.resendInvitationInternal, {
      id: args.memberId,
      newToken,
    });

    // Get the member details
    const member = await ctx.runQuery(internal.teamMembers.getById, {
      id: args.memberId,
    });

    if (!member) throw new Error("Team member not found");

    const appUrl =
      process.env.SITE_URL ??
      process.env.NEXT_PUBLIC_APP_URL ??
      "https://app.beindigital.fr";
    const inviteUrl = `${appUrl}/invite/${newToken}`;

    const htmlBody = buildReminderHtml(
      member.name,
      args.storeName,
      member.role,
      inviteUrl
    );

    const textBody = [
      `Bonjour ${member.name},`,
      "",
      `Pour rappel, vous avez été invité(e) à rejoindre l'équipe de ${args.storeName} en tant que ${ROLE_LABELS[member.role] ?? member.role}.`,
      "",
      `Acceptez l'invitation : ${inviteUrl}`,
      "",
      "Ce lien est valable pendant 7 jours.",
      "",
      "-- BeYours",
    ].join("\n");

    let emailSent = false;
    try {
      await sendViaSES({
        toEmail: member.email,
        subject: `Rappel : Invitation a rejoindre ${args.storeName}`,
        htmlBody,
        textBody,
      });
      emailSent = true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Failed to resend invitation email:", message);
    }

    return { success: true, emailSent };
  },
});
