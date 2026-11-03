// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The delivery fee reaches the VAT breakdown, because an owner can now state
 * its rate (#615).
 *
 * WHAT SHIPPED. `orders.ts:1469` read `globalSettings.deliveryTaxRate` and
 * `orderTotals.ts:83` said, in as many words, "`globalSettings.deliveryTaxRate`
 * is where an owner states it". The field was declared on the table and was in
 * **no mutation validator and on no screen** — so it was `undefined` on every
 * deployment, and `computeOrderTotals` left the delivery fee out of the
 * breakdown on every order that carried one.
 *
 * Leaving it out is the right behaviour for an undecided rate: which rate a
 * delivery charge carries in France depends on whether it is an accessory to
 * the meal or a separate service, and guessing wrong misdeclares VAT on every
 * delivery the establishment makes. The defect was that it could never be
 * decided.
 *
 * THIS IS THE ROUND TRIP. The value the mutation writes is the value the order
 * path reads — asserted through the real mutation and the real query rather
 * than by reading the two constants and comparing them.
 */

import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import schema from "../../convex/schema"
import { computeOrderTotals } from "@be-yours/convex-functions/orderTotals"

const modules = import.meta.glob("../../convex/**/*.ts")
const NOW = 1_700_000_000_000

async function asOwner(t: ReturnType<typeof convexTest>) {
  const storeId = await t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Luigi",
      slug: "chez-luigi",
      address: { street: "1 rue de la Paix", city: "Paris", postalCode: "75002", country: "France" },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: "user:owner",
      role: "client_admin" as const,
      storeIds: [storeId],
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject: "user:owner" })
}

describe("the rate an owner states", () => {
  test("is accepted by the mutation", async () => {
    // The whole defect in one assertion: this call used to be refused by the
    // validator, because `deliveryTaxRate` was not in it.
    const t = convexTest(schema, modules)
    const owner = await asOwner(t)

    await owner.mutation(api.globalSettings.upsert, { deliveryTaxRate: 10 })

    const stored = await t.run((ctx) => ctx.db.query("globalSettings").first())
    expect(stored?.deliveryTaxRate).toBe(10)
  })

  test("survives a save that does not mention it", async () => {
    // The settings screen saves tab by tab. A rate dropped by an unrelated
    // save would be the same defect with a longer fuse.
    const t = convexTest(schema, modules)
    const owner = await asOwner(t)

    await owner.mutation(api.globalSettings.upsert, { deliveryTaxRate: 10 })
    await owner.mutation(api.globalSettings.upsert, { taxRate: 5.5 })

    const stored = await t.run((ctx) => ctx.db.query("globalSettings").first())
    expect(stored?.deliveryTaxRate).toBe(10)
    expect(stored?.taxRate).toBe(5.5)
  })

  test("is what the order path reads", async () => {
    // `orders.ts` passes `globalSettings?.deliveryTaxRate` straight into
    // `computeOrderTotals` as `deliveryTaxRatePercent`. Reading it back through
    // the same query the order path uses is the round trip.
    const t = convexTest(schema, modules)
    const owner = await asOwner(t)
    await owner.mutation(api.globalSettings.upsert, { taxRate: 10, deliveryTaxRate: 20 })

    const settings = await t.run((ctx) => ctx.db.query("globalSettings").first())

    const totals = computeOrderTotals({
      subtotal: 2_000,
      taxRatePercent: settings?.taxRate,
      deliveryFee: 300,
      deliveryTaxRatePercent: settings?.deliveryTaxRate,
    })

    const rates = totals.taxBreakdown.map((entry) => entry.ratePercent).sort()
    expect(rates).toEqual([10, 20])
    const delivery = totals.taxBreakdown.find((entry) => entry.ratePercent === 20)
    expect(delivery?.grossAmount).toBe(300)
  })

  test("left blank, the fee stays out of the breakdown rather than taking the food's rate", async () => {
    // Anti-vacuity, and the behaviour that must NOT change: an undecided rate
    // is not a reason to declare the fee at 10%.
    const t = convexTest(schema, modules)
    const owner = await asOwner(t)
    await owner.mutation(api.globalSettings.upsert, { taxRate: 10 })

    const settings = await t.run((ctx) => ctx.db.query("globalSettings").first())
    expect(settings?.deliveryTaxRate).toBeUndefined()

    const totals = computeOrderTotals({
      subtotal: 2_000,
      taxRatePercent: settings?.taxRate,
      deliveryFee: 300,
      deliveryTaxRatePercent: settings?.deliveryTaxRate,
    })

    expect(totals.taxBreakdown.map((entry) => entry.ratePercent)).toEqual([10])
    expect(totals.taxBreakdown[0]?.grossAmount).toBe(2_000)
  })

  /*
   * NOT ASSERTED HERE: that an anonymous visitor cannot read the rate.
   *
   * It is a fiscal setting rather than a storefront one, so it should not be in
   * the public payload — and that is exactly what #620 is for. That change
   * inverts `globalSettings.get` from a strip into an allow-list and pins the
   * EXACT public key set in `global-settings-public-shape.test.ts`, so a field
   * added to this table is private by construction and fails there if somebody
   * adds it on purpose without saying why.
   *
   * Asserting it a second time here would duplicate that guarantee and, while
   * #620 is on a separate branch, would fail for a reason that has nothing to
   * do with this change.
   */
})
