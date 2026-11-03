// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The five removes of #412, through the real schema and the real auth wrappers.
 *
 * WHY AN APP-LEVEL FILE AS WELL. `destructivePaths.test.ts` in
 * `@be-yours/convex-functions` proves each handler refuses or cascades; it
 * runs against a double. What it cannot prove is that the indexes those guards
 * seek exist in the schema THIS app deploys, that the wrappers export what the
 * screens call, and that the two multi-pass deletes actually book their next
 * pass — a drain that is never scheduled leaves exactly the half-cleared state
 * the batching was added to avoid. Same reasoning as
 * `product-deletion-integrity.test.ts`, and the same trap: the unit suite calls
 * the handlers past a hand-rolled `db`, which cannot show that an index is real.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

/**
 * Drain the scheduler between tests, and give the drains booked here somewhere
 * to run. A pending job firing against a closed transaction arrives as an
 * unhandled rejection that blames another file — same guard as
 * `product-deletion-integrity.test.ts`.
 */
afterEach(async () => {
  for (const t of harnesses) {
    await t.run(async (ctx) => {
      const pending = await ctx.db.system.query("_scheduled_functions").collect()
      for (const job of pending) {
        if (job.state.kind === "pending" || job.state.kind === "inProgress") {
          await ctx.scheduler.cancel(job._id)
        }
      }
    })
  }
  harnesses.length = 0
})

// ===========================================================================
// Fixtures
// ===========================================================================

async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Luigi",
      slug: "chez-luigi",
      address: {
        street: "1 rue de la Paix",
        city: "Paris",
        postalCode: "75002",
        country: "France",
      },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedOwner(
  t: ReturnType<typeof convexTest>,
  subject: string,
  storeIds: Id<"stores">[]
) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: subject,
      role: "client_admin" as const,
      storeIds,
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject })
}

async function seedSubscriber(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
  return t.run((ctx) =>
    ctx.db.insert("emailSubscribers", {
      storeId,
      email: "diner@resto.example",
      status: "active" as const,
      source: "storefront_form" as const,
      tags: [],
      consentAt: NOW,
      consentSource: "Formulaire de la vitrine",
      bounceCount: 0,
      metadata: {
        totalOrders: 0,
        totalSpent: 0,
        averageOrderValue: 0,
        favoriteProducts: [],
        orderTypes: [],
      },
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

/** How many rows are pending on the scheduler right now. */
async function pendingJobs(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect()
    return jobs.filter((job) => job.state.kind === "pending" || job.state.kind === "inProgress")
  })
}

// ===========================================================================
// P3-F2 — a subscriber takes their rows with them
// ===========================================================================

describe("emailSubscribers.remove", () => {
  test("clears the two REQUIRED foreign keys before the subscriber goes", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const subscriber = await seedSubscriber(t, store)
    const asOwner = await seedOwner(t, "user:subs", [store])

    await t.run(async (ctx) => {
      await ctx.db.insert("emailEvents", {
        storeId: store,
        subscriberId: subscriber,
        type: "sent" as const,
        occurredAt: NOW,
      })
      await ctx.db.insert("emailAutomationRuns", {
        storeId: store,
        automationId: await ctx.db.insert("emailAutomations", {
          storeId: store,
          name: "Bienvenue",
          trigger: "welcome" as const,
          steps: [],
          status: "active" as const,
          stats: { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0, converted: 0, revenue: 0 },
          createdAt: NOW,
          updatedAt: NOW,
        }),
        subscriberId: subscriber,
        stepId: "s1",
        sentAt: NOW,
      })
    })

    const result = await asOwner.mutation(api.emailSubscribers.remove, { id: subscriber })
    expect(result).toEqual({ deleted: 2, complete: true })

    await t.run(async (ctx) => {
      expect(await ctx.db.get(subscriber)).toBeNull()
      expect(await ctx.db.query("emailEvents").collect()).toHaveLength(0)
      expect(await ctx.db.query("emailAutomationRuns").collect()).toHaveLength(0)
    })
  })

  test("books the next pass when one transaction cannot finish", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const subscriber = await seedSubscriber(t, store)
    const asOwner = await seedOwner(t, "user:drain", [store])

    // One past the batch. The subscriber must survive this pass, and the
    // wrapper must book the one that finishes it.
    await t.run(async (ctx) => {
      for (let i = 0; i < 513; i++) {
        await ctx.db.insert("emailEvents", {
          storeId: store,
          subscriberId: subscriber,
          type: "sent" as const,
          occurredAt: NOW + i,
        })
      }
    })

    const result = await asOwner.mutation(api.emailSubscribers.remove, { id: subscriber })

    // The pass that cannot finish leaves the subscriber standing, which is the
    // whole point: the two columns pointing at them are NOT optional.
    expect(result.complete).toBe(false)
    expect(await t.run((ctx) => ctx.db.get(subscriber))).not.toBeNull()

    // ...and books the pass that will. A drain nobody schedules is how a
    // half-cleared list stays half-cleared for ever.
    const booked = await pendingJobs(t)
    expect(booked.map((job) => job.name)).toEqual(["emailSubscribers:purgeRemoval"])

    // Run it as the scheduler would. (`finishAllScheduledFunctions` is not used
    // here for the reason `catalogue-scope.test.ts` records: it advances the
    // clock and fires every delayed job in the harness.)
    const finish = await t.mutation(internal.emailSubscribers.purgeRemoval, { id: subscriber })
    expect(finish.complete).toBe(true)

    await t.run(async (ctx) => {
      expect(await ctx.db.get(subscriber)).toBeNull()
      expect(await ctx.db.query("emailEvents").collect()).toHaveLength(0)
    })
  })
})

// ===========================================================================
// P3-F3 — a campaign that has reached somebody
// ===========================================================================

describe("emailCampaigns.remove", () => {
  async function seedCampaign(
    t: ReturnType<typeof convexTest>,
    storeId: Id<"stores">,
    status: "draft" | "failed"
  ) {
    return t.run(async (ctx) =>
      ctx.db.insert("emailCampaigns", {
        storeId,
        name: "Promo été",
        subject: "-20% cette semaine",
        templateId: await ctx.db.insert("emailTemplates", {
          storeId,
          name: "Newsletter",
          subject: "Nos offres",
          blocks: [],
          category: "marketing" as const,
          createdAt: NOW,
          updatedAt: NOW,
        }),
        status,
        abTestEnabled: false,
        stats: { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0, converted: 0, revenue: 0 },
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
  }

  test("refuses one that has already reached part of the list", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const subscriber = await seedSubscriber(t, store)
    const asOwner = await seedOwner(t, "user:camp", [store])
    const campaign = await seedCampaign(t, store, "failed")

    await t.run((ctx) =>
      ctx.db.insert("emailEvents", {
        storeId: store,
        campaignId: campaign,
        subscriberId: subscriber,
        type: "sent" as const,
        occurredAt: NOW,
      })
    )

    await expect(
      asOwner.mutation(api.emailCampaigns.remove, { id: campaign })
    ).rejects.toThrow(/Relancer/)

    expect(await t.run((ctx) => ctx.db.get(campaign))).not.toBeNull()
  })

  test("still deletes a draft nobody ever received", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const asOwner = await seedOwner(t, "user:draft", [store])
    const campaign = await seedCampaign(t, store, "draft")

    await asOwner.mutation(api.emailCampaigns.remove, { id: campaign })
    expect(await t.run((ctx) => ctx.db.get(campaign))).toBeNull()
  })
})

// ===========================================================================
// P3-F4 — QR codes, menus, promotions
// ===========================================================================

describe("gameQRCodes", () => {
  async function seedQRCode(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
    return t.run((ctx) =>
      ctx.db.insert("gameQRCodes", {
        storeId,
        code: "TABLE12",
        tableNumber: "12",
        isActive: true,
        scannedCount: 0,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
  }

  test("remove refuses a code that has been played, and keeps the play", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const asOwner = await seedOwner(t, "user:qr", [store])
    const qrCode = await seedQRCode(t, store)

    const play = await t.run(async (ctx) =>
      ctx.db.insert("gamePlays", {
        storeId: store,
        gameId: await ctx.db.insert("games", {
          storeId: store,
          name: "Roue",
          type: "wheel" as const,
          winRatio: 30,
          isActive: true,
          createdAt: NOW,
          updatedAt: NOW,
        }),
        qrCodeId: qrCode,
        completedActions: [],
        didWin: false,
        playedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    await expect(
      asOwner.mutation(api.gameQRCodes.remove, { id: qrCode })
    ).rejects.toThrow(/TABLE12/)

    await t.run(async (ctx) => {
      expect(await ctx.db.get(qrCode)).not.toBeNull()
      expect((await ctx.db.get(play))?.qrCodeId).toBe(qrCode)
    })
  })

  test("setActive is the way out, and it is on the API", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const asOwner = await seedOwner(t, "user:qr-off", [store])
    const qrCode = await seedQRCode(t, store)

    await asOwner.mutation(api.gameQRCodes.setActive, { id: qrCode, isActive: false })
    expect(await t.run(async (ctx) => (await ctx.db.get(qrCode))?.isActive)).toBe(false)
  })
})

describe("menus.remove", () => {
  async function seedMenu(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
    return t.run((ctx) =>
      ctx.db.insert("menus", {
        storeId,
        name: "Formule Midi",
        price: 1500,
        sections: [],
        isActive: true,
        sortOrder: 0,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
  }

  test("refuses while a prize gives the formule away", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const asOwner = await seedOwner(t, "user:menu", [store])
    const menu = await seedMenu(t, store)

    await t.run((ctx) =>
      ctx.db.insert("prizes", {
        storeId: store,
        name: "Menu offert",
        type: "free_menu" as const,
        menuId: menu,
        validityDays: 30,
        totalAvailable: 5,
        remainingCount: 5,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    await expect(asOwner.mutation(api.menus.remove, { id: menu })).rejects.toThrow(
      /Menu offert/
    )
    expect(await t.run((ctx) => ctx.db.get(menu))).not.toBeNull()
  })

  test("takes the formule's own translations with it", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const asOwner = await seedOwner(t, "user:menu-i18n", [store])
    const menu = await seedMenu(t, store)

    const survivor = await t.run(async (ctx) => {
      await ctx.db.insert("translations", {
        storeId: store,
        entityType: "menus",
        entityId: menu,
        field: "name",
        languageCode: "en",
        value: "Lunch set",
        isAutoTranslated: true,
        updatedAt: NOW,
      })
      return ctx.db.insert("translations", {
        storeId: store,
        entityType: "products",
        entityId: "products:elsewhere",
        field: "name",
        languageCode: "en",
        value: "Pizza",
        isAutoTranslated: true,
        updatedAt: NOW,
      })
    })

    await asOwner.mutation(api.menus.remove, { id: menu })

    await t.run(async (ctx) => {
      expect(await ctx.db.get(menu)).toBeNull()
      const left = await ctx.db.query("translations").collect()
      expect(left.map((row) => row._id)).toEqual([survivor])
    })
  })

  test("books the drain when a formule has more translations than one pass", async () => {
    // The other half of the same guarantee as the subscriber drain above, and
    // the only thing holding it: deleting the scheduling branch from the
    // wrapper left every suite in both apps green.
    const t = newHarness()
    const store = await seedStore(t)
    const asOwner = await seedOwner(t, "user:menu-drain", [store])
    const menu = await seedMenu(t, store)

    // One past `MENU_TRANSLATION_BATCH`.
    await t.run(async (ctx) => {
      for (let i = 0; i < 257; i++) {
        await ctx.db.insert("translations", {
          storeId: store,
          entityType: "menus",
          entityId: menu,
          field: `field-${i}`,
          languageCode: "en",
          value: "x",
          isAutoTranslated: true,
          updatedAt: NOW,
        })
      }
    })

    const result = await asOwner.mutation(api.menus.remove, { id: menu })
    expect(result.hasMore).toBe(true)

    const booked = await pendingJobs(t)
    expect(booked.map((job) => job.name)).toContain("menus:purgeTranslations")

    // Run it as the scheduler would.
    await t.mutation(internal.menus.purgeTranslations, { menuId: menu, storeId: store })
    expect(await t.run((ctx) => ctx.db.query("translations").collect())).toHaveLength(0)
  })
})

describe("promotions.remove", () => {
  async function seedPromotion(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
    return t.run((ctx) =>
      ctx.db.insert("promotions", {
        storeId,
        name: "Bienvenue",
        triggerMode: "coupon" as const,
        couponCode: "BIENVENUE",
        discountType: "percentage" as const,
        discountValue: 10,
        scope: "order" as const,
        startDate: NOW - 86_400_000,
        endDate: NOW + 86_400_000,
        isActive: true,
        usageCount: 0,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )
  }

  test("refuses a coupon an order was discounted by", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const asOwner = await seedOwner(t, "user:promo", [store])
    const promotion = await seedPromotion(t, store)

    await t.run((ctx) =>
      ctx.db.insert("promotionUsages", {
        storeId: store,
        promotionId: promotion,
        customerEmail: "diner@resto.example",
        usedAt: NOW,
      })
    )

    await expect(
      asOwner.mutation(api.promotions.remove, { id: promotion })
    ).rejects.toThrow(/Désactivez-la/)

    await t.run(async (ctx) => {
      expect(await ctx.db.get(promotion)).not.toBeNull()
      // The ledger this delete used to erase is still there.
      expect(await ctx.db.query("promotionUsages").collect()).toHaveLength(1)
    })
  })


  test("refuses on the order alone, after retention has cleared the ledger", async () => {
    // Why the guard reads `orders` and not only `promotionUsages`, and the only
    // place `orders.by_promotionId` is proved to exist in the deployed schema:
    // retention and art. 17 erasure both clear usage rows, while a paid order is
    // ANONYMISED and keeps its `promotionId` and its discount.
    const t = newHarness()
    const store = await seedStore(t)
    const asOwner = await seedOwner(t, "user:promo-retained", [store])
    const promotion = await seedPromotion(t, store)

    await t.run((ctx) =>
      ctx.db.insert("orders", {
        storeId: store,
        orderNumber: "A-0001",
        type: "pickup" as const,
        status: "completed" as const,
        customerInfo: { name: "Camille", email: "camille@example.com" },
        items: [],
        subtotal: 1200,
        taxAmount: 0,
        total: 1200,
        promotionId: promotion,
        discountAmount: 300,
        paymentStatus: "paid" as const,
        source: "website" as const,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    await expect(
      asOwner.mutation(api.promotions.remove, { id: promotion })
    ).rejects.toThrow(/Désactivez-la/)

    expect(await t.run((ctx) => ctx.db.get(promotion))).not.toBeNull()
  })

  test("still deletes a coupon nobody ever redeemed", async () => {
    const t = newHarness()
    const store = await seedStore(t)
    const asOwner = await seedOwner(t, "user:promo-unused", [store])
    const promotion = await seedPromotion(t, store)

    await asOwner.mutation(api.promotions.remove, { id: promotion })
    expect(await t.run((ctx) => ctx.db.get(promotion))).toBeNull()
  })
})
