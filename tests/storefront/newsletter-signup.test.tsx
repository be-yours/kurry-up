// @vitest-environment jsdom
/// <reference types="vite/client" />

/**
 * The footer newsletter, from the form to the row.
 *
 * Two defects met on this form, and both told the visitor the same lie.
 *
 * It first called no mutation at all: it read the address, dropped it, and
 * toasted "vous êtes maintenant inscrit". The footer renders on every page, so
 * every organic signup a restaurant thought it was collecting went nowhere.
 *
 * Once it did write, it wrote anything. `pas-un-email` was inserted and
 * answered with "check your inbox" — a row SES can only bounce, on the ratio
 * AWS suspends an account over. `create` is a PUBLIC mutation, so the guard
 * that matters is the server's; the Zod check in the form is what spares the
 * visitor a round trip and a wasted rate-limit slot.
 *
 * These assertions read the DATABASE. A test that only proves "a mutation was
 * called" would have passed against the first defect on the day it shipped, as
 * soon as anyone mocked the hook.
 */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { convexTest, type TestConvex } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { api } from "../../convex/_generated/api"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = 1_700_000_000_000

/** The store the footer believes it is rendering for. */
const STORE = { id: "" }

/** The concrete schema, so `t.run` callbacks see the real tables. */
type Harness = TestConvex<typeof schema>

let harness: Harness | null = null

/** Every mutation the form started, so a test can await the write it caused. */
const inFlight: Array<Promise<unknown>> = []

const toasts: Array<{ kind: "success" | "error"; message: string }> = []

vi.mock("@/lib/hooks", () => ({
  useStoreId: () => ({ storeId: STORE.id, store: null, isLoading: false }),
}))

/**
 * The footer also reads « Layout du storefront » for the social links. No
 * network is configured here, so the icons stay off — and these assertions are
 * about the newsletter row, not the CMS.
 */
vi.mock("@/lib/cms/useCmsPage", () => ({
  useCmsPage: () => ({
    isLoading: false,
    pageMeta: null,
    block: () => ({
      values: {},
      field: () => ({
        text: null,
        mediaUrl: null,
        media: null,
        embedUrl: null,
        altText: null,
        raw: undefined,
      }),
    }),
  }),
}))

vi.mock("convex/react", () => ({
  useMutation: () => (args: Record<string, unknown>) => {
    const pending = harness!.mutation(api.emailSubscribers.subscribe, args as never)
    inFlight.push(pending)
    return pending
  },
}))

vi.mock("sonner", () => ({
  toast: {
    success: (message: string) => toasts.push({ kind: "success", message }),
    error: (message: string) => toasts.push({ kind: "error", message }),
  },
}))

/**
 * Every signup schedules a confirmation email. The transport is the one part
 * that has to be replaced rather than exercised — these assertions are about
 * the row, and a real SES client here would be a network call per test.
 */
vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: class {
    async send() {
      return {}
    }
  },
  SendEmailCommand: class {
    constructor(readonly input: unknown) {}
  },
}))

const mounted: Array<{ root: Root; container: HTMLElement }> = []

beforeEach(() => {
  inFlight.length = 0
  toasts.length = 0
})

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  // Let the confirmation email each signup queued run to completion. A job
  // still in flight when the harness goes writes against a closed transaction
  // and fails the run from outside any assertion — every test green, exit 1.
  if (harness) {
    await harness.finishAllScheduledFunctions(() => {})
  }
  harness = null
})

async function seedStore(t: Harness) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Luigi",
      slug: `luigi-${Math.random()}`,
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

/** Mount the footer against a fresh database. */
async function mountFooter() {
  const t = convexTest(schema, modules)
  harness = t
  STORE.id = await seedStore(t)

  const { StorefrontFooter } = await import("@/components/storefront/storefront-footer")
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(<StorefrontFooter />)
  })
  return { t, container }
}

/** Type an address and submit, the way a visitor does. */
async function submit(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="email"]')!
  const form = container.querySelector("form")!

  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!
    setValue.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  })
  await act(async () => {
    await Promise.allSettled(inFlight)
  })
}

function subscribers(t: Harness) {
  return t.run((ctx) => ctx.db.query("emailSubscribers").collect())
}

describe("footer newsletter", () => {
  test("writes the address to the store's list", async () => {
    const { t, container } = await mountFooter()

    await submit(container, "yanis@resto.example")

    const rows = await subscribers(t)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.email).toBe("yanis@resto.example")
    expect(rows[0]!.storeId).toBe(STORE.id)
    // `pending`, not `active`: the confirmation link is what promotes them, and
    // only `active` subscribers are ever mailed a campaign.
    expect(rows[0]!.status).toBe("pending")
    expect(rows[0]!.source).toBe("storefront_form")
  })

  test("tells the visitor to confirm rather than that they are subscribed", async () => {
    const { container } = await mountFooter()

    await submit(container, "yanis@resto.example")

    expect(toasts).toHaveLength(1)
    expect(toasts[0]!.kind).toBe("success")
    expect(toasts[0]!.message).not.toMatch(/inscrit/i)
  })

  test("normalises the address it stores", async () => {
    const { t, container } = await mountFooter()

    await submit(container, "  Yanis@Resto.Example  ")

    const rows = await subscribers(t)
    expect(rows).toHaveLength(1)
    // An untrimmed address stored beside its trimmed twin is two rows for one
    // person, only one of which any lookup will find.
    expect(rows[0]!.email).toBe("yanis@resto.example")
  })

  test("refuses a malformed address instead of listing it", async () => {
    const { t, container } = await mountFooter()

    await submit(container, "pas-un-email")

    expect(await subscribers(t)).toHaveLength(0)
    // No success toast, and the message belongs to the field rather than to a
    // toast that has already faded by the time the visitor looks at the input.
    expect(toasts).toHaveLength(0)
    const error = container.querySelector('[role="alert"]')
    expect(error?.textContent).toBe("Vérifiez votre adresse email.")
    expect(
      container.querySelector('input[type="email"]')!.getAttribute("aria-describedby")
    ).toBe(error!.id)
  })

  test("refuses an empty address", async () => {
    const { t, container } = await mountFooter()

    await submit(container, "   ")

    expect(await subscribers(t)).toHaveLength(0)
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Renseignez votre adresse email."
    )
  })

  test("says an address is already on the list, and does not claim success", async () => {
    const { t, container } = await mountFooter()

    await t.run((ctx) =>
      ctx.db.insert("emailSubscribers", {
        storeId: STORE.id as never,
        email: "yanis@resto.example",
        status: "active" as const,
        source: "storefront_form" as const,
        tags: [],
        consentAt: NOW,
        consentSource: "storefront_form subscription",
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

    await submit(container, "yanis@resto.example")

    expect(await subscribers(t)).toHaveLength(1)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]!.kind).toBe("error")
    expect(toasts[0]!.message).toBe("Cette adresse est déjà inscrite.")
  })

  test("labels the field and does not lean on the placeholder", async () => {
    const { container } = await mountFooter()

    const input = container.querySelector<HTMLInputElement>('input[type="email"]')!
    const label = container.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`)
    expect(label?.textContent).toBe("Votre adresse email")
  })
})
