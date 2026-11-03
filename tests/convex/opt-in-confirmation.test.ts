// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The double opt-in, end to end.
 *
 * Every piece of this existed except the one that mattered. `create` minted a
 * token and stored it with a 48-hour expiry, `GET /email/confirm` was
 * registered, `confirmDoubleOptIn` flipped the row to `active`, and
 * `startWelcome` was wired behind it — but **nothing built the URL and nothing
 * sent it**. A grep for `email/confirm` outside the route registration returned
 * nothing at all. So a storefront signup was written `pending`, `pageForSending`
 * offers only `active`, and every organic subscriber a restaurant collected was
 * a row it could never mail. The storefront told the visitor "Vérifiez votre
 * boîte mail" for a message that was never composed.
 *
 * The last test here is the whole feature in one: sign up, take the link out of
 * the mail that was actually sent, open it, and end up `active` with the welcome
 * sequence started. If it passes, the funnel works.
 */

import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

/**
 * Capture what would have gone to SES.
 *
 * The assertions are about the message we compose — the address it goes to, and
 * above all the link inside it — so the transport is the one part that has to
 * be replaced rather than exercised.
 */
interface CapturedEmail {
  FromEmailAddress: string
  ReplyToAddresses?: string[]
  Destination: { ToAddresses: string[] }
  ConfigurationSetName?: string
  Content: {
    Simple: {
      Subject: { Data: string }
      Body: { Html: { Data: string }; Text: { Data: string } }
      Headers?: Array<{ Name: string; Value: string }>
    }
  }
}

const sesSends: CapturedEmail[] = []

vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: class {
    async send(command: { input: CapturedEmail }) {
      sesSends.push(command.input)
      return {}
    }
  },
  SendEmailCommand: class {
    input: CapturedEmail
    constructor(input: CapturedEmail) {
      this.input = input
    }
  },
}))

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000
const SITE_URL = "https://scrupulous-lemur-123.convex.site"

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

beforeEach(() => {
  sesSends.length = 0
  vi.stubEnv("CONVEX_SITE_URL", SITE_URL)
  vi.stubEnv("AWS_SES_FROM_EMAIL", "no-reply@chez-luigi.fr")
  /*
   * The credentials, stubbed because the send path now RESOLVES a provider
   * before it composes anything and refuses when the deployment has none.
   *
   * That refusal is the point of #212: a client whose SES production-access
   * request was turned down should be told so, not handed an opaque signature
   * error from the SDK four calls later. The inline `SESv2Client` this
   * replaced read the same variables through a `!` and never looked, so a
   * suite with no credentials used to reach the mock regardless.
   *
   * So these are fixtures describing a configured deployment, not inputs the
   * suite depends on — hence `vi.stubEnv` rather than assigning onto the
   * environment object, which the guard in `__tests__/turbo-test-env.test.ts`
   * would read as a dependency and demand be declared in turbo.json. The SDK
   * itself is mocked above; nothing here signs anything.
   */
  vi.stubEnv("AWS_REGION", "eu-west-3")
  vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIA-test")
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret-test")
})

/**
 * Cancel what the test left queued, so a job does not fire against a closed
 * transaction and arrive as an unhandled rejection — every assertion green and
 * the run still exiting 1, blaming whichever file happened to be running.
 *
 * `pending` only, unlike the sibling suites: confirming an opt-in schedules
 * `startWelcome` and convex-test starts it immediately, so a blanket cancel
 * races it and trips the harness's own invariant ("Unexpected scheduled
 * function state after it finished running: canceled"). A job already running
 * has a transaction of its own and finishes on its own.
 */
afterEach(async () => {
  for (const t of harnesses) {
    await t.run(async (ctx) => {
      const queued = await ctx.db.system.query("_scheduled_functions").collect()
      for (const job of queued) {
        if (job.state.kind === "pending") {
          await ctx.scheduler.cancel(job._id)
        }
      }
    })
  }
  harnesses.length = 0
  vi.unstubAllEnvs()
})

async function seedStore(t: ReturnType<typeof convexTest>, slug = "luigi") {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Luigi",
      slug: `${slug}-${Math.random()}`,
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

/** Names of the jobs the mutation left on the scheduler. */
function scheduledNames(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect()
    return jobs.map((job) => job.name)
  })
}

/**
 * Drop what `subscribe` queued.
 *
 * `emailSubscribers.subscribe` schedules `sendConfirmation`, so a test that
 * ALSO invokes the action by hand gets two runs of it — and which of them
 * reaches the transport before the assertion is a race. It used to be won
 * consistently by the explicit call, so `toHaveLength(1)` passed; #212 shortened
 * the path to the provider by one hop and the scheduled run started arriving
 * first, which is a fact about the test rather than about the product. Nothing
 * outside the tests calls `sendConfirmation` directly — the scheduler is its
 * only caller.
 */
async function dropScheduled(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect()
    for (const job of jobs) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id)
    }
  })
}

function onlySubscriber(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => (await ctx.db.query("emailSubscribers").collect())[0])
}

describe("signing up from the storefront", () => {
  test("schedules the confirmation email", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)

    await t.mutation(api.emailSubscribers.subscribe, {
      storeId,
      email: "yanis@resto.example",
    })

    // Before this, the row was created and nothing else happened — the token
    // was minted into a table and abandoned.
    expect(await scheduledNames(t)).toContain(
      "emailAutomationActions:sendConfirmation"
    )
  })

  test("the email carries an absolute confirmation link holding the token", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)

    await t.mutation(api.emailSubscribers.subscribe, {
      storeId,
      email: "yanis@resto.example",
    })
    const subscriber = await onlySubscriber(t)
    await dropScheduled(t)

    await t.action(internal.emailAutomationActions.sendConfirmation, {
      subscriberId: subscriber!._id,
    })

    expect(sesSends).toHaveLength(1)
    const sent = sesSends[0]
    expect(sent.Destination.ToAddresses).toEqual(["yanis@resto.example"])

    const html = sent.Content.Simple.Body.Html.Data
    const text = sent.Content.Simple.Body.Text.Data
    const expected = `${SITE_URL}/email/confirm?token=${subscriber!.doubleOptInToken}`
    expect(html).toContain(expected)
    expect(text).toContain(expected)

    // The correlation headers the SES webhook reads. A confirmation that hard
    // bounces is the clearest evidence an address is dead, and `markBounced`
    // now suppresses a permanent bounce on the first one.
    const headers = sent.Content.Simple.Headers ?? []
    expect(headers.find((h) => h.Name === "X-Subscriber-Id")?.Value).toBe(
      subscriber!._id
    )
    expect(headers.find((h) => h.Name === "X-Store-Id")?.Value).toBe(storeId)
  })

  test("it refuses to send a relative link when CONVEX_SITE_URL is unset", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await t.mutation(api.emailSubscribers.subscribe, {
      storeId,
      email: "yanis@resto.example",
    })
    const subscriber = await onlySubscriber(t)

    vi.stubEnv("CONVEX_SITE_URL", "")

    // The three older senders fall back to `""` here and post
    // `/email/unsubscribe?id=…` into a mail client, where it is not a link at
    // all. Doing that with a confirmation would burn the token on a message
    // that cannot work, and the 48h expiry would run out before anyone noticed.
    await expect(
      t.action(internal.emailAutomationActions.sendConfirmation, {
        subscriberId: subscriber!._id,
      })
    ).rejects.toThrow(/CONVEX_SITE_URL/)
    expect(sesSends).toHaveLength(0)
  })

  test("it does not send twice for a subscriber who already confirmed", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await t.mutation(api.emailSubscribers.subscribe, {
      storeId,
      email: "yanis@resto.example",
    })
    const subscriber = await onlySubscriber(t)

    await t.mutation(internal.emailSubscribers.confirmDoubleOptIn, {
      token: subscriber!.doubleOptInToken!,
    })

    // The row is `active` and its token is cleared. A second delivery attempt
    // is a no-op, not an error: the scheduler may retry, and a duplicate
    // "please confirm" to someone who already did is worse than silence.
    await t.action(internal.emailAutomationActions.sendConfirmation, {
      subscriberId: subscriber!._id,
    })
    expect(sesSends).toHaveLength(0)
  })
})

describe("who the confirmation comes from", () => {
  test("the restaurant, once the owner has configured email marketing", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)

    await t.run((ctx) =>
      ctx.db.insert("emailConfig", {
        storeId,
        senderName: "Chez Luigi",
        replyToEmail: "bonjour@chez-luigi.fr",
        fromEmail: "newsletter@chez-luigi.fr",
        branding: { primaryColor: "#0A412D", secondaryColor: "#f97316" },
        unsubscribeText: "Se désabonner",
        maxEmailsPerWeek: 3,
        automationSettings: {
          welcomeEnabled: true,
          postOrderEnabled: true,
          birthdayEnabled: false,
          inactiveEnabled: false,
          abandonedCartEnabled: false,
        },
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    await t.mutation(api.emailSubscribers.subscribe, {
      storeId,
      email: "yanis@resto.example",
    })
    const subscriber = await onlySubscriber(t)
    await t.action(internal.emailAutomationActions.sendConfirmation, {
      subscriberId: subscriber!._id,
    })

    // The visitor asked the restaurant for its news, so the restaurant is who
    // should appear in their inbox — not the deployment's generic sender.
    expect(sesSends[0].FromEmailAddress).toBe(
      "Chez Luigi <newsletter@chez-luigi.fr>"
    )
    expect(sesSends[0].ReplyToAddresses).toEqual(["bonjour@chez-luigi.fr"])
  })

  test("the deployment itself, before the owner has configured anything", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)

    await t.mutation(api.emailSubscribers.subscribe, {
      storeId,
      email: "yanis@resto.example",
    })
    const subscriber = await onlySubscriber(t)
    await t.action(internal.emailAutomationActions.sendConfirmation, {
      subscriberId: subscriber!._id,
    })

    // A visitor who signs up on opening day, before the owner has ever opened
    // the email screen, still has to be confirmable — otherwise the funnel is
    // dead for exactly the period when it matters most.
    expect(sesSends[0].FromEmailAddress).toBe("no-reply@chez-luigi.fr")
  })
})

describe("the store name in the message", () => {
  test("is escaped before it reaches the markup", async () => {
    const t = newHarness()
    const storeId = await t.run((ctx) =>
      ctx.db.insert("stores", {
        name: '<script>alert(1)</script>',
        slug: `xss-${Math.random()}`,
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

    await t.mutation(api.emailSubscribers.subscribe, {
      storeId,
      email: "yanis@resto.example",
    })
    const subscriber = await onlySubscriber(t)
    await t.action(internal.emailAutomationActions.sendConfirmation, {
      subscriberId: subscriber!._id,
    })

    // The name is whatever the owner typed, and it goes into the markup of a
    // message we send on their behalf.
    const html = sesSends[0].Content.Simple.Body.Html.Data
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("&lt;script&gt;")
  })
})

describe("an address the owner typed in themselves", () => {
  test("is active immediately and is sent no confirmation", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)

    const id = await t.run((ctx) =>
      ctx.db.insert("emailSubscribers", {
        storeId,
        email: "paper@resto.example",
        status: "active" as const,
        source: "manual" as const,
        tags: [],
        consentAt: NOW,
        consentSource: "manual subscription",
        doubleOptInAt: NOW,
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

    // `manual` is the one source that skips the confirmation by design: the
    // owner is asserting the consent directly. Mailing them a link about a step
    // that did not happen would be a message about nothing.
    await t.action(internal.emailAutomationActions.sendConfirmation, {
      subscriberId: id,
    })
    expect(sesSends).toHaveLength(0)
  })
})

describe("importing a CSV", () => {
  test("asks every imported row to confirm", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)

    await t.run(async (ctx) => {
      const defs = await import(
        "@be-yours/convex-functions/emailSubscribers"
      )
      return defs.importBatch.handler(ctx, {
        storeId,
        subscribers: [
          { email: "a@resto.example" },
          { email: "b@resto.example" },
        ],
      })
    })

    const rows = await t.run((ctx) =>
      ctx.db.query("emailSubscribers").collect()
    )
    for (const row of rows) {
      await t.action(internal.emailAutomationActions.sendConfirmation, {
        subscriberId: row._id,
      })
    }

    // A CSV is a list someone else compiled — the exact claim a double opt-in
    // exists to test. Without a confirmation every imported row stays `pending`
    // and the whole import is unmailable.
    expect(sesSends).toHaveLength(2)
    expect(
      sesSends.map((s) => s.Destination.ToAddresses[0]).sort()
    ).toEqual(["a@resto.example", "b@resto.example"])
  })
})

describe("a signup whose confirmation never arrived", () => {
  test("signing up again re-mints the token and sends another", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)

    await t.mutation(api.emailSubscribers.subscribe, {
      storeId,
      email: "yanis@resto.example",
    })
    const first = await onlySubscriber(t)

    // The whole reason this matters: a fresh client AWS account is in the SES
    // sandbox, so on day one every confirmation throws MessageRejected. Convex
    // does not retry a scheduled function that throws, and there is no resend
    // anywhere in the product — so without recovery that visitor was stranded
    // for good, and `create` refusing a second attempt made it permanent.
    await t.mutation(api.emailSubscribers.subscribe, {
      storeId,
      email: "yanis@resto.example",
    })

    const rows = await t.run((ctx) => ctx.db.query("emailSubscribers").collect())
    expect(rows).toHaveLength(1) // recovered, not duplicated
    const second = rows[0]
    expect(second.status).toBe("pending")
    expect(second.doubleOptInToken).not.toBe(first!.doubleOptInToken)
    expect(second.doubleOptInExpiresAt).toBeGreaterThanOrEqual(
      first!.doubleOptInExpiresAt!
    )

    await t.action(internal.emailAutomationActions.sendConfirmation, {
      subscriberId: second._id,
    })
    const html = sesSends[0].Content.Simple.Body.Html.Data
    expect(html).toContain(`token=${second.doubleOptInToken}`)
  })

  test("an expired link can be replaced by signing up again", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await t.mutation(api.emailSubscribers.subscribe, {
      storeId,
      email: "yanis@resto.example",
    })
    const stale = await onlySubscriber(t)
    await t.run((ctx) =>
      ctx.db.patch(stale!._id, { doubleOptInExpiresAt: NOW - 1 })
    )

    // The confirmation page says "Veuillez vous réinscrire". That instruction
    // used to throw.
    await t.mutation(api.emailSubscribers.subscribe, {
      storeId,
      email: "yanis@resto.example",
    })

    const revived = await onlySubscriber(t)
    expect(revived!.doubleOptInExpiresAt).toBeGreaterThan(Date.now())
    await t.action(internal.emailAutomationActions.sendConfirmation, {
      subscriberId: revived!._id,
    })
    expect(sesSends).toHaveLength(1)
  })

  test("a confirmed subscriber is not quietly reset by the form", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await t.mutation(api.emailSubscribers.subscribe, {
      storeId,
      email: "yanis@resto.example",
    })
    const row = await onlySubscriber(t)
    await t.mutation(internal.emailSubscribers.confirmDoubleOptIn, {
      token: row!.doubleOptInToken!,
    })

    // Recovery is for `pending` only. Anyone who can type an address into a
    // form must not be able to reopen a decision already taken — confirmed,
    // unsubscribed, bounced or complained.
    await expect(
      t.mutation(api.emailSubscribers.subscribe, {
        storeId,
        email: "yanis@resto.example",
      })
    ).rejects.toThrow(/déjà inscrit/)

    expect((await onlySubscriber(t))!.status).toBe("active")
  })

  test("an address that hard-bounced is told so, not that it is confirmed", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await t.mutation(api.emailSubscribers.subscribe, {
      storeId,
      email: "yanis@resto.example",
    })
    const row = await onlySubscriber(t)
    // What one Permanent bounce on the confirmation itself now does.
    await t.run((ctx) => ctx.db.patch(row!._id, { status: "bounced" as const }))

    const response = await t.fetch(
      `/email/confirm?token=${row!.doubleOptInToken}`
    )
    const body = await response.text()

    // It used to render "Votre inscription est déjà confirmée." — untrue, and
    // it sent them away believing they were on a list they never joined.
    expect(body).not.toContain("déjà confirmée")
    expect(body).toContain("Vérifiez-la")
  })
})

describe("the round trip", () => {
  test("sign up, open the link that was mailed, and the welcome starts", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)

    // 1. A visitor signs up on the storefront.
    await t.mutation(api.emailSubscribers.subscribe, {
      storeId,
      email: "yanis@resto.example",
    })
    const subscriber = await onlySubscriber(t)
    expect(subscriber!.status).toBe("pending")

    // 2. The scheduled action composes and sends the confirmation.
    await t.action(internal.emailAutomationActions.sendConfirmation, {
      subscriberId: subscriber!._id,
    })

    // 3. Take the link out of the message itself rather than rebuilding it —
    //    the defect was precisely that no message contained one.
    const html = sesSends[0].Content.Simple.Body.Html.Data
    const link = html.match(/href="([^"]*\/email\/confirm[^"]*)"/)?.[1]
    expect(link).toBeTruthy()

    // 4. The visitor clicks it, through the real HTTP router.
    const clicked = new URL(link!)
    const response = await t.fetch(clicked.pathname + clicked.search)
    expect(response.status).toBe(200)

    // 5. They are mailable, and the welcome sequence is on its way.
    const confirmed = await t.run((ctx) =>
      ctx.db.get(subscriber!._id as Id<"emailSubscribers">)
    )
    expect(confirmed?.status).toBe("active")
    expect(confirmed?.doubleOptInToken).toBeUndefined()
    expect(await scheduledNames(t)).toContain(
      "emailAutomationActions:startWelcome"
    )
  })
})
