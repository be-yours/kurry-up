import { internalMutation } from "./_generated/server"
import { v } from "convex/values"
import type { Id } from "./_generated/dataModel"
import { allocateOrderNumber } from "@be-yours/convex-functions/numbering"
import { computeOrderTotals } from "@be-yours/convex-functions/orderTotals"

/**
 * The restaurant the e2e suite administers.
 *
 * `seed-users.mts` created six accounts and nothing else, so the `stores` table
 * stayed empty and every profile carried `storeIds: []`. Authentication then
 * succeeded and every admin screen still rendered nothing — the sidebar has no
 * restaurant to draw. Seventeen navigation tests failed on the same missing
 * locator, all of them describing this one absence.
 *
 * Internal on purpose: `internalMutation` is unreachable from a browser, so
 * this cannot be triggered on a deployment serving a real restaurant. It is
 * invoked by `scripts/seed-users.mts` through `npx convex run`, which
 * authenticates as the deployment itself.
 *
 * Idempotent throughout — seeding has to survive being run twice, which the
 * account step learned the hard way.
 */

const STORE_SLUG = "chez-luigi-test"

const HOURS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day,
  open: "09:00",
  close: "22:00",
  // Closed on Monday, so the "closed today" paths have something to show.
  isClosed: day === 1,
}))

const CATEGORIES = [
  { name: "Entrées", slug: "entrees", sortOrder: 0 },
  { name: "Plats", slug: "plats", sortOrder: 1 },
  { name: "Desserts", slug: "desserts", sortOrder: 2 },
]

/** Prices in cents, as everywhere else in this codebase. */
const PRODUCTS = [
  { category: "entrees", name: "Salade César", slug: "salade-cesar", price: 850 },
  { category: "entrees", name: "Soupe du jour", slug: "soupe-du-jour", price: 650 },
  { category: "plats", name: "Pizza Margherita", slug: "pizza-margherita", price: 1200 },
  { category: "plats", name: "Burger Classic", slug: "burger-classic", price: 1450 },
  { category: "desserts", name: "Tiramisu", slug: "tiramisu", price: 700 },
]

/** Roles that work in a restaurant, and therefore need it on their profile. */
const STAFF_ROLES = new Set(["client_admin", "manager", "kitchen", "waiter", "delivery"])

/**
 * The team roster shown on the Équipe screen.
 *
 * Mirrors the accounts `seed-users.mts` already creates rather than inventing
 * people: the row a test clicks then belongs to someone who can actually sign
 * in, which is what a real registry looks like. One row is left `pending` — an
 * invitation that has been sent and not yet accepted is a normal state of that
 * screen, and the status column exists to show it.
 */
const TEAM = [
  { name: "Marie Martin", email: "test.manager@beindigital.fr", role: "manager" as const, status: "accepted" as const },
  { name: "Pierre Dupont", email: "test.cuisine@beindigital.fr", role: "kitchen" as const, status: "accepted" as const },
  { name: "Sophie Laurent", email: "test.service@beindigital.fr", role: "waiter" as const, status: "pending" as const },
]

/**
 * A blog category, so the "Nouvel article" dialog has something to offer.
 *
 * Without one it replaces its form with "créez d'abord une catégorie", and four
 * tests about the form were really testing the absence of this row.
 */
const BLOG_CATEGORY = { name: "Actualités", slug: "actualites" }

/**
 * The sender address the email marketing needs before it will do anything.
 *
 * "Nouvelle campagne" stays disabled until `fromEmail` is set, which is correct
 * — and left eleven tests waiting on a button that is right to refuse. The
 * address is deliberately a `.test` domain: it is reserved by RFC 2606 and can
 * never be delivered to, so a run that unexpectedly sends mail fails loudly
 * rather than reaching a real inbox.
 */
const EMAIL_SENDER = {
  senderName: "Chez Luigi (test)",
  fromEmail: "no-reply@chez-luigi.test",
  replyToEmail: "contact@chez-luigi.test",
}

/**
 * Two orders, because the screens that read one need something to read.
 *
 * `order-detail.spec.ts` opens the first row of `/dashboard/orders` and asserts
 * against the page it lands on. Against an empty table every case skipped and
 * the file reported success — for long enough that the row it clicks stopped
 * navigating at all without anyone noticing (#533), and long enough after that
 * rewrite for three of its locators to be ambiguous with nobody there to see
 * them fail. `orders.spec.ts` and `dashboard.spec.ts` skip on the same absence.
 *
 * WRITTEN DIRECTLY, NOT THROUGH `orders.create`. That mutation refuses an order
 * placed outside the establishment's opening hours (#361), and the week above
 * deliberately closes on Mondays — so a fixture going through it would fail
 * every Monday and on every run outside 09:00–22:00. `payments-refund.spec.ts`
 * needs the real mutation, because it is testing what happens to money, and
 * pays for it by opening the week and putting it back afterwards. A fixture
 * does not have to buy that.
 *
 * The NUMBER still comes from `allocateOrderNumber` and the MONEY from
 * `computeOrderTotals`, both the engine's own. A seeded order therefore carries
 * a real `ORD-2026-00001` from the real per-establishment sequence, and figures
 * that add up on screen. Numbers written by hand here would drift from the
 * format the detail page's heading asserts, and would sit in the same series a
 * later real order is allocated out of.
 *
 * BOTH CARRY A NAME AND AN E-MAIL, so it does not matter which one the list
 * sorts first. Both are `paid`, because every screen that reads one of these
 * wants the settled case: an unpaid order shows no payment card and fewer
 * status actions. The addresses are on `.test`, reserved by RFC 2606 and
 * undeliverable, for the reason `EMAIL_SENDER` above gives.
 *
 * THE EXPLICIT `undefined`s ARE DELIBERATE, AND THEY ARE NOT WRITTEN. They are
 * here so both entries share one inferred element type — drop `phone` from the
 * dine-in order and `order.customerInfo.phone` stops type-checking at the
 * insert below. Convex omits an `undefined` field rather than storing it, so
 * what lands is a document without the key. Read back off the seeded
 * deployment, the dine-in order is:
 *
 *     customerInfo: { "email": "karim.benali@chez-luigi.test",
 *                     "name": "Karim Benali" }     // no `phone` key
 *     deliveryAddress: (absent)   deliveryFee: (absent)
 *
 * which is what `v.optional()` means. Do not "fix" this by building the object
 * conditionally; that costs the shared type and buys nothing.
 */
const ORDERS = [
  {
    idempotencyKey: "seed-fixture-order-delivery",
    /** Minutes before `now`, so the two sort deterministically by date. */
    placedMinutesAgo: 45,
    type: "delivery" as const,
    status: "preparing" as const,
    paymentMethod: "card",
    customerInfo: {
      name: "Amélie Rousseau",
      email: "amelie.rousseau@chez-luigi.test",
      phone: "06 12 34 56 78",
    },
    lines: [
      { slug: "pizza-margherita", quantity: 1 },
      { slug: "tiramisu", quantity: 2 },
    ],
    deliveryFee: 350,
    deliveryAddress: {
      street: "8 rue Oberkampf",
      city: "Paris",
      postalCode: "75011",
      country: "FR",
      instructions: "Code 4512, deuxième étage.",
    },
    tableNumber: undefined,
  },
  {
    idempotencyKey: "seed-fixture-order-dine-in",
    placedMinutesAgo: 180,
    type: "dine_in" as const,
    status: "completed" as const,
    paymentMethod: "cash",
    customerInfo: {
      name: "Karim Benali",
      email: "karim.benali@chez-luigi.test",
      phone: undefined,
    },
    lines: [
      { slug: "salade-cesar", quantity: 2 },
      { slug: "burger-classic", quantity: 1 },
    ],
    deliveryFee: undefined,
    deliveryAddress: undefined,
    tableNumber: "A3",
  },
]

export const internalSeedFixture = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()

    // --- The restaurant -----------------------------------------------------
    const existing = await ctx.db
      .query("stores")
      .filter((q) => q.eq(q.field("slug"), STORE_SLUG))
      .first()

    const storeId: Id<"stores"> =
      existing?._id ??
      (await ctx.db.insert("stores", {
        name: "Chez Luigi (test)",
        slug: STORE_SLUG,
        address: {
          street: "12 rue de la Paix",
          city: "Paris",
          postalCode: "75002",
          country: "FR",
          latitude: 48.8698,
          longitude: 2.3312,
        },
        hours: HOURS,
        status: "open" as const,
        createdAt: now,
        updatedAt: now,
      }))

    // --- Its catalogue ------------------------------------------------------
    const categoryIds = new Map<string, Id<"categories">>()

    for (const category of CATEGORIES) {
      const found = await ctx.db
        .query("categories")
        .filter((q) =>
          q.and(
            q.eq(q.field("storeId"), storeId),
            q.eq(q.field("slug"), category.slug)
          )
        )
        .first()

      categoryIds.set(
        category.slug,
        found?._id ??
          (await ctx.db.insert("categories", {
            storeId,
            name: category.name,
            slug: category.slug,
            sortOrder: category.sortOrder,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          }))
      )
    }

    let productsCreated = 0

    for (const product of PRODUCTS) {
      const found = await ctx.db
        .query("products")
        .filter((q) =>
          q.and(
            q.eq(q.field("storeId"), storeId),
            q.eq(q.field("slug"), product.slug)
          )
        )
        .first()
      if (found) continue

      await ctx.db.insert("products", {
        storeId,
        categoryId: categoryIds.get(product.category)!,
        name: product.name,
        slug: product.slug,
        price: product.price,
        taxRate: 10,
        images: [],
        options: [],
        allergens: [],
        tags: [],
        isActive: true,
        isFeatured: false,
        sortOrder: 0,
        source: "manual",
        createdAt: now,
        updatedAt: now,
      })
      productsCreated += 1
    }

    // --- Give the staff somewhere to work -----------------------------------
    //
    // A profile with `storeIds: []` passes every role check and then fails the
    // tenant check on the first screen it opens. Customers keep an empty list:
    // that is what a customer is.
    const profiles = await ctx.db.query("userProfiles").collect()
    let profilesAttached = 0

    for (const profile of profiles) {
      if (!STAFF_ROLES.has(profile.role)) continue
      if (profile.storeIds.includes(storeId)) continue

      await ctx.db.patch(profile._id, {
        storeIds: [...profile.storeIds, storeId],
        updatedAt: now,
      })
      profilesAttached += 1
    }

    // --- One product that tracks its stock ----------------------------------
    //
    // The inventory editor only exists for a tracked product; with none, the
    // quantity column is a row of dashes and the test for its +/- buttons had
    // nothing to look at.
    const firstProduct = await ctx.db
      .query("products")
      .filter((q) =>
        q.and(
          q.eq(q.field("storeId"), storeId),
          q.eq(q.field("slug"), PRODUCTS[0]!.slug)
        )
      )
      .first()

    let stockTracked = false
    if (firstProduct && !firstProduct.stock?.tracked) {
      await ctx.db.patch(firstProduct._id, {
        stock: {
          tracked: true,
          quantity: 12,
          lowStockThreshold: 3,
          autoDisableWhenEmpty: false,
        },
        updatedAt: now,
      })
      stockTracked = true
    }

    // --- A blog category ----------------------------------------------------
    const existingBlogCategory = await ctx.db
      .query("blogCategories")
      .filter((q) =>
        q.and(
          q.eq(q.field("storeId"), storeId),
          q.eq(q.field("slug"), BLOG_CATEGORY.slug)
        )
      )
      .first()

    if (!existingBlogCategory) {
      await ctx.db.insert("blogCategories", {
        storeId,
        name: BLOG_CATEGORY.name,
        slug: BLOG_CATEGORY.slug,
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      })
    }

    // --- The sender address -------------------------------------------------
    const existingEmailConfig = await ctx.db
      .query("emailConfig")
      .withIndex("by_storeId", (q) => q.eq("storeId", storeId))
      .first()

    if (!existingEmailConfig) {
      await ctx.db.insert("emailConfig", {
        storeId,
        senderName: EMAIL_SENDER.senderName,
        fromEmail: EMAIL_SENDER.fromEmail,
        replyToEmail: EMAIL_SENDER.replyToEmail,
        branding: {
          primaryColor: "#0D5C3F",
          secondaryColor: "#F97316",
          footerText: "Chez Luigi — établissement de test",
        },
        unsubscribeText: "Se désinscrire",
        maxEmailsPerWeek: 3,
        automationSettings: {
          welcomeEnabled: false,
          postOrderEnabled: false,
          birthdayEnabled: false,
          inactiveEnabled: false,
          abandonedCartEnabled: false,
        },
        createdAt: now,
        updatedAt: now,
      })
    }

    // --- Auto Blog on the owner accounts ------------------------------------
    //
    // Entitlements hang off the Better Auth user id, which is what
    // `getAccessStatus` reads from the session. Owners only: this grants a paid
    // feature, and a test deployment is the only place that is acceptable.
    let ownersEntitled = 0

    for (const profile of profiles) {
      if (profile.role !== "client_admin") continue

      const existingEntitlement = await ctx.db
        .query("ownerEntitlements")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", profile.userId))
        .first()

      const autoBlog = {
        enabled: true,
        plan: "pro" as const,
        monthlyQuota: 30,
        allowMultiLanguage: true,
        allowAutoPublish: true,
        monthlyImageQuota: 100,
      }

      if (existingEntitlement) {
        if (existingEntitlement.autoBlog.enabled) continue
        await ctx.db.patch(existingEntitlement._id, { autoBlog, updatedAt: now })
      } else {
        await ctx.db.insert("ownerEntitlements", {
          ownerId: profile.userId,
          autoBlog,
          imageToProduct: { enabled: true, monthlyAnalysisQuota: 50 },
          createdAt: now,
          updatedAt: now,
        })
      }
      ownersEntitled += 1
    }

    // --- A template and one draft campaign ----------------------------------
    //
    // The campaign row actions — preview, send a test, duplicate — live in a
    // dropdown on a table row, so with an empty table seven tests skipped
    // themselves with "No campaigns in table to test". A campaign needs a
    // template, so both are seeded.
    //
    // Draft on purpose: a draft has never been sent and never will be by
    // sitting here, so nothing in this fixture can put mail on the wire.
    const existingTemplate = await ctx.db
      .query("emailTemplates")
      .withIndex("by_storeId", (q) => q.eq("storeId", storeId))
      .first()

    const templateId =
      existingTemplate?._id ??
      (await ctx.db.insert("emailTemplates", {
        storeId,
        name: "Modèle de test",
        subject: "Des nouvelles de Chez Luigi",
        previewText: "Nos plats de la semaine",
        category: "marketing" as const,
        blocks: [
          {
            type: "heading" as const,
            id: "heading-1",
            content: "Des nouvelles de Chez Luigi",
            level: "h1" as const,
            alignment: "center" as const,
          },
          {
            type: "text" as const,
            id: "text-1",
            content: "Découvrez nos plats de la semaine.",
            alignment: "left" as const,
          },
        ],
        createdAt: now,
        updatedAt: now,
      }))

    const existingCampaign = await ctx.db
      .query("emailCampaigns")
      .withIndex("by_storeId", (q) => q.eq("storeId", storeId))
      .first()

    if (!existingCampaign) {
      await ctx.db.insert("emailCampaigns", {
        storeId,
        name: "Campagne de test",
        subject: "Des nouvelles de Chez Luigi",
        previewText: "Nos plats de la semaine",
        templateId,
        status: "draft" as const,
        abTestEnabled: false,
        stats: {
          sent: 0,
          delivered: 0,
          opened: 0,
          clicked: 0,
          bounced: 0,
          unsubscribed: 0,
          converted: 0,
          revenue: 0,
        },
        createdAt: now,
        updatedAt: now,
      })
    }

    // --- The team registry --------------------------------------------------
    //
    // Five tests skipped themselves on "this store has no table to inspect":
    // the Équipe screen answers "Aucun membre" with an empty registry, so the
    // columns, the row dropdown and the edit and delete dialogs had nothing to
    // open.
    //
    // `userId` is stamped on the accepted rows from the matching profile, which
    // is what accepting an invitation produces — a row with an email and no
    // account behind it would look accepted while being unreachable.
    const profilesByUserId = new Map(profiles.map((p) => [p.userId, p]))
    let teamMembersCreated = 0

    for (const member of TEAM) {
      const found = await ctx.db
        .query("teamMembers")
        .withIndex("by_email", (q) => q.eq("email", member.email))
        .first()
      if (found) continue

      // The seeded profiles carry no email, so the role is what ties a row to
      // an account here; each seeded role is held by exactly one account.
      const profile = [...profilesByUserId.values()].find(
        (p) => p.role === member.role && p.storeIds.includes(storeId)
      )

      await ctx.db.insert("teamMembers", {
        storeId,
        allStores: false,
        userId: member.status === "accepted" ? profile?.userId : undefined,
        name: member.name,
        email: member.email,
        role: member.role,
        permissions: [],
        invitationStatus: member.status,
        invitedAt: now,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      teamMembersCreated += 1
    }

    // --- Two orders to open -------------------------------------------------
    //
    // See `ORDERS` above for why they are inserted rather than placed.
    //
    // Idempotent on `idempotencyKey` through `by_storeId_idempotencyKey`, the
    // index the checkout's own replay guard uses: CI retries a failed test twice
    // against this deployment and the seed step itself is re-runnable, so a
    // second pass must not write a third order.
    const catalogue = await ctx.db
      .query("products")
      .filter((q) => q.eq(q.field("storeId"), storeId))
      .collect()
    const productBySlug = new Map(catalogue.map((product) => [product.slug, product]))

    let ordersCreated = 0

    // Oldest first, so the numbers `allocateOrderNumber` hands out run in the
    // same direction as the dates printed beside them. Nothing enforces that
    // for orders — only the invoice series is legally chronological — but a
    // fixture whose ORD-…-00002 was placed before its ORD-…-00001 is a
    // confusing thing to hand somebody debugging a screen.
    const chronological = [...ORDERS].sort(
      (a, b) => b.placedMinutesAgo - a.placedMinutesAgo
    )

    for (const order of chronological) {
      const alreadyPlaced = await ctx.db
        .query("orders")
        .withIndex("by_storeId_idempotencyKey", (q) =>
          q.eq("storeId", storeId).eq("idempotencyKey", order.idempotencyKey)
        )
        .first()
      if (alreadyPlaced) continue

      const items = order.lines.map((line) => {
        const product = productBySlug.get(line.slug)

        // LOUDLY, NOT SKIPPED. This used to drop the line and then skip the
        // whole order, on the reasoning that half an order is a worse fixture
        // than none. True, and it left the third possibility out: NO order,
        // reported by nothing. `ordersCreated` would have said 1 where it
        // should say 2 and no caller reads that number — `seed-users.mts`
        // prints only the summary's last line. The failure would have surfaced
        // as `order-detail.spec.ts` announcing "no order to open", pointing a
        // reader at the spec when the fault is in the catalogue above.
        //
        // A fixture that cannot build what it promised is a broken fixture, and
        // the seed step is where it should say so. Same reasoning as
        // `seed-users.mts`: a seed announcing success while leaving the
        // database unusable is worse than one that crashes.
        if (!product) {
          throw new Error(
            `seedFixture: order "${order.idempotencyKey}" needs product ` +
              `"${line.slug}", which is not in ${STORE_SLUG}'s catalogue. ` +
              `PRODUCTS and ORDERS above have drifted apart.`
          )
        }

        return {
          productId: product._id,
          productName: product.name,
          quantity: line.quantity,
          unitPrice: product.price,
          selectedOptions: [],
          subtotal: product.price * line.quantity,
          // Read off the product rather than restated here, so retaxing the
          // catalogue above cannot leave the seeded VAT describing the old
          // rate. Recorded on the line for the same reason the create path
          // records it: a product retaxed later must not restate a past
          // order's tax.
          taxRatePercent: product.taxRate,
        }
      })

      const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0)

      const { taxAmount, taxBreakdown, total } = computeOrderTotals({
        subtotal,
        // Unused: every line below carries its own rate, and `lines` wins. It
        // is required by the input type, which exists for callers holding only
        // a basket total.
        taxRatePercent: items[0]!.taxRatePercent,
        lines: items.map((item) => ({
          subtotal: item.subtotal,
          taxRatePercent: item.taxRatePercent,
        })),
        deliveryFee: order.deliveryFee,
        // No `deliveryTaxRatePercent`, deliberately: whether a delivery charge
        // is accessory to the meal or a separate supply decides its French VAT
        // rate, and `computeOrderTotals` leaves the fee out of the breakdown
        // rather than guessing. A fixture is not the place to decide it.
      })

      const placedAt = now - order.placedMinutesAgo * 60_000

      await ctx.db.insert("orders", {
        storeId,
        orderNumber: await allocateOrderNumber(ctx, storeId, { now: placedAt }),
        customerInfo: order.customerInfo,
        // The key the customer book is indexed on — lower-cased and trimmed,
        // as `orders.create` writes it. Without it the seeded diner has no
        // order history on their customer page.
        customerEmailKey: order.customerInfo.email.trim().toLowerCase(),
        type: order.type,
        tableNumber: order.tableNumber,
        status: order.status,
        items,
        subtotal,
        taxAmount,
        taxBreakdown,
        deliveryFee: order.deliveryFee,
        total,
        deliveryAddress: order.deliveryAddress,
        paymentMethod: order.paymentMethod,
        paymentStatus: "paid" as const,
        source: "website" as const,
        idempotencyKey: order.idempotencyKey,
        createdAt: placedAt,
        updatedAt: placedAt,
      })
      ordersCreated += 1
    }

    return {
      storeId,
      storeCreated: !existing,
      teamMembersCreated,
      ordersCreated,
      templateCreated: !existingTemplate,
      campaignCreated: !existingCampaign,
      categories: categoryIds.size,
      productsCreated,
      profilesAttached,
      stockTracked,
      blogCategoryCreated: !existingBlogCategory,
      emailConfigured: !existingEmailConfig,
      ownersEntitled,
    }
  },
})
