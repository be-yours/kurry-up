// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Which SES configuration set a campaign sends under, and what a batch does
 * when SES refuses.
 *
 * The name was hard-coded to `"beindigital-email-tracking"` — the agency's own
 * set, which exists in no client's AWS account — while
 * `AWS_SES_CONFIGURATION_SET` was declared in the env schema, written into
 * `.env` by `setup-aws.sh`, documented in three places, and read nowhere. So on
 * a client deployment SES answered `ConfigurationSetDoesNotExist` to every
 * call, the per-subscriber `catch` swallowed each one to `console.error`,
 * `markSent` ran regardless, and the owner was told "Campagne envoyée (0/342
 * emails)". They concluded their recipients were at fault.
 *
 * Two properties, then: the set comes from the deployment (and the field is
 * omitted when there is none), and a run of refusals stops the batch out loud
 * instead of reporting a delivery nobody received.
 */

import { convexTest } from "convex-test"
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest"

/** Every `SendEmailCommand` input the action handed to SES, in order. */
const commands: Array<Record<string, unknown>> = []

/** Decides what SES does with the nth call. Replaced per test. */
let sesBehaviour: (attempt: number) => void = () => {}

function configurationSetDoesNotExist(): Error {
  const error = new Error(
    "Configuration set <beindigital-email-tracking> does not exist."
  )
  error.name = "ConfigurationSetDoesNotExist"
  return error
}

vi.mock("@aws-sdk/client-sesv2", () => {
  class SendEmailCommand {
    input: Record<string, unknown>
    constructor(input: Record<string, unknown>) {
      this.input = input
    }
  }
  class SESv2Client {
    async send(command: SendEmailCommand): Promise<{ MessageId: string }> {
      commands.push(command.input)
      sesBehaviour(commands.length)
      return { MessageId: `m-${commands.length}` }
    }
  }
  return { SESv2Client, SendEmailCommand }
})

import { internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000
const ORIGINAL_CONFIGURATION_SET = process.env.AWS_SES_CONFIGURATION_SET

interface Seeded {
  storeId: Id<"stores">
  campaignId: Id<"emailCampaigns">
}

async function seed(
  t: ReturnType<typeof convexTest>,
  subscribers: number
): Promise<Seeded> {
  return t.run(async (ctx) => {
    const storeId = await ctx.db.insert("stores", {
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

    await ctx.db.insert("emailConfig", {
      storeId,
      senderName: "Chez Luigi",
      replyToEmail: "contact@luigi.example",
      fromEmail: "no-reply@luigi.example",
      branding: { primaryColor: "#000000", secondaryColor: "#ffffff" },
      unsubscribeText: "Se désabonner",
      // High enough that the weekly anti-spam cap never explains a missing send
      // in these tests: what is under test is SES, not `maxEmailsPerWeek`.
      maxEmailsPerWeek: 100,
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

    for (let i = 0; i < subscribers; i++) {
      await ctx.db.insert("emailSubscribers", {
        storeId,
        email: `sub${i}@resto.example`,
        status: "active" as const,
        source: "storefront_form" as const,
        tags: [],
        consentAt: NOW,
        consentSource: "test",
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
    }

    const templateId = await ctx.db.insert("emailTemplates", {
      storeId,
      name: "Brunch",
      subject: "Brunch",
      blocks: [],
      category: "marketing" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })

    const campaignId = await ctx.db.insert("emailCampaigns", {
      storeId,
      name: "Brunch de samedi",
      subject: "Brunch",
      templateId,
      status: "sending" as const,
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
      createdAt: NOW,
      updatedAt: NOW,
    })

    return { storeId, campaignId }
  })
}

const campaignRow = (t: ReturnType<typeof convexTest>, id: Id<"emailCampaigns">) =>
  t.run((ctx) => ctx.db.get(id))

beforeEach(() => {
  commands.length = 0
  sesBehaviour = () => {}
  delete process.env.AWS_SES_CONFIGURATION_SET
  // The send path resolves a provider before it builds a command, and refuses
  // when the deployment has no credentials — which is the point of #212: a
  // client whose SES request was refused should be TOLD, not handed an opaque
  // signature error four calls later. A campaign test has to look like a
  // configured deployment, so these four are stubbed. The SDK itself is mocked
  // above; the values sign nothing.
  //
  /*
   * `vi.stubEnv` rather than assigning onto the environment object directly.
   * The guard in `__tests__/turbo-test-env.test.ts` treats a literal
   * environment access in a suite as a variable that suite DEPENDS on, and
   * demands it be declared in turbo.json. These four are fixtures this test
   * provides, not inputs it needs — and the guard reads line comments as code,
   * so this note is a block comment, which it strips.
   */
  vi.stubEnv("AWS_REGION", "eu-west-3")
  vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIA-test")
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret-test")
  vi.stubEnv("AWS_SES_FROM_EMAIL", "no-reply@chez-luigi.fr")
})

afterAll(() => {
  if (ORIGINAL_CONFIGURATION_SET === undefined) {
    delete process.env.AWS_SES_CONFIGURATION_SET
  } else {
    process.env.AWS_SES_CONFIGURATION_SET = ORIGINAL_CONFIGURATION_SET
  }
})

describe("the configuration set a campaign sends under", () => {
  test("comes from the deployment, not from a name compiled into the engine", async () => {
    const t = convexTest(schema, modules)
    const { campaignId } = await seed(t, 2)
    process.env.AWS_SES_CONFIGURATION_SET = "luigi-email-tracking"

    await t.action(internal.emailCampaignActions.sendBatch, { campaignId })

    expect(commands).toHaveLength(2)
    for (const input of commands) {
      expect(input.ConfigurationSetName).toBe("luigi-email-tracking")
    }
  })

  test("is left out of the command when the deployment has none", async () => {
    const t = convexTest(schema, modules)
    const { campaignId } = await seed(t, 2)

    await t.action(internal.emailCampaignActions.sendBatch, { campaignId })

    // Absent, not present-and-undefined. SES accepts a send with no
    // configuration set — it just produces no open or click events — but it
    // refuses a set that does not exist, which is what the hard-coded name was
    // on every client account.
    expect(commands).toHaveLength(2)
    for (const input of commands) {
      expect(input).not.toHaveProperty("ConfigurationSetName")
    }
    expect((await campaignRow(t, campaignId))?.status).toBe("sent")
  })

  test("is left out when the variable is present but empty", async () => {
    // `AWS_SES_CONFIGURATION_SET=` is exactly what `.env.example` ships.
    const t = convexTest(schema, modules)
    const { campaignId } = await seed(t, 1)
    process.env.AWS_SES_CONFIGURATION_SET = "  "

    await t.action(internal.emailCampaignActions.sendBatch, { campaignId })

    expect(commands[0]).not.toHaveProperty("ConfigurationSetName")
  })

  test("reaches a test send too", async () => {
    const t = convexTest(schema, modules)
    const { storeId, campaignId } = await seed(t, 1)
    process.env.AWS_SES_CONFIGURATION_SET = "luigi-email-tracking"

    await t.run((ctx) =>
      ctx.db.insert("userProfiles", {
        userId: "owner",
        role: "client_admin",
        storeIds: [storeId],
        permissions: [],
        language: "fr",
        twoFactorEnabled: false,
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    await t
      .withIdentity({ subject: "owner" })
      .action(internal.emailCampaignActions.sendTest, {
        campaignId,
        testEmail: "chef@luigi.example",
      })

    expect(commands).toHaveLength(1)
    expect(commands[0]?.ConfigurationSetName).toBe("luigi-email-tracking")
  })
})

describe("a batch SES refuses", () => {
  test("aborts, and never reports the campaign as sent", async () => {
    const t = convexTest(schema, modules)
    const { campaignId } = await seed(t, 12)
    sesBehaviour = () => {
      throw configurationSetDoesNotExist()
    }

    // The whole defect in one assertion: this used to resolve, and the owner
    // was shown "Campagne envoyée (0/342 emails)".
    await expect(
      t.action(internal.emailCampaignActions.sendBatch, { campaignId })
    ).rejects.toThrow(/consecutive sends/)

    const campaign = await campaignRow(t, campaignId)
    expect(campaign?.status).not.toBe("sent")
    // `paused`, not the `sending` the abort alone would leave: the admin
    // renders `sending` as "En cours", which still claims a send is
    // progressing when it has stopped and will not resume by itself. `paused`
    // is the state "Relancer" resumes from, and the cursor is untouched.
    expect(campaign?.status).toBe("paused")
    expect(campaign?.stats.sent).toBe(0)
    // Stopped inside the page rather than at the end of it: a run of refusals
    // against a paused SES account is what makes the pause permanent.
    expect(commands).toHaveLength(5)
  })

  test("names the configuration set, which is the setting to check", async () => {
    const t = convexTest(schema, modules)
    const { campaignId } = await seed(t, 12)
    process.env.AWS_SES_CONFIGURATION_SET = "luigi-email-tracking"
    sesBehaviour = () => {
      throw configurationSetDoesNotExist()
    }

    await expect(
      t.action(internal.emailCampaignActions.sendBatch, { campaignId })
    ).rejects.toThrow(/luigi-email-tracking/)
  })

  test("keeps the cursor, so the aborted page is the one that resumes", async () => {
    const t = convexTest(schema, modules)
    const { campaignId } = await seed(t, 12)
    await t.mutation(internal.emailCampaigns.saveSendCursor, {
      id: campaignId,
      cursor: null,
    })
    sesBehaviour = () => {
      throw configurationSetDoesNotExist()
    }

    await expect(
      t.action(internal.emailCampaignActions.sendBatch, { campaignId })
    ).rejects.toThrow()

    // Advancing it would skip everyone this page never reached.
    expect((await campaignRow(t, campaignId))?.sendCursor).toBeUndefined()
  })

  test("resumes without mailing whoever did get through", async () => {
    const t = convexTest(schema, modules)
    const { campaignId } = await seed(t, 12)
    // Two land, then the account breaks.
    sesBehaviour = (attempt) => {
      if (attempt > 2) throw configurationSetDoesNotExist()
    }

    await expect(
      t.action(internal.emailCampaignActions.sendBatch, { campaignId })
    ).rejects.toThrow()

    expect((await campaignRow(t, campaignId))?.stats.sent).toBe(2)
    const firstRun = commands.map((c) => c.Destination)
    expect(firstRun).toHaveLength(7) // 2 delivered, then 5 refused

    // The abort paused it, which is what the admin shows and what "Relancer"
    // acts on. Resuming therefore goes through `markSending` first — calling
    // `sendBatch` straight into a paused campaign correctly does nothing.
    expect((await campaignRow(t, campaignId))?.status).toBe("paused")

    // The operator fixes the configuration set and presses Relancer.
    commands.length = 0
    sesBehaviour = () => {}
    await t.mutation(internal.emailCampaigns.markSending, { id: campaignId })
    await t.action(internal.emailCampaignActions.sendBatch, { campaignId })

    const campaign = await campaignRow(t, campaignId)
    expect(campaign?.status).toBe("sent")
    expect(campaign?.stats.sent).toBe(12)
    // Ten, not twelve: duplicate marketing mail is what costs real customers.
    expect(commands).toHaveLength(10)
  })
})

describe("a campaign with scattered bad addresses", () => {
  test("still goes out in full", async () => {
    const t = convexTest(schema, modules)
    const { campaignId } = await seed(t, 12)
    // Every third recipient refused — a bad list, not a broken account. The
    // limit counts a RUN of failures precisely so this campaign finishes.
    sesBehaviour = (attempt) => {
      if (attempt % 3 === 0) {
        const error = new Error("Email address is not verified.")
        error.name = "MessageRejected"
        throw error
      }
    }

    await t.action(internal.emailCampaignActions.sendBatch, { campaignId })

    const campaign = await campaignRow(t, campaignId)
    expect(campaign?.status).toBe("sent")
    expect(commands).toHaveLength(12)
    expect(campaign?.stats.sent).toBe(8)
  })
})
