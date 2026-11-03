"use node";
/* eslint-disable @typescript-eslint/no-explicit-any -- ctx.runQuery returns untyped results */

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { sendEmail } from "./emailTransport";
import {
  buildSegmentFilter,
  renderTemplateToEmailHtml,
} from "@be-yours/marketing";
import { productIdsInBlocks } from "@be-yours/convex-functions/emailProductBlocks";
import {
  DEFAULT_INACTIVE_AFTER_DAYS,
  canDispatch,
  delayForStep,
  isLapsed,
  nextStep,
  occurrenceFor,
} from "@be-yours/convex-functions/automationDispatch";
import {
  configurationSetFields,
  resolveConfigurationSet,
} from "@be-yours/convex-functions/sesSending";

/**
 * Send one step of an automation to one subscriber, then schedule the next.
 *
 * `emailAutomations` was CRUD and nothing else: an owner could build a
 * sequence, set the delays, activate it, and switch on five toggles in the
 * settings screen, and no code anywhere dispatched on a trigger. This is the
 * half that was missing.
 *
 * The shape mirrors the campaign batches for the same reasons — bounded work
 * per invocation, and a record written after each send so nothing is delivered
 * twice — but the unit here is one subscriber rather than one page, because an
 * automation reaches people one at a time as they trigger it.
 */
export const runStep = internalAction({
  args: {
    automationId: v.id("emailAutomations"),
    subscriberId: v.id("emailSubscribers"),
    /** When the trigger fired. Delays are measured from here, not from now. */
    triggeredAt: v.number(),
    /** Which firing this is; see `occurrenceFor`. Absent for a welcome. */
    occurrenceKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const automation: any = await ctx.runQuery(
      internal.emailAutomations.getByIdInternal,
      { id: args.automationId }
    );
    if (!automation) return;

    // Re-checked on every step, not just at the trigger: an owner who pauses an
    // automation means the sequence stops, including the steps already
    // scheduled days out.
    const config: any = await ctx.runQuery(internal.emailConfig.getInternal, {
      storeId: automation.storeId,
    });

    // Re-checked on every step, not just at the trigger: an owner who pauses an
    // automation — or turns its settings toggle off — means the sequence stops,
    // including the steps already scheduled days out.
    if (!canDispatch(automation, config?.automationSettings)) return;

    const subscriber: any = await ctx.runQuery(
      internal.emailSubscribers.getByIdInternal,
      { id: args.subscriberId }
    );
    // Someone who has unsubscribed, bounced or complained since the trigger
    // must not receive the rest of a sequence they are no longer part of.
    if (!subscriber || subscriber.status !== "active") return;

    const sent: string[] = await ctx.runQuery(
      internal.emailAutomationRuns.stepsSentTo,
      {
        automationId: args.automationId,
        subscriberId: args.subscriberId,
        occurrenceKey: args.occurrenceKey,
      }
    );

    const step = nextStep(automation.steps, sent);
    if (!step) return;

    /* THE PER-STEP SEGMENT, WHICH NOTHING READ (#628).
     *
     * `automation-form-dialog.tsx:413` offers « Segment (optionnel) » on each
     * step, `emailMarketing.ts:517` stores it, and this function used
     * `step.templateId` alone — `segmentId` appeared nowhere in the file. So an
     * owner picked « Clients VIP » for step 2 and the step mailed every active
     * subscriber. `emailSegments.ts:250` compounded it by refusing to delete a
     * segment on behalf of that dead reference.
     *
     * SKIP, NOT SEND, when the segment cannot be resolved. A campaign in the
     * same position stops the whole send rather than falling back to the full
     * list, for the reason written at `emailCampaignActions.ts:195` — marketing
     * mail cannot be recalled. One automation step for one subscriber is the
     * same judgement at a smaller scale: the audience the owner chose no longer
     * exists, so there is no send to fall back to.
     *
     * Skipping does NOT mark the step sent, so the automation stays where it
     * is: a subscriber who does not match today is not mailed, and is not
     * carried past the step either.
     */
    if (step.segmentId) {
      const segment: any = await ctx.runQuery(
        internal.emailSegments.getByIdInternal,
        { id: step.segmentId as Id<"emailSegments"> }
      );
      if (!segment) {
        console.error(
          `[emailAutomations] step ${step.id} of ${automation.name} targets a segment that no longer exists — step skipped`
        );
        return;
      }
      const matches = buildSegmentFilter(segment.rules, segment.ruleOperator);
      if (!matches(subscriber)) return;
    }

    const template: any = await ctx.runQuery(
      internal.emailTemplates.getByIdInternal,
      // `AutomationStep` is a plain shape in @be-yours/convex-functions,
      // deliberately unaware of any schema, so it types this as a string. The
      // column it comes from is `v.id("emailTemplates")`, so the value is an
      // id; the cast is the boundary between the two views, not a guess.
      { id: step.templateId as Id<"emailTemplates"> }
    );
    if (!config || !template) {
      console.error(
        `[emailAutomations] config or template missing for ${automation.name}`
      );
      return;
    }

    const siteUrl = process.env.CONVEX_SITE_URL ?? "";
    const appUrl = process.env.SITE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
    const unsubscribeUrl = `${siteUrl}/email/unsubscribe?id=${args.subscriberId}`;

    /* THE « PRODUIT » BLOCKS, RESOLVED (#628). This passed `undefined`, and the
       renderer returns `""` for a product block with no data — so an automation
       built around three dishes went out with the section missing. */
    const productIds = productIdsInBlocks(template.blocks) as Id<"products">[];
    const productData = productIds.length
      ? await ctx.runQuery(internal.emailTemplates.productsForBlocksInternal, {
          productIds,
        })
      : undefined;

    const html = renderTemplateToEmailHtml(
      template.blocks,
      {
        ...config.branding,
        senderName: config.senderName,
        unsubscribeUrl,
        unsubscribeText: config.unsubscribeText ?? "Se désabonner",
      },
      productData,
      // The inbox preview line (#628). An automation has no subject of its own,
      // so the template's is the only statement there is.
      { siteUrl: appUrl, previewText: template.previewText }
    );

    // Same setting, same reasoning as a campaign: the configuration set belongs
    // to the client's own AWS account, so it is read from the deployment and
    // the field is omitted when they have none. Hard-coding the agency's own
    // meant `ConfigurationSetDoesNotExist` on every automation SES ever
    // attempted — a welcome sequence that silently reached nobody.
    const configurationSet = resolveConfigurationSet(
      process.env.AWS_SES_CONFIGURATION_SET
    );

    try {
      const outcome = await sendEmail({
        from: config.senderName
          ? `${config.senderName} <${config.fromEmail}>`
          : config.fromEmail,
        to: subscriber.email,
        subject: template.subject,
        html,
        text: `Se désabonner: ${unsubscribeUrl}`,
        ...(config.replyToEmail ? { replyTo: config.replyToEmail } : {}),
        // Omitted when there is none — an empty name is not "no tracking" to
        // SES, it is a name that does not exist. `configurationSetFields`
        // still owns that rule; this just carries its answer.
        ...configurationSetFields(configurationSet),
        headers: {
          "X-Automation-Id": String(args.automationId),
          "X-Subscriber-Id": String(args.subscriberId),
          "X-Store-Id": String(automation.storeId),
          // Same obligation as a campaign: this is bulk mail as far as
          // Gmail and Yahoo are concerned. See emailCampaignActions.
          "List-Unsubscribe": `<mailto:${config.replyToEmail ?? config.fromEmail}?subject=unsubscribe>, <${unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
      // The transport reports rather than throws, and the catch below is what
      // leaves the step retryable — so a refusal has to be turned back into one.
      if (!outcome.sent) {
        throw new Error(outcome.error ?? "envoi refusé par le fournisseur");
      }
    } catch (error) {
      // Not recorded, so the step can be retried. Recording a send that failed
      // would drop the message from the sequence for good.
      //
      // The configuration set is named because it is the setting this failure
      // is usually about, and the one an operator can check in a second.
      console.error(
        `[emailAutomations] step ${step.id} failed (configuration set: ` +
          `${configurationSet ?? "none"}):`,
        error
      );
      return;
    }

    await ctx.runMutation(internal.emailAutomationRuns.record, {
      automationId: args.automationId,
      subscriberId: args.subscriberId,
      storeId: automation.storeId,
      stepId: step.id,
      occurrenceKey: args.occurrenceKey,
    });

    await ctx.runMutation(internal.emailAutomations.incrementStats, {
      id: args.automationId,
      field: "sent",
    });

    const following = nextStep(automation.steps, [...sent, step.id]);
    if (!following) return;

    await ctx.scheduler.runAfter(
      delayForStep(following, args.triggeredAt, Date.now()),
      internal.emailAutomationActions.runStep,
      {
        automationId: args.automationId,
        subscriberId: args.subscriberId,
        triggeredAt: args.triggeredAt,
        occurrenceKey: args.occurrenceKey,
      }
    );
  },
});

/**
 * Start every active automation on `trigger` for one subscriber.
 *
 * The generalisation of what `startWelcome` did for one trigger. Each firing
 * carries an occurrence key so the same automation can run again where that
 * makes sense — see `occurrenceFor`.
 */
async function startTrigger(
  ctx: any,
  args: {
    storeId: string;
    subscriberId: string;
    trigger: "welcome" | "post_order" | "inactive";
    context: { orderId?: string; lastOrderAt?: number };
  }
): Promise<number> {
  const [automations, config]: [any[], any] = await Promise.all([
    ctx.runQuery(internal.emailAutomations.listActiveInternal, {
      storeId: args.storeId,
    }),
    ctx.runQuery(internal.emailConfig.getInternal, { storeId: args.storeId }),
  ]);

  const triggeredAt = Date.now();
  let started = 0;

  for (const automation of automations) {
    if (automation.trigger !== args.trigger) continue;
    // The settings toggle is consulted here, which is the whole reason it
    // exists: turning "Post-commande" off has to stop the mail, not just store
    // a boolean.
    if (!canDispatch(automation, config?.automationSettings)) continue;

    const first = automation.steps[0];
    if (!first) continue;

    await ctx.scheduler.runAfter(
      delayForStep(first, triggeredAt, triggeredAt),
      internal.emailAutomationActions.runStep,
      {
        automationId: automation._id,
        subscriberId: args.subscriberId,
        triggeredAt,
        occurrenceKey: occurrenceFor(args.trigger, args.context),
      }
    );
    started += 1;
  }

  return started;
}

/**
 * Start every `welcome` automation this store has active.
 *
 * Called when a subscriber confirms their double opt-in.
 */
export const startWelcome = internalAction({
  args: {
    storeId: v.id("stores"),
    subscriberId: v.id("emailSubscribers"),
  },
  handler: async (ctx, args): Promise<void> => {
    await startTrigger(ctx, {
      storeId: args.storeId,
      subscriberId: args.subscriberId,
      trigger: "welcome",
      context: {},
    });
  },
});

/**
 * Start every `post_order` automation, for one confirmed order.
 *
 * Called from the order-confirmation seam, beside the write that records the
 * order against the subscriber. The order's id is the occurrence, so a
 * thank-you follows every order rather than only the first one a customer ever
 * placed.
 */
export const startPostOrder = internalAction({
  args: {
    storeId: v.id("stores"),
    subscriberId: v.id("emailSubscribers"),
    orderId: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    await startTrigger(ctx, {
      storeId: args.storeId,
      subscriberId: args.subscriberId,
      trigger: "post_order",
      context: { orderId: args.orderId },
    });
  },
});

/**
 * Find the customers who have gone quiet, and start the win-back.
 *
 * Runs daily from `crons.ts`. Walks the active subscribers of every store that
 * has an `inactive` automation, rather than every subscriber in the
 * deployment — a restaurant with no such automation costs nothing.
 *
 * Someone who has never ordered is never lapsed: "come back, we miss you" to a
 * person who has never been is how a sender gets reported.
 */
export const sweepInactive = internalAction({
  args: {},
  handler: async (ctx): Promise<{ started: number }> => {
    const automations: any[] = await ctx.runQuery(
      internal.emailAutomations.listActiveByTriggerInternal,
      { trigger: "inactive" }
    );

    const now = Date.now();
    let started = 0;

    // One pass per store, not per automation: two win-backs on one restaurant
    // would otherwise read the whole subscriber list twice.
    const byStore = new Map<string, any[]>();
    for (const automation of automations) {
      const list = byStore.get(automation.storeId) ?? [];
      list.push(automation);
      byStore.set(automation.storeId, list);
    }

    for (const [storeId, storeAutomations] of byStore) {
      const config: any = await ctx.runQuery(internal.emailConfig.getInternal, {
        storeId: storeId as never,
      });

      let cursor: string | null = null;
      for (;;) {
        const page: any = await ctx.runQuery(
          internal.emailSubscribers.pageForSending,
          { storeId: storeId as never, cursor, numItems: 100 }
        );

        for (const automation of storeAutomations) {
          if (!canDispatch(automation, config?.automationSettings)) continue;
          const afterDays =
            automation.inactiveAfterDays ?? DEFAULT_INACTIVE_AFTER_DAYS;

          for (const subscriber of page.page) {
            if (!isLapsed(subscriber, afterDays, now)) continue;

            await ctx.scheduler.runAfter(
              delayForStep(automation.steps[0], now, now),
              internal.emailAutomationActions.runStep,
              {
                automationId: automation._id,
                subscriberId: subscriber._id,
                triggeredAt: now,
                occurrenceKey: occurrenceFor("inactive", {
                  lastOrderAt: subscriber.metadata?.lastOrderAt,
                }),
              }
            );
            started += 1;
          }
        }

        if (page.isDone) break;
        cursor = page.continueCursor;
      }
    }

    if (started > 0) {
      console.log(`[emailAutomations] win-back started for ${started} subscriber(s)`);
    }
    return { started };
  },
});

// ─── The double opt-in confirmation ─────────────────────────────────────────
//
// Lives here rather than in a module of its own, and that is a deployment
// constraint rather than a taste: Convex bundles every `"use node"` module
// separately with its dependencies, and the e2e workflow pushes all of them
// into a local backend under a hard five-minute ceiling that #315 measured the
// push already running at ~60% of. A thirty-fourth Node bundle carrying its own
// copy of the AWS SDK took three of four shards over that ceiling, failing them
// in `Deploy Convex functions` before a single test body ran.
//
// It is also where the confirmation belongs. Confirming an opt-in is what
// starts the welcome sequence, so the mail that carries the link and the engine
// that answers it now sit in one file, over one SES client.

const ESC_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * The restaurant's own name reaches this template from the database, where an
 * owner typed it. Interpolating it raw would put whatever they typed into the
 * markup of an email we send on their behalf.
 */
function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESC_MAP[ch] ?? ch);
}

function buildConfirmationHtml(params: {
  storeName: string;
  confirmUrl: string;
}): string {
  const storeName = esc(params.storeName);
  // Not escaped with `esc`: the URL goes in an href, where `&quot;` would
  // corrupt it. It is built from CONVEX_SITE_URL and a UUID we minted, and the
  // token is encoded at the call site.
  const confirmUrl = params.confirmUrl;

  return `<!DOCTYPE html>
<html lang="fr">
  <head><meta charset="utf-8"></head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#1a1a1a;margin:0;padding:0;background:#f4f4f5;">
    <div style="max-width:560px;margin:0 auto;padding:40px 20px;">
      <div style="background:#ffffff;border-radius:16px;padding:40px;">
        <h1 style="margin:0 0 16px;font-size:22px;color:#1a1a1a;">Confirmez votre inscription</h1>
        <p style="margin:0 0 8px;font-size:15px;color:#3f3f46;">
          Vous avez demandé à recevoir les actualités de ${storeName}.
          Un dernier clic et c'est fait.
        </p>
        <div style="text-align:center;margin:32px 0;">
          <a href="${confirmUrl}" style="display:inline-block;background:#0A412D;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 32px;border-radius:999px;">Confirmer mon inscription</a>
        </div>
        <p style="margin:0;font-size:13px;color:#71717a;">
          Ce lien est valable 48 heures. Si vous n'êtes pas à l'origine de cette
          demande, ignorez cet email : aucune inscription ne sera enregistrée.
        </p>
      </div>
      <p style="text-align:center;margin:20px 0 0;font-size:12px;color:#71717a;">${storeName}</p>
    </div>
  </body>
</html>`;
}

function buildConfirmationText(params: {
  storeName: string;
  confirmUrl: string;
}): string {
  return [
    `Vous avez demandé à recevoir les actualités de ${params.storeName}.`,
    "",
    "Confirmez votre inscription en ouvrant ce lien :",
    params.confirmUrl,
    "",
    "Ce lien est valable 48 heures. Si vous n'êtes pas à l'origine de cette",
    "demande, ignorez cet email : aucune inscription ne sera enregistrée.",
  ].join("\n");
}

/**
 * Send one subscriber the link that confirms their consent.
 *
 * Scheduled from the mutation that created them rather than awaited, for the
 * same reason `confirmDoubleOptIn` schedules the welcome sequence: SES being
 * slow or refusing is not a reason for the signup itself to fail in front of
 * the visitor.
 */
export const sendConfirmation = internalAction({
  args: { subscriberId: v.id("emailSubscribers") },
  handler: async (ctx, args): Promise<void> => {
    const subscriber = await ctx.runQuery(
      internal.emailSubscribers.getByIdInternal,
      { id: args.subscriberId }
    );
    if (!subscriber) return;

    // Both are ordinary, not errors: a `manual` subscriber is `active` with no
    // token by design, and a row confirmed between the schedule and the send
    // has had its token cleared. Neither should produce a second email.
    if (subscriber.status !== "pending" || !subscriber.doubleOptInToken) return;

    const siteUrl = process.env.CONVEX_SITE_URL ?? "";
    if (!siteUrl) {
      // The three existing senders fall back to `""` here, which yields
      // `/email/confirm?token=…` — a relative path, and an unclickable link in
      // every mail client. Sending that would burn the token on a message that
      // cannot work, and the 48-hour expiry would run out before anyone
      // noticed. Refusing leaves the row `pending` and the token usable once
      // the deployment is configured.
      throw new Error(
        "CONVEX_SITE_URL is not set — refusing to send a confirmation link that would be relative"
      );
    }

    const confirmUrl = `${siteUrl.replace(/\/$/, "")}/email/confirm?token=${encodeURIComponent(
      subscriber.doubleOptInToken
    )}`;

    const store = await ctx.runQuery(internal.stores.internalGetById, {
      id: subscriber.storeId,
    });
    const storeName = store?.name ?? "votre restaurant";

    // The marketing config when the owner has set one up, so the mail comes
    // from the restaurant; the deployment's own sender otherwise, because a
    // visitor who signs up before the owner opens the email screen still has
    // to be confirmable.
    const config = await ctx.runQuery(internal.emailConfig.getInternal, {
      storeId: subscriber.storeId,
    });
    // `||`, not `??`: `emailConfig.fromEmail` is a required `v.string()` that
    // `upsert` accepts empty, and `??` would hand SES "" rather than falling
    // back — defeating the sentence above this one.
    const fromEmail =
      config?.fromEmail || process.env.AWS_SES_FROM_EMAIL || "";
    if (!fromEmail) {
      throw new Error(
        "Neither the store's email config nor AWS_SES_FROM_EMAIL provides a sender address"
      );
    }
    const fromAddress = config?.senderName
      ? `${config.senderName} <${fromEmail}>`
      : fromEmail;

    // Omitted when unset: on a client's own AWS account a configuration set
    // named for ours does not exist, and naming a missing one makes SES reject
    // the send outright.
    const configurationSet = process.env.AWS_SES_CONFIGURATION_SET;

    const outcome = await sendEmail({
      from: fromAddress,
      to: subscriber.email,
      subject: `Confirmez votre inscription — ${storeName}`,
      html: buildConfirmationHtml({ storeName, confirmUrl }),
      text: buildConfirmationText({ storeName, confirmUrl }),
      ...(config?.replyToEmail ? { replyTo: config.replyToEmail } : {}),
      ...(configurationSet ? { configurationSet } : {}),
      headers: {
        // The webhook correlates bounces by these. A confirmation that
        // hard-bounces is the clearest possible evidence the address is dead,
        // and `markBounced` now suppresses a `Permanent` one on the first
        // event — so a typo'd signup stops costing sends immediately instead
        // of after three.
        "X-Subscriber-Id": String(subscriber._id),
        "X-Store-Id": String(subscriber.storeId),
      },
    });

    // Thrown, not swallowed: the caller burns a confirmation token per attempt
    // and the 48h expiry runs from the first, so a silent failure spends the
    // subscriber's only chance to confirm.
    if (!outcome.sent) {
      throw new Error(outcome.error ?? "envoi refusé par le fournisseur");
    }
  },
});
