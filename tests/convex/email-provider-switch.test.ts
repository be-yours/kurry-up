// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * A client whose SES request is refused can still send (#212).
 *
 * Every client owns its AWS account and files its own SES production-access
 * request. Approval is not guaranteed and one has already been refused. Until
 * this, such a deployment had no path to sending email AT ALL — no order
 * confirmation, no password reset, no winning ticket — because the
 * `EMAIL_PROVIDER` switch existed in `apps/site` only and the engine
 * constructed an `SESv2Client` inline at five sites.
 *
 * These tests drive the real Convex action, not the resolver in isolation:
 * what has to be true is that flipping ONE environment variable on a client
 * deployment changes where its mail goes, with no code edit anywhere.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

/** Whatever the AWS SDK was asked to send, if anything. */
const sesSends: Array<Record<string, unknown>> = []

vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: class {
    async send(command: { input: Record<string, unknown> }) {
      sesSends.push(command.input)
      return { MessageId: "ses-1" }
    }
  },
  SendEmailCommand: class {
    input: Record<string, unknown>
    constructor(input: Record<string, unknown>) {
      this.input = input
    }
  },
}))

/** Whatever Resend's HTTP endpoint was asked to send, if anything. */
const resendPosts: Array<{ url: string; body: Record<string, unknown> }> = []

const NOW = 1_700_000_000_000

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

const modules = import.meta.glob("../../convex/**/*.ts")

beforeEach(() => {
  sesSends.length = 0
  resendPosts.length = 0
  vi.stubEnv("CONVEX_SITE_URL", "https://x.convex.site")
  vi.stubEnv("SITE_URL", "https://chez-luigi.fr")
  vi.stubEnv("AWS_REGION", "eu-west-3")
  vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIA-test")
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret-test")
  vi.stubEnv("AWS_SES_FROM_EMAIL", "no-reply@chez-luigi.fr")

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      resendPosts.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ id: "re-1" }), { status: 200 })
    })
  )
})

afterEach(async () => {
  for (const t of harnesses) {
    await t.run(async (ctx) => {
      const jobs = await ctx.db.system.query("_scheduled_functions").collect()
      for (const job of jobs) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id)
      }
    })
  }
  harnesses.length = 0
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

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

/**
 * A pending subscriber, created the way the storefront creates one.
 *
 * Through the real mutation rather than a hand-written row: the row's required
 * fields have grown more than once, and a fixture that predates one of them
 * fails as a validator error rather than as the thing the test is about.
 *
 * `subscribe` schedules `sendConfirmation`, so the queue is cleared before the
 * test drives that action itself — otherwise every assertion counts two sends,
 * one of them the scheduler's.
 */
async function seedPendingSubscriber(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">
) {
  await t.mutation(api.emailSubscribers.subscribe, {
    storeId,
    email: "yanis@resto.example",
  })
  const subscriber = await t.run(
    async (ctx) => (await ctx.db.query("emailSubscribers").collect())[0]
  )
  await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect()
    for (const job of jobs) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id)
    }
  })
  return subscriber!._id
}

describe("where a deployment's email actually goes", () => {
  test("SES by default, so no existing client moves", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedPendingSubscriber(t, storeId)

    await t.action(internal.emailAutomationActions.sendConfirmation, {
      subscriberId,
    })

    expect(sesSends).toHaveLength(1)
    expect(resendPosts).toHaveLength(0)
    expect(sesSends[0]?.FromEmailAddress).toBe("no-reply@chez-luigi.fr")
  })

  test("Resend when the deployment says so — one variable, no code change", async () => {
    // The whole point of #212. A client refused SES production access sets
    // these two on their Convex deployment and their diners hear from them
    // again; before, their only options were appealing to AWS or a patch to
    // five files in the engine.
    vi.stubEnv("EMAIL_PROVIDER", "resend")
    vi.stubEnv("RESEND_API_KEY", "re_test")

    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedPendingSubscriber(t, storeId)

    await t.action(internal.emailAutomationActions.sendConfirmation, {
      subscriberId,
    })

    expect(sesSends).toHaveLength(0)
    expect(resendPosts).toHaveLength(1)
    expect(resendPosts[0]?.url).toBe("https://api.resend.com/emails")
    expect(resendPosts[0]?.body.to).toEqual(["yanis@resto.example"])
    // The sender falls back to the address they had already verified for SES,
    // so flipping the switch does not silently change who the mail is from.
    expect(resendPosts[0]?.body.from).toBe("no-reply@chez-luigi.fr")
  })

  test("carries the bounce-correlation headers whichever provider sends", async () => {
    // `markBounced` suppresses a permanent bounce on the first event, and the
    // webhook correlates it by these two headers. Losing them on one transport
    // would mean a typo'd signup keeps costing sends on that transport only —
    // the kind of difference nobody would look for.
    vi.stubEnv("EMAIL_PROVIDER", "resend")
    vi.stubEnv("RESEND_API_KEY", "re_test")

    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedPendingSubscriber(t, storeId)

    await t.action(internal.emailAutomationActions.sendConfirmation, {
      subscriberId,
    })

    const headers = resendPosts[0]?.body.headers as Record<string, string>
    expect(headers["X-Subscriber-Id"]).toBe(String(subscriberId))
    expect(headers["X-Store-Id"]).toBe(String(storeId))
  })

  test("does not hand Resend an SES configuration set", async () => {
    // Resend has no equivalent. Sending the field anyway would leave a client
    // believing they still have open tracking after the migration.
    vi.stubEnv("EMAIL_PROVIDER", "resend")
    vi.stubEnv("RESEND_API_KEY", "re_test")
    vi.stubEnv("AWS_SES_CONFIGURATION_SET", "luigi-email-tracking")

    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedPendingSubscriber(t, storeId)

    await t.action(internal.emailAutomationActions.sendConfirmation, {
      subscriberId,
    })

    expect(resendPosts[0]?.body).not.toHaveProperty("configurationSet")
    expect(resendPosts[0]?.body).not.toHaveProperty("ConfigurationSetName")
  })

  test("refuses a provider name it does not know, rather than falling back", async () => {
    // A typo that silently kept sending through SES would be indistinguishable
    // from a working migration, on the very deployment that cannot use SES.
    vi.stubEnv("EMAIL_PROVIDER", "resnd")

    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedPendingSubscriber(t, storeId)

    await expect(
      t.action(internal.emailAutomationActions.sendConfirmation, { subscriberId })
    ).rejects.toThrow(/resnd/)

    expect(sesSends).toHaveLength(0)
    expect(resendPosts).toHaveLength(0)
  })

  test("does not fall back to the agency's own sender address", async () => {
    // Four call sites defaulted to `noreply@beindigital.fr`. That address is
    // the agency's: a client's own SES account cannot sign for it, so a
    // deployment that had not set AWS_SES_FROM_EMAIL sent from a domain it
    // could not authenticate — and the refusal was swallowed.
    vi.stubEnv("AWS_SES_FROM_EMAIL", "")

    const t = newHarness()
    const storeId = await seedStore(t)
    const subscriberId = await seedPendingSubscriber(t, storeId)

    await expect(
      t.action(internal.emailAutomationActions.sendConfirmation, { subscriberId })
    ).rejects.toThrow()

    expect(sesSends).toHaveLength(0)
    expect(
      [...sesSends, ...resendPosts.map((p) => p.body)].some((m) =>
        JSON.stringify(m).includes("beindigital.fr")
      )
    ).toBe(false)
  })
})

/**
 * Every transport a deployment may be switched to has a feedback path.
 *
 * WHAT WAS BROKEN (#444). `EMAIL_PROVIDER=resend` shipped with no feedback
 * route at all: `/webhooks/ses` was the only one in the app and SNS never
 * calls it on a Resend deployment. Nothing suppressed a dead address, nothing
 * recorded a spam report, and the first symptom anybody got was the sending
 * domain being throttled.
 *
 * This reads `http.ts` rather than a list, so the next provider added to
 * `EMAIL_PROVIDERS` fails here until it has somewhere for its bounces to land.
 * A provider is not "supported" while a client running it cannot be told that
 * a mailbox is dead.
 */
describe("every provider has somewhere for its bounces to land", () => {
  test("each EMAIL_PROVIDERS value has a webhook route in http.ts", async () => {
    const { EMAIL_PROVIDERS } = await import("@be-yours/core/email")
    const source = readFileSync(
      join(__dirname, "..", "..", "convex", "http.ts"),
      "utf8"
    )

    const missing = EMAIL_PROVIDERS.filter(
      (provider) => !source.includes(`path: "/webhooks/${provider}"`)
    )

    expect(missing).toEqual([])
  })
})
