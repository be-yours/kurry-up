// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The Resend feedback webhook, end to end, through the real HTTP route.
 *
 * WHAT WAS BROKEN (#444). `EMAIL_PROVIDER=resend` is the escape hatch for a
 * client whose AWS SES production-access request was refused — every client
 * owns its own AWS account, files its own request, and approval is not
 * guaranteed; one has been refused. That deployment shipped with
 * `/webhooks/ses` as the ONLY feedback endpoint in the app, and SNS never
 * calls it, so:
 *
 *  - a hard bounce never suppressed the address, and the dead mailbox was
 *    re-mailed on every campaign;
 *  - a spam report was never recorded, so the complaint rate the provider
 *    measures and the one the product displays had nothing to do with each
 *    other;
 *  - « Délivrés » read 0 for ever.
 *
 * The first symptom available to anybody was the sending domain being
 * throttled, with nothing in the product explaining why.
 *
 * These tests drive `t.fetch("/webhooks/resend")` — the registered route, not
 * the handler — because the defect was the absence of a route. A test that
 * called a handler directly would have passed on the broken tree.
 */

import { convexTest } from "convex-test"
import { afterEach, beforeAll, describe, expect, test } from "vitest"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000
/**
 * The signing secret, as Svix writes one: `whsec_` plus base64 of the key.
 *
 * Computed rather than pasted. A base64 literal beside a name ending in
 * `_SECRET` is what gitleaks' `generic-api-key` rule looks for, and the right
 * answer to a scanner firing on a fixture is to stop writing a credential-
 * shaped literal — not to allowlist the file, which silences the rule for
 * whatever is added to it later.
 */
const SECRET_B64 = btoa("resend-webhook-test-key")
const SECRET = `whsec_${SECRET_B64}`
const MSG_ID = "msg_2abcDEF"

beforeAll(() => {
  // The env schema is parsed as a whole, so the variables it requires have to
  // be present or the handler fails for the wrong reason and a response-policy
  // assertion passes on a lie.
  process.env.OPENAI_API_KEY = "sk-test"
  process.env.RESEND_WEBHOOK_SECRET = SECRET
})

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

afterEach(async () => {
  for (const t of harnesses) {
    await t.finishInProgressScheduledFunctions()
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
// Signing — the real Svix scheme, so the tests go through the real door
// ===========================================================================

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/** HMAC-SHA256 over `<id>.<timestamp>.<body>`, base64, as Svix signs. */
async function sign(id: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(SECRET_B64) as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`) as unknown as ArrayBuffer
  )
  return bytesToBase64(new Uint8Array(signature))
}

async function post(
  t: ReturnType<typeof convexTest>,
  payload: unknown,
  over: {
    id?: string
    timestamp?: string
    signature?: string
    omitHeaders?: boolean
  } = {}
) {
  const body = JSON.stringify(payload)
  const id = over.id ?? MSG_ID
  const timestamp = over.timestamp ?? String(Math.floor(Date.now() / 1000))
  const signature = over.signature ?? `v1,${await sign(id, timestamp, body)}`
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (!over.omitHeaders) {
    headers["svix-id"] = id
    headers["svix-timestamp"] = timestamp
    headers["svix-signature"] = signature
  }
  return t.fetch("/webhooks/resend", { method: "POST", headers, body })
}

// ===========================================================================
// Fixtures
// ===========================================================================

async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Luigi",
      slug: "luigi",
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

async function seedSubscriber(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  email = "diner@example.com",
  bounceCount = 0
) {
  return t.run((ctx) =>
    ctx.db.insert("emailSubscribers", {
      storeId,
      email,
      status: "active" as const,
      source: "storefront_form" as const,
      tags: [],
      consentAt: NOW,
      consentSource: "test",
      bounceCount,
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

async function seedCampaign(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
  return t.run(async (ctx) => {
    const templateId = await ctx.db.insert("emailTemplates", {
      storeId,
      name: "Brunch",
      subject: "Brunch",
      blocks: [],
      category: "marketing" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
    return ctx.db.insert("emailCampaigns", {
      storeId,
      name: "Brunch de samedi",
      subject: "Brunch",
      templateId,
      status: "sent" as const,
      abTestEnabled: false,
      stats: {
        sent: 1,
        delivered: 0,
        opened: 0,
        clicked: 0,
        bounced: 0,
        unsubscribed: 0,
        converted: 0,
        revenue: 0,
      },
      createdAt: NOW,
      updatedAt: NOW,
    })
  })
}

const subscriberRow = (t: ReturnType<typeof convexTest>, id: Id<"emailSubscribers">) =>
  t.run((ctx) => ctx.db.get(id))

const campaignRow = (t: ReturnType<typeof convexTest>, id: Id<"emailCampaigns">) =>
  t.run((ctx) => ctx.db.get(id))

const events = (t: ReturnType<typeof convexTest>) =>
  t.run((ctx) => ctx.db.query("emailEvents").collect())

function payload(
  type: string,
  over: {
    to?: string[]
    headers?: Array<{ name: string; value: string }> | Record<string, string>
    bounce?: { type?: string }
    click?: { link?: string }
  } = {}
) {
  return {
    type,
    created_at: new Date(NOW).toISOString(),
    data: {
      email_id: "b4f1e1a0-0000-0000-0000-000000000000",
      from: "resto@example.com",
      subject: "Brunch",
      to: over.to ?? ["diner@example.com"],
      ...(over.headers ? { headers: over.headers } : {}),
      ...(over.bounce ? { bounce: over.bounce } : {}),
      ...(over.click ? { click: over.click } : {}),
    },
  }
}

// ===========================================================================
// The route exists at all — the whole of #444
// ===========================================================================

describe("the route", () => {
  test("is registered, so a Resend deployment has a feedback path", async () => {
    // The bug WAS the absent route. On the broken tree this 404s.
    const t = newHarness()
    const response = await post(t, payload("email.delivery_delayed"))
    expect(response.status).not.toBe(404)
    expect(response.status).toBe(200)
  })
})

// ===========================================================================
// Authentication — every one of these is a door onto `markBounced`
// ===========================================================================

describe("authentication", () => {
  test("a correctly signed delivery is accepted", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId)

    const response = await post(
      t,
      payload("email.bounced", {
        headers: [
          { name: "X-Store-Id", value: storeId },
          { name: "X-Subscriber-Id", value: subscriberId },
        ],
        bounce: { type: "Permanent" },
      })
    )

    expect(response.status).toBe(200)
    expect((await subscriberRow(t, subscriberId))?.status).toBe("bounced")
  })

  test("a forged signature is refused, and nothing is suppressed", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId)

    const response = await post(
      t,
      payload("email.bounced", {
        headers: [
          { name: "X-Store-Id", value: storeId },
          { name: "X-Subscriber-Id", value: subscriberId },
        ],
        bounce: { type: "Permanent" },
      }),
      { signature: "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
    )

    expect(response.status).toBe(401)
    const row = await subscriberRow(t, subscriberId)
    expect(row?.status).toBe("active")
    expect(row?.bounceCount).toBe(0)
    expect(await events(t)).toHaveLength(0)
  })

  test("a body altered after signing is refused", async () => {
    // The signature covers the body, so this is the property that stops an
    // attacker renaming the subscriber in a genuine delivery.
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId)

    const honest = payload("email.opened", {
      headers: [
        { name: "X-Store-Id", value: storeId },
        { name: "X-Subscriber-Id", value: subscriberId },
      ],
    })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = `v1,${await sign(MSG_ID, timestamp, JSON.stringify(honest))}`

    const tampered = payload("email.complained", {
      headers: [
        { name: "X-Store-Id", value: storeId },
        { name: "X-Subscriber-Id", value: subscriberId },
      ],
    })
    const response = await post(t, tampered, { timestamp, signature })

    expect(response.status).toBe(401)
    expect((await subscriberRow(t, subscriberId))?.status).toBe("active")
  })

  test("a replay outside the window is refused", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId)

    const stale = String(Math.floor(Date.now() / 1000) - 6 * 60)
    const body = payload("email.bounced", {
      headers: [
        { name: "X-Store-Id", value: storeId },
        { name: "X-Subscriber-Id", value: subscriberId },
      ],
      bounce: { type: "Permanent" },
    })
    const signature = `v1,${await sign(MSG_ID, stale, JSON.stringify(body))}`

    const response = await post(t, body, { timestamp: stale, signature })

    // 400, not 401: the message may well have been genuine when it was signed.
    expect(response.status).toBe(400)
    expect((await subscriberRow(t, subscriberId))?.status).toBe("active")
  })

  test("a delivery with no signature headers is refused", async () => {
    const t = newHarness()
    const response = await post(t, payload("email.bounced"), { omitHeaders: true })
    expect(response.status).toBe(400)
  })

  test("a version this code cannot check is refused, not treated as opaque", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId)
    const body = payload("email.bounced", {
      headers: [
        { name: "X-Store-Id", value: storeId },
        { name: "X-Subscriber-Id", value: subscriberId },
      ],
    })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const response = await post(t, body, {
      timestamp,
      signature: `v2,${await sign(MSG_ID, timestamp, JSON.stringify(body))}`,
    })
    expect(response.status).toBe(400)
    expect((await subscriberRow(t, subscriberId))?.status).toBe("active")
  })

  test("a rotation signature is accepted when either candidate matches", async () => {
    // Svix signs one delivery with both secrets while a secret is rotating.
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId)
    const body = payload("email.complained", {
      headers: [
        { name: "X-Store-Id", value: storeId },
        { name: "X-Subscriber-Id", value: subscriberId },
      ],
    })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const good = await sign(MSG_ID, timestamp, JSON.stringify(body))

    const response = await post(t, body, {
      timestamp,
      signature: `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= v1,${good}`,
    })

    expect(response.status).toBe(200)
    expect((await subscriberRow(t, subscriberId))?.status).toBe("complained")
  })

  test("an unset secret refuses rather than processing an unverified body", async () => {
    // FAILS CLOSED. The alternative is the exact defect /webhooks/ses shipped
    // with: this handler suppresses addresses named in the body.
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId)
    const previous = process.env.RESEND_WEBHOOK_SECRET
    delete process.env.RESEND_WEBHOOK_SECRET
    try {
      const response = await post(
        t,
        payload("email.bounced", {
          headers: [
            { name: "X-Store-Id", value: storeId },
            { name: "X-Subscriber-Id", value: subscriberId },
          ],
          bounce: { type: "Permanent" },
        })
      )
      // 401, not 200: Svix retries a non-2xx for a day, so an operator setting
      // the secret in that window gets the backlog rather than a silent hole.
      expect(response.status).toBe(401)
      expect((await subscriberRow(t, subscriberId))?.status).toBe("active")
    } finally {
      process.env.RESEND_WEBHOOK_SECRET = previous
    }
  })
})

// ===========================================================================
// What each event does — suppression is the point of the whole path
// ===========================================================================

describe("suppression", () => {
  test("a permanent bounce suppresses the address on the first strike", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId)
    const campaignId = await seedCampaign(t, storeId)

    await post(
      t,
      payload("email.bounced", {
        headers: [
          { name: "X-Store-Id", value: storeId },
          { name: "X-Subscriber-Id", value: subscriberId },
          { name: "X-Campaign-Id", value: campaignId },
        ],
        bounce: { type: "Permanent" },
      })
    )

    const row = await subscriberRow(t, subscriberId)
    expect(row?.status).toBe("bounced")
    expect(row?.bounceCount).toBe(1)
    expect((await campaignRow(t, campaignId))?.stats.bounced).toBe(1)
    expect((await events(t)).map((e) => e.type)).toEqual(["bounced"])
  })

  test("a transient bounce counts but does not suppress until the third", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId, "diner@example.com", 1)

    await post(
      t,
      payload("email.bounced", {
        headers: [
          { name: "X-Store-Id", value: storeId },
          { name: "X-Subscriber-Id", value: subscriberId },
        ],
        bounce: { type: "Transient" },
      })
    )

    const row = await subscriberRow(t, subscriberId)
    expect(row?.status).toBe("active")
    expect(row?.bounceCount).toBe(2)
  })

  test("`email.failed` is read as a bounce, because that is what it is", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId, "diner@example.com", 2)

    await post(
      t,
      payload("email.failed", {
        headers: [
          { name: "X-Store-Id", value: storeId },
          { name: "X-Subscriber-Id", value: subscriberId },
        ],
      })
    )

    // No classification, so it suppresses on the third strike only — the
    // cautious reading `markBounced` already implements.
    const row = await subscriberRow(t, subscriberId)
    expect(row?.bounceCount).toBe(3)
    expect(row?.status).toBe("bounced")
  })

  test("a complaint suppresses, and counts as an unsubscribe", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId)
    const campaignId = await seedCampaign(t, storeId)

    await post(
      t,
      payload("email.complained", {
        headers: [
          { name: "X-Store-Id", value: storeId },
          { name: "X-Subscriber-Id", value: subscriberId },
          { name: "X-Campaign-Id", value: campaignId },
        ],
      })
    )

    expect((await subscriberRow(t, subscriberId))?.status).toBe("complained")
    expect((await campaignRow(t, campaignId))?.stats.unsubscribed).toBe(1)
  })

  test("a bounce with no correlation headers still suppresses, by address", async () => {
    // The address is the one thing every provider always sends, and a hard
    // bounce is about the address rather than the campaign. Without this
    // fallback a send that did not set the headers loses every bounce.
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId, "diner@example.com")

    await post(
      t,
      payload("email.bounced", {
        to: ["DINER@example.com"],
        bounce: { type: "Permanent" },
      })
    )

    expect((await subscriberRow(t, subscriberId))?.status).toBe("bounced")
  })

  test("a delivery with no correlation headers is NOT attributed by address", async () => {
    // Attributing a statistic to a store that did not send the message would
    // corrupt the figure rather than complete it.
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedSubscriber(t, storeId)

    const response = await post(t, payload("email.delivered"))

    expect(response.status).toBe(200)
    expect(await events(t)).toHaveLength(0)
  })
})

// ===========================================================================
// Statistics
// ===========================================================================

describe("statistics", () => {
  test("a delivery moves « Délivrés », which read 0 for ever before", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId)
    const campaignId = await seedCampaign(t, storeId)

    await post(
      t,
      payload("email.delivered", {
        headers: [
          { name: "X-Store-Id", value: storeId },
          { name: "X-Subscriber-Id", value: subscriberId },
          { name: "X-Campaign-Id", value: campaignId },
        ],
      })
    )

    expect((await campaignRow(t, campaignId))?.stats.delivered).toBe(1)
    expect((await events(t)).map((e) => e.type)).toEqual(["delivered"])
  })

  test("a click records the link it was on", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId)
    const campaignId = await seedCampaign(t, storeId)

    await post(
      t,
      payload("email.clicked", {
        headers: [
          { name: "X-Store-Id", value: storeId },
          { name: "X-Subscriber-Id", value: subscriberId },
          { name: "X-Campaign-Id", value: campaignId },
        ],
        click: { link: "https://luigi.example/carte" },
      })
    )

    const [event] = await events(t)
    expect(event.type).toBe("clicked")
    expect(event.metadata?.linkUrl).toBe("https://luigi.example/carte")
    expect((await campaignRow(t, campaignId))?.stats.clicked).toBe(1)
  })

  test("the provider's echo of a send does not double « Envoyés »", async () => {
    // The sender increments `sent` when it hands the message over. Counting
    // Resend's `email.sent` again would double every campaign's figure.
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId)
    const campaignId = await seedCampaign(t, storeId)

    await post(
      t,
      payload("email.sent", {
        headers: [
          { name: "X-Store-Id", value: storeId },
          { name: "X-Subscriber-Id", value: subscriberId },
          { name: "X-Campaign-Id", value: campaignId },
        ],
      })
    )

    expect((await campaignRow(t, campaignId))?.stats.sent).toBe(1)
    expect((await events(t)).map((e) => e.type)).toEqual(["sent"])
  })

  test("a delay records nothing — Resend follows it with the real outcome", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId)
    const campaignId = await seedCampaign(t, storeId)

    const response = await post(
      t,
      payload("email.delivery_delayed", {
        headers: [
          { name: "X-Store-Id", value: storeId },
          { name: "X-Subscriber-Id", value: subscriberId },
          { name: "X-Campaign-Id", value: campaignId },
        ],
      })
    )

    expect(response.status).toBe(200)
    expect(await events(t)).toHaveLength(0)
  })
})

// ===========================================================================
// The header shapes Resend has actually used
// ===========================================================================

describe("correlation headers", () => {
  test("are read from a flat object as well as an array", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedSubscriber(t, storeId)

    await post(
      t,
      payload("email.complained", {
        headers: { "x-store-id": storeId, "x-subscriber-id": subscriberId },
      })
    )

    // Case-insensitively: HTTP header names are, and a provider that
    // lower-cases them on the way out is within its rights.
    expect((await subscriberRow(t, subscriberId))?.status).toBe("complained")
  })
})
