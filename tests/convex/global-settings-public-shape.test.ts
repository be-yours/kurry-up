// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Exactly what an anonymous visitor reads out of `globalSettings` (#620).
 *
 * The public query was a STRIP: take the whole document, delete the four Uber
 * Direct credentials, return the rest. A strip is right only about the fields
 * somebody thought of. Measured at `ba2cdb5f`, an unauthenticated caller —
 * the storefront checkout calls this before any sign-in — received
 * `payments.paypalEmail`, both platform `priceMarkup` percentages,
 * `systemLock.lockedBy`, `appliedMigrations`, `deployedAppVersion` and
 * `lastBackupAt`, and nothing in the suite said otherwise.
 *
 * So this file pins the set. It fails when a key is ADDED as loudly as when one
 * is removed, which is the direction that matters: a new column on
 * `globalSettings` is private until somebody puts it on the list on purpose.
 */

import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")
const NOW = 1_700_000_000_000

/** A settings document with something private in every field that has ever leaked. */
async function seedSettings(t: ReturnType<typeof convexTest>) {
  await t.run((ctx) =>
    ctx.db.insert("globalSettings", {
      currency: "EUR",
      timezone: "Europe/Paris",
      taxRate: 10,
      services: { dineIn: true, takeaway: true, delivery: true, clickAndCollect: true },
      minimumOrderAmount: 1500,
      deliveryTaxRate: 20,
      hours: [{ day: 1, open: "09:00", close: "22:00", isClosed: false }],
      delivery: { feeMode: "fixed" as const, fee: 300, radius: 5 },
      seller: {
        legalName: "Chez Luigi SAS",
        siren: "123456789",
        siret: "12345678900011",
        vatNumber: "FR12345678900",
      },
      payments: {
        cardProvider: "stripe" as const,
        paypal: true,
        paypalEmail: "argent@chez-luigi.fr",
        cash: true,
      },
      integrations: {
        uberDirect: {
          enabled: true,
          customerId: "cus_secret",
          clientId: "id_secret",
          clientSecret: "shhh",
          apiKey: "key_secret",
        },
        uberEats: { enabled: true, priceMarkup: 30 },
        deliveroo: { enabled: false, priceMarkup: 25 },
      },
      deployedAppVersion: "1.4.2",
      lastBackupAt: NOW,
      appliedMigrations: [{ id: "m1", name: "one", appliedAt: NOW }],
      systemLock: {
        operation: "backup",
        lockedBy: "user:owner",
        lockedAt: NOW,
        expiresAt: NOW + 60_000,
      },
      updatedAt: NOW,
    })
  )
}

describe("what an anonymous caller receives", () => {
  test("carries only the keys the storefront and the open admin screens read", async () => {
    const t = convexTest(schema, modules)
    await seedSettings(t)

    const settings = (await t.query(api.globalSettings.get, {})) as Record<string, unknown>

    expect(Object.keys(settings).sort()).toEqual(
      [
        "_creationTime",
        "_id",
        "currency",
        "delivery",
        "hours",
        "integrations",
        "minimumOrderAmount",
        "payments",
        "seller",
        "services",
        "taxRate",
        "timezone",
      ].sort()
    )
  })

  test("does not carry the platform markups", async () => {
    // The commercial figure: the percentage the establishment adds to its
    // prices on Uber Eats and Deliveroo. Applied server-side by the menu syncs,
    // read by nothing on the storefront, and readable from the browser console.
    const t = convexTest(schema, modules)
    await seedSettings(t)

    const settings = (await t.query(api.globalSettings.get, {})) as {
      integrations: Record<string, Record<string, unknown>>
    }

    expect(settings.integrations.uberEats).toEqual({ enabled: true })
    expect(settings.integrations.deliveroo).toEqual({ enabled: false })
    // The name too, not only the value: a renamed field must not slip back in.
    expect(JSON.stringify(settings)).not.toContain("priceMarkup")
    // The values themselves, bounded to the integrations block — `300` is a
    // delivery fee and `30` is a substring of it, so a whole-document search
    // for the number is vacuous.
    expect(JSON.stringify(settings.integrations)).not.toContain("30")
    expect(JSON.stringify(settings.integrations)).not.toContain("25")
  })

  test("does not carry the PayPal payee account", async () => {
    const t = convexTest(schema, modules)
    await seedSettings(t)
    const settings = (await t.query(api.globalSettings.get, {})) as {
      payments: Record<string, unknown>
    }
    expect(settings.payments).toEqual({
      cardProvider: "stripe",
      paypal: true,
      cash: true,
    })
  })

  test("still strips the four Uber Direct credentials", async () => {
    // The thing the old strip DID get right; it must not be lost in the rewrite.
    const t = convexTest(schema, modules)
    await seedSettings(t)
    const body = JSON.stringify(await t.query(api.globalSettings.get, {}))
    for (const secret of ["cus_secret", "id_secret", "shhh", "key_secret"]) {
      expect(body).not.toContain(secret)
    }
  })

  test("does not carry the deployment's own state", async () => {
    const t = convexTest(schema, modules)
    await seedSettings(t)
    const body = JSON.stringify(await t.query(api.globalSettings.get, {}))
    for (const leaked of ["user:owner", "1.4.2", "appliedMigrations", "lastBackupAt"]) {
      expect(body).not.toContain(leaked)
    }
  })

  test("still carries what the checkout actually needs", async () => {
    // Anti-vacuity, and the failure that would matter most: an allow-list that
    // dropped `payments` or `delivery` takes the checkout out.
    const t = convexTest(schema, modules)
    await seedSettings(t)
    const settings = (await t.query(api.globalSettings.get, {})) as Record<string, unknown>

    expect(settings.currency).toBe("EUR")
    expect(settings.taxRate).toBe(10)
    expect(settings.timezone).toBe("Europe/Paris")
    expect(settings.delivery).toMatchObject({ fee: 300 })
    expect((settings.integrations as Record<string, unknown>).uberDirect).toEqual({
      enabled: true,
    })
    expect(settings.seller).toMatchObject({ siret: "12345678900011" })
  })

  test("answers null for a deployment with no settings row", async () => {
    const t = convexTest(schema, modules)
    expect(await t.query(api.globalSettings.get, {})).toBeNull()
  })
})
