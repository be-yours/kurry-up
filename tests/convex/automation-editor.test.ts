// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Building an automation, from the screen the product did not have (#270).
 *
 * WHAT WAS MISSING. `emailAutomations` shipped `create`, `update`, `remove`,
 * `activate` and `pause`, all permission-guarded, and **nothing in the product
 * called any of them**. The only automation query a screen read was
 * `listActive`, filling a dashboard card that said « Aucune automation active »
 * to every owner for ever, because there was no path to a first one. An owner's
 * only way to build a sequence was a Convex API call.
 *
 * Two guards this closes, beyond the screen itself:
 *
 * 1. `birthday` and `abandoned_cart` have no data behind them, and nothing
 *    anywhere refused them. An owner could create one, activate it, watch it
 *    report « active », and never receive a single email. `TRIGGER_READINESS`
 *    knew; no caller asked.
 *
 * 2. `inactiveAfterDays` was on the table and on NEITHER mutation, so no
 *    caller — UI or API — could set it, and every win-back automation in
 *    existence was stuck on the 90-day default.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
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

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: "client_admin" | "manager" | "kitchen",
  storeIds: Id<"stores">[]
) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: subject,
      role,
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

async function seedTemplate(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  name = "Bienvenue"
) {
  return t.run((ctx) =>
    ctx.db.insert("emailTemplates", {
      storeId,
      name,
      subject: "Bienvenue chez Luigi",
      blocks: [],
      category: "automation" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

const step = (templateId: Id<"emailTemplates">, delayMinutes = 0, id = "step-1") => ({
  id,
  delayMinutes,
  templateId,
})

// ============================================================================
// The editor's own path
// ============================================================================

describe("creating an automation", () => {
  test("starts it as a draft, not active", async () => {
    // Activating on creation would send the first email before the owner had
    // read back what they built.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const templateId = await seedTemplate(t, storeId)

    const id = await asOwner.mutation(api.emailAutomations.create, {
      storeId,
      name: "Bienvenue en 3 emails",
      trigger: "welcome" as const,
      steps: [step(templateId)],
    })

    const automation = await t.run((ctx) => ctx.db.get(id as Id<"emailAutomations">))
    expect(automation?.status).toBe("draft")
    expect(automation?.stats?.sent).toBe(0)
  })

  test("is listed back to the screen, drafts included", async () => {
    // `listActive` cannot serve the editor: the screen with the activate button
    // has to see what it switched off.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const templateId = await seedTemplate(t, storeId)

    await asOwner.mutation(api.emailAutomations.create, {
      storeId,
      name: "Bienvenue",
      trigger: "welcome" as const,
      steps: [step(templateId)],
    })

    const listed = await asOwner.query(api.emailAutomations.list, { storeId })
    expect(listed).toHaveLength(1)
    expect(await asOwner.query(api.emailAutomations.listActive, { storeId })).toHaveLength(0)
  })

  test("accepts the win-back delay, which no caller could set before", async () => {
    /*
     * THE API GAP THE ISSUE NAMED. `inactiveAfterDays` is on the table and read
     * by the nightly sweep, and it was on neither `create` nor `update` — so
     * every win-back automation in existence was stuck on the 90-day default,
     * with no way for anybody to change it.
     */
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const templateId = await seedTemplate(t, storeId)

    const id = await asOwner.mutation(api.emailAutomations.create, {
      storeId,
      name: "On vous a manqué",
      trigger: "inactive" as const,
      steps: [step(templateId)],
      inactiveAfterDays: 45,
    })

    const automation = await t.run((ctx) => ctx.db.get(id as Id<"emailAutomations">))
    expect(automation?.inactiveAfterDays).toBe(45)
  })

  test("lets the owner change it afterwards", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const templateId = await seedTemplate(t, storeId)

    const id = await asOwner.mutation(api.emailAutomations.create, {
      storeId,
      name: "On vous a manqué",
      trigger: "inactive" as const,
      steps: [step(templateId)],
      inactiveAfterDays: 45,
    })
    await asOwner.mutation(api.emailAutomations.update, {
      id: id as Id<"emailAutomations">,
      inactiveAfterDays: 30,
    })

    const automation = await t.run((ctx) => ctx.db.get(id as Id<"emailAutomations">))
    expect(automation?.inactiveAfterDays).toBe(30)
  })

  test("activates and pauses", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const templateId = await seedTemplate(t, storeId)

    const id = (await asOwner.mutation(api.emailAutomations.create, {
      storeId,
      name: "Bienvenue",
      trigger: "welcome" as const,
      steps: [step(templateId)],
    })) as Id<"emailAutomations">

    await asOwner.mutation(api.emailAutomations.activate, { id })
    expect(await asOwner.query(api.emailAutomations.listActive, { storeId })).toHaveLength(1)

    await asOwner.mutation(api.emailAutomations.pause, { id })
    expect(await asOwner.query(api.emailAutomations.listActive, { storeId })).toHaveLength(0)
  })

  test("deletes one that has never mailed anybody", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const templateId = await seedTemplate(t, storeId)

    const id = (await asOwner.mutation(api.emailAutomations.create, {
      storeId,
      name: "Bienvenue",
      trigger: "welcome" as const,
      steps: [step(templateId)],
    })) as Id<"emailAutomations">

    await asOwner.mutation(api.emailAutomations.remove, { id })
    expect(await asOwner.query(api.emailAutomations.list, { storeId })).toHaveLength(0)
  })
})

// ============================================================================
// The trigger that cannot fire
// ============================================================================

describe("a trigger with no data behind it", () => {
  test("cannot be created", async () => {
    // An owner could build a birthday sequence, activate it, watch it report
    // « active », and never receive one email. No record in this system carries a
    // date of birth.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const templateId = await seedTemplate(t, storeId)

    await expect(
      asOwner.mutation(api.emailAutomations.create, {
        storeId,
        name: "Joyeux anniversaire",
        trigger: "birthday" as const,
        steps: [step(templateId)],
      })
    ).rejects.toThrow(/date de naissance|n'est pas encore disponible/)
  })

  test("cannot be created for an abandoned cart either", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const templateId = await seedTemplate(t, storeId)

    await expect(
      asOwner.mutation(api.emailAutomations.create, {
        storeId,
        name: "Vous avez oublié quelque chose",
        trigger: "abandoned_cart" as const,
        steps: [step(templateId)],
      })
    ).rejects.toThrow(/n'est pas encore disponible/)
  })

  test("cannot be switched to by an update", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const templateId = await seedTemplate(t, storeId)

    const id = (await asOwner.mutation(api.emailAutomations.create, {
      storeId,
      name: "Bienvenue",
      trigger: "welcome" as const,
      steps: [step(templateId)],
    })) as Id<"emailAutomations">

    await expect(
      asOwner.mutation(api.emailAutomations.update, { id, trigger: "birthday" as const })
    ).rejects.toThrow(/n'est pas encore disponible/)
  })

  test("cannot be activated, even on a draft written before the guard", async () => {
    /*
     * The last place it can be refused. Every automation on every deployment
     * today was written by an API call against the unguarded mutation, so a
     * draft holding `birthday` already exists in the wild — and activation is
     * the moment the promise is made to the owner.
     */
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const templateId = await seedTemplate(t, storeId)

    const id = await t.run((ctx) =>
      ctx.db.insert("emailAutomations", {
        storeId,
        name: "Anniversaire — écrite avant le garde",
        trigger: "birthday" as const,
        status: "draft" as const,
        steps: [{ id: "step-1", delayMinutes: 0, templateId }],
        stats: {
          sent: 0, delivered: 0, opened: 0, clicked: 0,
          bounced: 0, unsubscribed: 0, converted: 0, revenue: 0,
        },
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    await expect(
      asOwner.mutation(api.emailAutomations.activate, { id })
    ).rejects.toThrow(/n'est pas encore disponible/)
  })

  test("the three that can fire are accepted", async () => {
    // `welcome`, `post_order` and `inactive`. If a trigger is implemented in
    // `TRIGGER_READINESS`, it becomes creatable on the same commit.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const templateId = await seedTemplate(t, storeId)

    for (const trigger of ["welcome", "post_order", "inactive"] as const) {
      await expect(
        asOwner.mutation(api.emailAutomations.create, {
          storeId,
          name: `Séquence ${trigger}`,
          trigger,
          steps: [step(templateId)],
        })
      ).resolves.toBeDefined()
    }
  })
})

// ============================================================================
// A sequence the dispatcher can run
// ============================================================================

describe("the steps", () => {
  test("an automation with no steps is refused", async () => {
    // It would activate, report « active », and send nothing.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])

    await expect(
      asOwner.mutation(api.emailAutomations.create, {
        storeId,
        name: "Vide",
        trigger: "welcome" as const,
        steps: [],
      })
    ).rejects.toThrow(/au moins une étape/)
  })

  test("a negative delay is refused", async () => {
    // Delays count from the trigger, so a negative one would schedule a send
    // before the event that caused it.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const templateId = await seedTemplate(t, storeId)

    await expect(
      asOwner.mutation(api.emailAutomations.create, {
        storeId,
        name: "Avant l'heure",
        trigger: "welcome" as const,
        steps: [step(templateId, -60)],
      })
    ).rejects.toThrow(/minutes entières/)
  })

  test("a fractional delay is refused", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const templateId = await seedTemplate(t, storeId)

    await expect(
      asOwner.mutation(api.emailAutomations.create, {
        storeId,
        name: "Entre deux minutes",
        trigger: "welcome" as const,
        steps: [step(templateId, 90.5)],
      })
    ).rejects.toThrow(/minutes entières/)
  })

  test("an absurd number of steps is refused", async () => {
    // Not a business rule: a forged payload must not schedule ten thousand
    // sends off one trigger.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const templateId = await seedTemplate(t, storeId)

    await expect(
      asOwner.mutation(api.emailAutomations.create, {
        storeId,
        name: "Trop",
        trigger: "welcome" as const,
        steps: Array.from({ length: 50 }, (_, i) => step(templateId, i * 60, `step-${i}`)),
      })
    ).rejects.toThrow(/au maximum/)
  })

  test("a draft with no steps cannot be activated", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])

    const id = await t.run((ctx) =>
      ctx.db.insert("emailAutomations", {
        storeId,
        name: "Vide — écrite avant le garde",
        trigger: "welcome" as const,
        status: "draft" as const,
        steps: [],
        stats: {
          sent: 0, delivered: 0, opened: 0, clicked: 0,
          bounced: 0, unsubscribed: 0, converted: 0, revenue: 0,
        },
        createdAt: NOW,
        updatedAt: NOW,
      })
    )

    await expect(
      asOwner.mutation(api.emailAutomations.activate, { id })
    ).rejects.toThrow(/au moins une étape/)
  })

  test("a delay of zero is fine — that is what a welcome email is", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const templateId = await seedTemplate(t, storeId)

    await expect(
      asOwner.mutation(api.emailAutomations.create, {
        storeId,
        name: "Bienvenue",
        trigger: "welcome" as const,
        steps: [step(templateId, 0)],
      })
    ).resolves.toBeDefined()
  })
})

// ============================================================================
// Who may build one
// ============================================================================

describe("the gate", () => {
  test("a manager may, because they run the marketing", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asManager = await seedUser(t, "boss", "manager", [storeId])
    const templateId = await seedTemplate(t, storeId)

    await expect(
      asManager.mutation(api.emailAutomations.create, {
        storeId,
        name: "Bienvenue",
        trigger: "welcome" as const,
        steps: [step(templateId)],
      })
    ).resolves.toBeDefined()
  })

  test("a kitchen account may not read them", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asKitchen = await seedUser(t, "chef", "kitchen", [storeId])

    await expect(
      asKitchen.query(api.emailAutomations.list, { storeId })
    ).rejects.toThrow()
  })

  test("an anonymous caller may not create one", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const templateId = await seedTemplate(t, storeId)

    await expect(
      t.mutation(api.emailAutomations.create, {
        storeId,
        name: "Bienvenue",
        trigger: "welcome" as const,
        steps: [step(templateId)],
      })
    ).rejects.toThrow(/Not authenticated/)
  })
})

// ============================================================================
// Deleting one that has mailed somebody
// ============================================================================

describe("deleting an automation that has run", () => {
  test("is refused, and the sentence offers pause instead", async () => {
    /*
     * `emailAutomationRuns` is the record of which step reached which subscriber
     * AND the dedupe that stops a rescheduled step mailing the same person
     * twice. Those rows outlive the trigger by days, so deleting the automation
     * strands every step still in flight: a subscriber gets step 1 and never
     * step 2, with nothing anywhere saying why.
     */
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedUser(t, "owner", "client_admin", [storeId])
    const templateId = await seedTemplate(t, storeId)

    const id = (await asOwner.mutation(api.emailAutomations.create, {
      storeId,
      name: "Bienvenue",
      trigger: "welcome" as const,
      steps: [step(templateId)],
    })) as Id<"emailAutomations">

    const subscriberId = await t.run((ctx) =>
      ctx.db.insert("emailSubscribers", {
        storeId,
        email: "camille@example.fr",
        status: "active" as const,
        source: "storefront_form" as const,
        tags: [],
        // Required by the schema: a subscriber exists because they consented,
        // and the row records when and to what.
        consentAt: NOW,
        consentSource: "formulaire du site",
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
    await t.run((ctx) =>
      ctx.db.insert("emailAutomationRuns", {
        storeId,
        automationId: id,
        subscriberId,
        stepId: "step-1",
        sentAt: NOW,
      })
    )

    await expect(
      asOwner.mutation(api.emailAutomations.remove, { id })
    ).rejects.toThrow(/pause/)
  })
})
