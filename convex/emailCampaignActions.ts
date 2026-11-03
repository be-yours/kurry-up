"use node";
/* eslint-disable @typescript-eslint/no-explicit-any -- Convex action ctx.runQuery returns untyped results */

import { action, internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";

import { sendEmail } from "./emailTransport";
import {
  buildSegmentFilter,
  renderTemplateToEmailHtml,
} from "@be-yours/marketing";
import { productIdsInBlocks } from "@be-yours/convex-functions/emailProductBlocks";
import {
  ONE_WEEK_MS,
  resolveWeeklyCap,
  subjectFor,
  withinWeeklyCap,
} from "@be-yours/convex-functions/campaignDelivery";
import {
  configurationSetFields,
  describeSendAbort,
  resolveConfigurationSet,
  shouldAbortSend,
} from "@be-yours/convex-functions/sesSending";

const BATCH_DELAY_MS = 100; // ~10 emails/sec, well below SES sandbox limit

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Subscribers handled per batch. One SES call and a 100 ms pause each. */
const BATCH_SIZE = 40;

/**
 * Begin sending a campaign. The work itself happens in `sendBatch`.
 *
 * This used to BE the send: one synchronous loop over every active subscriber,
 * invoked from the browser, with an SES call, two mutation round-trips and a
 * 100 ms pause each. Around 3,000 subscribers it exceeded the Convex time
 * limit, the campaign stayed at `sending` for good, and the only way out was
 * "Relancer" — which started again from the first subscriber and mailed
 * everyone who had already received it a second time.
 *
 * So the loop is gone. This validates, marks the campaign, and hands off to a
 * chain of scheduled batches that can be interrupted, paused and resumed.
 */
// @guarded-inline: runs authHelpers.checkStorePermission on the campaign's store
export const send = action({
  args: {
    campaignId: v.id("emailCampaigns"),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    // 1. Load campaign, template, config
    const campaign: any = await ctx.runQuery(api.emailCampaigns.getById, {
      id: args.campaignId,
    });
    if (!campaign) throw new Error("Campagne introuvable");

    // Verify store-level permission (actions don't have ctx.db)
    await ctx.runQuery(internal.authHelpers.checkStorePermission, {
      storeId: campaign.storeId,
      permission: "marketing:write",
    });

    // `failed` included: "Relancer" on a campaign whose send stopped is the
    // whole point of that status. `markSending` keeps the cursor, so it resumes
    // rather than mailing the first batch a second time.
    if (!["draft", "scheduled", "paused", "failed"].includes(campaign.status)) {
      throw new Error(
        "La campagne ne peut pas être envoyée dans son état actuel. Statut actuel : " +
          campaign.status
      );
    }

    const template: any = await ctx.runQuery(api.emailTemplates.getById, {
      id: campaign.templateId,
    });
    if (!template) throw new Error("Modèle introuvable");

    const config: any = await ctx.runQuery(api.emailConfig.get, {
      storeId: campaign.storeId,
    });
    if (!config) throw new Error("Configuration email introuvable");

    // Refusing an empty audience out loud, as before. It used to fall out of
    // loading every subscriber; asking for a single row keeps the warning
    // without bringing the unbounded read back with it.
    const firstPage: any = await ctx.runQuery(internal.emailSubscribers.pageForSending, {
      storeId: campaign.storeId,
      cursor: null,
      numItems: 1,
    });
    if (firstPage.page.length === 0) {
      throw new Error("Aucun abonné actif trouvé pour cette campagne");
    }

    // Starting fresh rather than resuming means the cursor must be cleared,
    // or a re-run of a finished campaign would resume at its end and send
    // nothing. Resuming a paused one keeps it.
    if (campaign.status !== "paused") {
      await ctx.runMutation(internal.emailCampaigns.saveSendCursor, {
        id: args.campaignId,
        cursor: null,
      });
    }

    await ctx.runMutation(internal.emailCampaigns.markSending, {
      id: args.campaignId,
    });

    await ctx.scheduler.runAfter(0, internal.emailCampaignActions.sendBatch, {
      campaignId: args.campaignId,
    });

    return { started: true };
  },
});

/**
 * Send one page of the campaign, then schedule the next.
 *
 * Three properties this has to hold, each one a defect it replaces:
 *
 * - **Bounded.** A batch reads one page and sends it, so no single invocation
 *   can outgrow the action time limit however long the list is.
 * - **Resumable.** The cursor is saved after every page, so an interruption
 *   costs at most one batch and "Relancer" continues rather than restarts.
 * - **Idempotent.** Before sending, it asks the events table which of these
 *   subscribers this campaign has already reached, and skips them. A cursor
 *   alone cannot survive a batch that is retried after a transient failure;
 *   this can, and duplicate marketing mail is the failure that costs real
 *   customers and real SES reputation.
 */
export const sendBatch = internalAction({
  args: { campaignId: v.id("emailCampaigns") },
  handler: async (ctx: ActionCtx, args): Promise<void> => {
    const campaign: any = await ctx.runQuery(internal.emailCampaigns.getByIdInternal, {
      id: args.campaignId,
    });
    if (!campaign) return;

    // The owner pressed Pause between two batches. Stop the chain and leave the
    // cursor where it is — that is what makes resuming possible at all.
    if (campaign.status !== "sending") {
      console.log(
        `[emailCampaigns] batch stopped: campaign is "${campaign.status}"`
      );
      return;
    }

    const template: any = await ctx.runQuery(internal.emailTemplates.getByIdInternal, {
      id: campaign.templateId,
    });
    const config: any = await ctx.runQuery(internal.emailConfig.getInternal, {
      storeId: campaign.storeId,
    });
    // A batch that cannot read what it needs FAILS the campaign; it does not
    // hold. This used to be `console.error` and `return`: the campaign stayed
    // at "sending" for ever, the owner's screen read "En cours" against a send
    // that had stopped, and the only record was a log line no restaurant sees.
    // Deleting the template a scheduled campaign named was enough to do it —
    // `emailTemplates.remove` now refuses that, and this is the other half,
    // because a template can go missing in ways no refusal covers.
    if (!template) {
      await ctx.runMutation(internal.emailCampaigns.markFailed, {
        id: args.campaignId,
        reason:
          "Le modèle d'email de cette campagne est introuvable : il a été supprimé. " +
          "Choisissez un autre modèle, puis relancez.",
      });
      return;
    }
    if (!config) {
      await ctx.runMutation(internal.emailCampaigns.markFailed, {
        id: args.campaignId,
        reason:
          "La configuration email de l'établissement est introuvable. " +
          "Renseignez l'expéditeur dans Marketing → Configuration, puis relancez.",
      });
      return;
    }

    const page: any = await ctx.runQuery(internal.emailSubscribers.pageForSending, {
      storeId: campaign.storeId,
      cursor: campaign.sendCursor ?? null,
      numItems: BATCH_SIZE,
    });

    let recipients: any[] = page.page;

    // A missing segment FAILS the campaign, and this is the one that had to
    // change most. The code read "if the segment is there, filter by it", so a
    // segment that had been deleted meant no filter at all — the campaign did
    // not stop, it went to the WHOLE list. Copy written for "clients inactifs
    // depuis 6 mois" reached every subscriber the establishment has, in
    // batches, and marketing mail cannot be recalled. Stopping is the only
    // correct answer: the audience the owner chose no longer exists, so there
    // is no send to fall back to.
    if (campaign.segmentId) {
      const segment: any = await ctx.runQuery(internal.emailSegments.getByIdInternal, {
        id: campaign.segmentId,
      });
      if (!segment) {
        await ctx.runMutation(internal.emailCampaigns.markFailed, {
          id: args.campaignId,
          reason:
            "Le segment ciblé par cette campagne est introuvable : il a été supprimé. " +
            "L'envoi a été arrêté pour ne pas écrire à toute la liste. " +
            "Choisissez une autre audience, puis relancez.",
        });
        return;
      }
      const predicate = buildSegmentFilter(segment.rules, segment.ruleOperator);
      recipients = recipients.filter((s: any) => predicate(s));
    }

    /* THE « PRODUIT » BLOCKS, RESOLVED (#628). Every caller of
       `renderTemplateToEmailHtml` passed `undefined` here, and the renderer
       returns `""` for a product block with no data — so an owner built a
       « plats de la semaine » campaign around three dishes and every recipient
       received it with the section missing. Resolved ONCE per send rather than
       per subscriber: the dishes are the same for everyone on the list. */
    const productIds = productIdsInBlocks(template.blocks) as Id<"products">[];
    const productData = productIds.length
      ? await ctx.runQuery(internal.emailTemplates.productsForBlocksInternal, {
          productIds,
        })
      : undefined;

    // One round-trip for the whole page, not one per subscriber.
    const alreadyReached: string[] = recipients.length
      ? await ctx.runQuery(internal.emailEvents.alreadySentTo, {
          campaignId: args.campaignId,
          subscriberIds: recipients.map((s: any) => s._id),
        })
      : [];
    const reached = new Set(alreadyReached);
    recipients = recipients.filter((s: any) => !reached.has(s._id));

    // `maxEmailsPerWeek` was presented in the settings screen as an anti-spam
    // guard, with a default of three, and nothing anywhere consulted it: a
    // restaurant sending four campaigns in a week sent all four to everyone,
    // having promised itself otherwise.
    //
    // Counted from the events table rather than a stored tally, so it cannot
    // disagree with the idempotency check about what actually went out. One
    // round-trip for the page, as with that check.
    const cap = resolveWeeklyCap(config.maxEmailsPerWeek);
    if (recipients.length > 0) {
      const counts: Array<{ subscriberId: string; count: number }> =
        await ctx.runQuery(internal.emailEvents.sentCountsSince, {
          subscriberIds: recipients.map((s: any) => s._id),
          since: Date.now() - ONE_WEEK_MS,
          // Counting past the cap changes no decision below, and each row past
          // it is a document read on the send path.
          countLimit: cap,
        });
      const sentThisWeek = new Map(
        counts.map((c) => [c.subscriberId, c.count])
      );
      const before = recipients.length;
      recipients = recipients.filter((s: any) =>
        withinWeeklyCap(sentThisWeek.get(s._id) ?? 0, cap)
      );
      const held = before - recipients.length;
      if (held > 0) {
        // Logged rather than silent: an owner who sees fewer sends than
        // subscribers deserves a reason that is findable.
        console.log(
          `[emailCampaigns] ${held} subscriber(s) held back by maxEmailsPerWeek=${cap}`
        );
      }
    }

    const siteUrl = process.env.CONVEX_SITE_URL ?? "";
    // Media stored without a CDN is a path on the storefront, not on Convex.
    const appUrl = process.env.SITE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
    const fromAddress = config.senderName
      ? `${config.senderName} <${config.fromEmail}>`
      : config.fromEmail;

    // The configuration set is what SES attaches open and click tracking to,
    // and it belongs to the AWS account doing the sending. It used to be
    // hard-coded to the agency's own, which exists in no client account, so
    // every call came back `ConfigurationSetDoesNotExist`. Read it from the
    // deployment, and omit the field when there is none — a send with no
    // configuration set is accepted, it simply produces no tracking events.
    const configurationSet = resolveConfigurationSet(
      process.env.AWS_SES_CONFIGURATION_SET
    );
    const configurationSetField = configurationSetFields(configurationSet);

    // A run of refusals is an account-level fault, not a bad address; see
    // CONSECUTIVE_SEND_FAILURE_LIMIT. Reset by every send that works, so a list
    // with scattered bad addresses still goes out in full.
    let consecutiveFailures = 0;

    for (const subscriber of recipients) {
      try {
        // The wizard collects variants and checks their percentages sum to 100.
        // The send used `campaign.subject` for everyone, `campaign.variants`
        // was read by nothing, and `metadata.variantId` — a schema field that
        // exists for exactly this — was never written. An owner could run a
        // test whose two arms were the same email and read a result measuring
        // nothing.
        //
        // The arm is chosen deterministically from the two ids, because a send
        // now runs in batches that can be interrupted and retried: drawing at
        // random would let a retry send arm B to someone who already had arm A.
        const delivery = subjectFor(campaign, subscriber._id, args.campaignId);

        // `c=` is what makes « Désabonnements » on the campaign report a real
        // figure. An unsubscribe arrives as a click on a link, long after the
        // mail was sent, and carries no other clue about which campaign
        // prompted it — so the campaign stamps itself into the link it sends.
        // Without it the counter's only writer was the SES *Complaint* branch,
        // and a campaign that lost forty subscribers reported none.
        const unsubscribeUrl =
          `${siteUrl}/email/unsubscribe?id=${subscriber._id}` +
          `&c=${args.campaignId}`;

        const branding = {
          ...config.branding,
          senderName: config.senderName,
          unsubscribeUrl,
          unsubscribeText: config.unsubscribeText ?? "Se désabonner",
        };

        const html = renderTemplateToEmailHtml(template.blocks, branding, productData, {
          siteUrl: appUrl,
          /* The inbox preview line (#628). The campaign's own text wins over
             the template's: a template is reused across campaigns, and the
             campaign is the more specific statement. */
          previewText: campaign.previewText ?? template.previewText,
        });

        const outcome = await sendEmail({
          from: fromAddress,
          to: subscriber.email,
          subject: delivery.subject,
          html,
          text: `Se désabonner: ${unsubscribeUrl}`,
          ...(config.replyToEmail ? { replyTo: config.replyToEmail } : {}),
          ...configurationSetField,
          headers: {
            "X-Campaign-Id": String(args.campaignId),
            "X-Subscriber-Id": String(subscriber._id),
            "X-Store-Id": String(campaign.storeId),
            // Gmail and Yahoo have required one-click unsubscribe from bulk
            // senders since February 2024. Without these two headers the mail
            // is filtered or refused outright — a deliverability problem that
            // looks exactly like "our campaigns get no opens".
            //
            // RFC 8058: the provider POSTs to the https URL with a body of
            // `List-Unsubscribe=One-Click` and no further interaction, which is
            // why `POST /email/unsubscribe` exists and takes no CSRF token. The
            // mailto is the fallback for clients that predate it.
            "List-Unsubscribe": `<mailto:${config.replyToEmail ?? config.fromEmail}?subject=unsubscribe>, <${unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        });

        // The transport reports rather than throws; the catch below is what
        // counts a failure towards the abort budget, so a refusal has to be
        // turned back into one. Losing this is how "Campagne envoyée (0/342)"
        // happened the first time.
        if (!outcome.sent) {
          throw new Error(outcome.error ?? "envoi refusé par le fournisseur");
        }

        // A send that worked clears the budget below: what aborts a batch is a
        // RUN of failures, never a total.
        consecutiveFailures = 0;

        // Recorded immediately after the send, so the idempotency check above
        // sees it even if this batch dies on the next subscriber.
        await ctx.runMutation(internal.emailEvents.create, {
          storeId: campaign.storeId,
          campaignId: args.campaignId,
          subscriberId: subscriber._id,
          type: "sent",
          occurredAt: Date.now(),
          // Which arm this address received. Without it a finished test has no
          // way to say which subject won.
          metadata: delivery.variantId
            ? { variantId: delivery.variantId }
            : undefined,
        });

        await ctx.runMutation(internal.emailCampaigns.incrementStats, {
          id: args.campaignId,
          field: "sent",
        });

        await delay(BATCH_DELAY_MS);
      } catch (error) {
        consecutiveFailures += 1;
        console.error(`Erreur envoi subscriber ${subscriber._id}:`, error);

        // The failure this replaces: every call refused, every refusal
        // swallowed here, `markSent` below run regardless — and the owner told
        // "Campagne envoyée (0/342 emails)". A campaign that reached nobody
        // must not report success, so the batch gives up out loud.
        //
        // Throwing is also what stops the damage: the cursor is not advanced
        // and the next batch is never scheduled, so the chain halts here
        // instead of burning the rest of the list against a broken account.
        // The campaign stays `sending` — not `sent` — with its cursor intact,
        // so "Relancer" resumes this page once the account is fixed, and the
        // idempotency check skips whoever did get through.
        //
        // `emailCampaigns` has no `failed` status and no internal pause
        // mutation to reach `paused` from a batch that carries no identity, so
        // `sending` is as close to "this went wrong" as the schema goes today.
        if (shouldAbortSend(consecutiveFailures)) {
          // `paused` rather than the `sending` the abort would otherwise leave
          // behind: the admin renders `sending` as "En cours", which claims a
          // send is progressing when it has stopped and will not resume by
          // itself. `paused` is the state the screen already offers "Relancer"
          // from, and the cursor is untouched, so resuming picks up this page
          // once the account is fixed.
          await ctx.runMutation(internal.emailCampaigns.pauseInternal, {
            id: args.campaignId,
          });
          throw new Error(
            describeSendAbort({ consecutiveFailures, configurationSet, error })
          );
        }
      }
    }

    if (page.isDone) {
      await ctx.runMutation(internal.emailCampaigns.markSent, { id: args.campaignId });
      return;
    }

    await ctx.runMutation(internal.emailCampaigns.saveSendCursor, {
      id: args.campaignId,
      cursor: page.continueCursor,
    });

    await ctx.scheduler.runAfter(0, internal.emailCampaignActions.sendBatch, {
      campaignId: args.campaignId,
    });
  },
});

/**
 * Send a test email for preview purposes.
 * Prepends "[TEST]" to the subject line.
 */
// @guarded-inline: runs authHelpers.checkStorePermission before sending the test
export const sendTest = action({
  args: {
    campaignId: v.id("emailCampaigns"),
    testEmail: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(args.testEmail)) {
      throw new Error("Adresse email invalide");
    }

    const campaign: any = await ctx.runQuery(api.emailCampaigns.getById, {
      id: args.campaignId,
    });
    if (!campaign) throw new Error("Campagne introuvable");

    // Verify store-level permission (actions don't have ctx.db)
    await ctx.runQuery(internal.authHelpers.checkStorePermission, {
      storeId: campaign.storeId,
      permission: "marketing:write",
    });

    const template: any = await ctx.runQuery(api.emailTemplates.getById, {
      id: campaign.templateId,
    });
    if (!template) throw new Error("Modèle introuvable");

    const config: any = await ctx.runQuery(api.emailConfig.get, {
      storeId: campaign.storeId,
    });
    if (!config) throw new Error("Configuration email introuvable");

    const siteUrl = process.env.CONVEX_SITE_URL ?? "";
    // Media stored without a CDN is a path on the storefront, not on Convex.
    const appUrl = process.env.SITE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
    const branding = {
      ...config.branding,
      senderName: config.senderName,
      unsubscribeUrl: `${siteUrl}/email/unsubscribe?id=test`,
      unsubscribeText: config.unsubscribeText ?? "Se désabonner",
    };

    /* Resolved for the test send too (#628) — a preview that silently drops
       the product block is the one place the defect would still be invisible,
       because a test send is how an owner checks the campaign before it goes. */
    const testProductIds = productIdsInBlocks(template.blocks) as Id<"products">[];
    const testProductData = testProductIds.length
      ? await ctx.runQuery(internal.emailTemplates.productsForBlocksInternal, {
          productIds: testProductIds,
        })
      : undefined;

    const html = renderTemplateToEmailHtml(template.blocks, branding, testProductData, {
      siteUrl: appUrl,
      previewText: campaign.previewText ?? template.previewText,
    });

    const fromAddress = config.senderName
      ? `${config.senderName} <${config.fromEmail}>`
      : config.fromEmail;

    const outcome = await sendEmail({
      from: fromAddress,
      to: args.testEmail,
      subject: `[TEST] ${campaign.subject}`,
      html,
      text: `Email test pour: ${campaign.subject}`,
      // Same reasoning as the batch: the set belongs to the client's own AWS
      // account, and the field is omitted when they have none. A test send has
      // no catch, so a wrong name surfaces to the admin as an error — which is
      // exactly how the batch's failure should have surfaced too.
      ...configurationSetFields(process.env.AWS_SES_CONFIGURATION_SET),
    });

    // Loud on purpose. A test send exists to answer "will this reach anyone?",
    // and reporting success for a refused send answers it wrongly.
    if (!outcome.sent) {
      throw new Error(outcome.error ?? "envoi refusé par le fournisseur");
    }

    return { success: true };
  },
});
