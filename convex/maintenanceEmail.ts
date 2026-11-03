"use node";

/**
 * Maintenance Email Notifications (AWS SES)
 *
 * Best-effort notifications around the migration request flow:
 * - alert the BeYours team (BID_NOTIFY_EMAIL) when a client requests
 *   the migration of their site;
 * - send the client a confirmation that the request was received.
 *
 * Scheduled from maintenance.requestMigration via ctx.scheduler — a
 * delivery failure never blocks the request itself.
 */

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { sendFromDeployment } from "./emailTransport";

const SCOPE_LABELS: Record<string, string> = {
  code: "Code du site",
  database: "Base de données",
  assets: "Médias & fichiers (S3)",
  domain: "Nom de domaine",
  emails: "Emails & templates",
};

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
 * A migration notice, through whichever provider this deployment uses.
 *
 * See `emailTransport` — this was an inline client and the agency's
 * `noreply@` fallback, repeated in four files (#212).
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

interface MigrationRequestEmailData {
  requestId: string;
  requestedBy: string;
  contactEmail: string;
  contactPhone?: string;
  targetProvider: string;
  targetTeam?: string;
  targetTeamEmail?: string;
  scope: string[];
  preferredDate?: number;
  notes?: string;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function describeRequestLines(data: MigrationRequestEmailData): string[] {
  const lines = [
    `Destination : ${data.targetProvider}`,
    `Éléments à migrer : ${data.scope
      .map((s) => SCOPE_LABELS[s] ?? s)
      .join(", ")}`,
    `Contact : ${data.contactEmail}${data.contactPhone ? ` / ${data.contactPhone}` : ""}`,
  ];
  if (data.targetTeam) {
    lines.push(
      `Équipe repreneuse : ${data.targetTeam}${data.targetTeamEmail ? ` (${data.targetTeamEmail})` : ""}`,
    );
  }
  if (data.preferredDate) {
    lines.push(`Date souhaitée : ${formatDate(data.preferredDate)}`);
  }
  if (data.notes) {
    lines.push(`Précisions : ${data.notes}`);
  }
  return lines;
}

function buildSimpleHtml(title: string, intro: string, lines: string[], footer: string): string {
  const rows = lines
    .map(
      (line) =>
        `<div style="padding:6px 0;font-size:14px;border-bottom:1px solid #f0f0f0;">${line}</div>`,
    )
    .join("");
  return `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"></head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#1a1a1a;margin:0;padding:0;background:#f5f5f5;">
    <div style="max-width:560px;margin:0 auto;padding:40px 20px;">
      <div style="background:white;border-radius:12px;padding:40px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <h1 style="margin:0 0 16px;font-size:22px;">${title}</h1>
        <p style="font-size:14px;color:#4b5563;">${intro}</p>
        <div style="background:#f8f9fa;border-radius:8px;padding:16px;margin:24px 0;">${rows}</div>
        <p style="font-size:13px;color:#9ca3af;">${footer}</p>
      </div>
    </div>
  </body>
</html>`;
}

/**
 * Notify BeYours + confirm to the client that a migration request
 * was created. Both sends are best effort and logged on failure.
 */
export const notifyMigrationRequest = internalAction({
  args: {
    requestId: v.string(),
    requestedBy: v.string(),
    contactEmail: v.string(),
    contactPhone: v.optional(v.string()),
    targetProvider: v.string(),
    targetTeam: v.optional(v.string()),
    targetTeamEmail: v.optional(v.string()),
    scope: v.array(v.string()),
    preferredDate: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const lines = describeRequestLines(args);
    const siteUrl = process.env.BID_APP_URL ?? process.env.SITE_URL ?? "";
    const results = { bidNotified: false, clientNotified: false };

    // 1. Alert the BeYours team
    const bidEmail = process.env.BID_NOTIFY_EMAIL;
    if (bidEmail) {
      try {
        const allLines = [
          ...(siteUrl ? [`Site : ${siteUrl}`] : []),
          `Demandeur (userId) : ${args.requestedBy}`,
          ...lines,
        ];
        await sendViaSES({
          toEmail: bidEmail,
          subject: `[BID] Demande de migration — ${args.targetProvider}`,
          htmlBody: buildSimpleHtml(
            "Nouvelle demande de migration",
            "Un client vient de demander la migration de son site.",
            allLines,
            `Référence : ${args.requestId}. À traiter depuis la page Système du déploiement (ou via maintenance.updateMigrationRequestStatus).`,
          ),
          textBody: [
            "Nouvelle demande de migration",
            ...allLines,
            `Référence : ${args.requestId}`,
          ].join("\n"),
        });
        results.bidNotified = true;
      } catch (error) {
        console.error("Échec notification BID (migration request):", error);
      }
    } else {
      console.warn(
        "BID_NOTIFY_EMAIL non configure — notification BeYours ignoree",
      );
    }

    // 2. Confirm to the client
    try {
      await sendViaSES({
        toEmail: args.contactEmail,
        subject: "Votre demande de migration a bien été reçue",
        htmlBody: buildSimpleHtml(
          "Demande de migration reçue",
          "Nous avons bien reçu votre demande de migration. L'équipe BeYours vous recontactera pour organiser le transfert avec votre équipe.",
          lines,
          "Vous pouvez suivre l'avancement depuis votre tableau de bord, rubrique Système → Maintenance.",
        ),
        textBody: [
          "Nous avons bien reçu votre demande de migration.",
          ...lines,
          "Suivez l'avancement depuis votre tableau de bord (Système → Maintenance).",
        ].join("\n"),
      });
      results.clientNotified = true;
    } catch (error) {
      console.error("Échec confirmation client (migration request):", error);
    }

    return results;
  },
});
