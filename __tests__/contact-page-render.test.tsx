/**
 * `/contact` is linked from the header of every storefront page, and it used to
 * white-screen on every visit.
 *
 * `store.address` is a required `v.object({street, city, postalCode, country})`
 * (`packages/convex-schema/src/tables/stores.ts`), and the page handed it to
 * React as a child:
 *
 *   {store?.address ?? "123 Rue de la Gastronomie"}
 *
 * React answers that with "Objects are not valid as a React child" and, with no
 * error boundary above it, the visitor got Next's default error screen.
 *
 * The two neighbouring reads failed silently instead, which is worse: `store.city`
 * and `store.openingHours` are fields that have never existed on the document —
 * the real ones are `address.city` and `hours` — so every visitor was shown an
 * invented street, an invented postcode and invented opening times, on the page
 * whose entire job is to be correct about those three things.
 *
 * These assertions are therefore about content, not just about not throwing: a
 * page that renders the wrong address has the same business value as one that
 * does not render.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

type StoreFixture = {
  _id: string
  name: string
  slug: string
  address: {
    street: string
    city: string
    postalCode: string
    country: string
  }
  phone?: string
  email?: string
  hours: { day: number; open: string; close: string; isClosed: boolean }[]
  /**
   * Whether this establishment follows the deployment-wide week.
   *
   * Optional here because it is optional in the schema, and ABSENT is the
   * interesting case: it is what every store nobody has saved since the column
   * landed carries, and it means "follow the global week" everywhere in the
   * product. An explicit `false` is the opt-out an owner writes by turning the
   * « horaires globaux » switch off.
   */
  useGlobalHours?: boolean
  status: string
}

const LE_COMPTOIR: StoreFixture = {
  _id: "store_1",
  name: "Le Comptoir des Martyrs",
  slug: "le-comptoir-des-martyrs",
  address: {
    street: "12 rue des Martyrs",
    city: "Paris",
    postalCode: "75009",
    country: "France",
  },
  phone: "+33 1 42 80 12 34",
  email: "bonjour@lecomptoir.fr",
  hours: [
    { day: 1, open: "11:30", close: "22:00", isClosed: false },
    { day: 2, open: "11:30", close: "22:00", isClosed: false },
    { day: 3, open: "11:30", close: "22:00", isClosed: false },
    { day: 4, open: "11:30", close: "22:00", isClosed: false },
    { day: 5, open: "11:30", close: "23:30", isClosed: false },
    { day: 6, open: "18:00", close: "23:30", isClosed: false },
    { day: 0, open: "00:00", close: "00:00", isClosed: true },
  ],
  status: "open",
}

/** What the mocked Convex query answers with. `undefined` is "still loading". */
let store: StoreFixture | null | undefined = LE_COMPTOIR

/**
 * The deployment-wide settings row, which this page now reads too.
 *
 * It has to, and the reason is the defect it closes: the page called
 * `resolveStoreHours(store)` with no second argument, so an establishment
 * following the deployment-wide week PUBLISHED its own stale one — on the page
 * a diner opens to find out when to turn up, while the order path enforced the
 * other. `null` here is a deployment whose settings have never been saved, in
 * which case the store's own week governs and these fixtures read as before.
 */
let globalSettings: { hours?: StoreFixture["hours"] } | null = null

/**
 * Dispatched on the query, not a single answer for all of them.
 *
 * `useQuery: () => store` handed the store fixture to EVERY query in the page,
 * which was fine while there was one and is not fine now: the settings row and
 * the store are different documents and the page resolves the week from both.
 */
vi.mock("convex/react", () => ({
  useQuery: (query: string) =>
    query === "globalSettings:get" ? globalSettings : store,
  useMutation: () => async () => undefined,
}))

vi.mock("@/convex/_generated/api", () => ({
  api: {
    stores: { getById: "stores:getById" },
    globalSettings: { get: "globalSettings:get" },
    contactMessages: { create: "contactMessages:create" },
  },
}))

vi.mock("@/lib/hooks/use-store-id", () => ({
  useStoreId: () => ({ storeId: "store_1", store, isLoading: store === undefined }),
}))

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

async function renderContactPage(): Promise<string> {
  const ContactPage = (
    await import("@/app/(storefront)/contact/_components/ContactContent")
  ).default
  return renderToStaticMarkup(<ContactPage />)
}

/** The markup with tags collapsed, so assertions read like the page does. */
const asText = (html: string): string =>
  html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|")

describe("the contact page", () => {
  beforeEach(() => {
    store = LE_COMPTOIR
  })

  it("renders instead of throwing on the store address object", async () => {
    // The exact shape of the crash, kept as its own assertion so a regression
    // names itself rather than arriving as a failed content check.
    await expect(renderContactPage()).resolves.toBeTypeOf("string")
  })

  it("shows the real address, on the lines a postal address uses", async () => {
    const text = asText(await renderContactPage())

    expect(text).toContain("12 rue des Martyrs")
    expect(text).toContain("75009 Paris")
    expect(text).toContain("France")
  })

  it("shows the real opening hours, grouped as a restaurant writes them", async () => {
    const text = asText(await renderContactPage())

    expect(text).toContain("Lun - Jeu")
    expect(text).toContain("11h30 - 22h00")
    expect(text).toContain("Ven")
    expect(text).toContain("11h30 - 23h30")
    expect(text).toContain("Dim")
    expect(text).toContain("Fermé")
  })

  it("publishes the GLOBAL week when the establishment follows it", async () => {
    /**
     * THE DEFECT THIS CLOSES. The page called `resolveStoreHours(store)` with
     * no second argument, so the deployment-wide week could not reach it: an
     * establishment following the global hours PUBLISHED its own stale ones,
     * on the page a diner opens precisely to find out when to turn up, while
     * the order path enforced the other. Two answers to one question, and the
     * one a person reads was the wrong one.
     *
     * The flag is set EXPLICITLY here. `FOLLOWS_GLOBAL_HOURS_BY_DEFAULT` is
     * `false` (#446), so an unwritten flag means "keep your own week" — this
     * page's bug is about the establishments that genuinely do follow the
     * global one, and those say so.
     */
    store = { ...LE_COMPTOIR, useGlobalHours: true }
    globalSettings = {
      hours: [
        { day: 1, open: "07:00", close: "09:00", isClosed: false },
        { day: 2, open: "07:00", close: "09:00", isClosed: false },
        { day: 3, open: "07:00", close: "09:00", isClosed: false },
        { day: 4, open: "07:00", close: "09:00", isClosed: false },
        { day: 5, open: "07:00", close: "09:00", isClosed: false },
        { day: 6, open: "07:00", close: "09:00", isClosed: false },
        { day: 0, open: "07:00", close: "09:00", isClosed: false },
      ],
    }

    const text = asText(await renderContactPage())

    expect(text).toContain("07h00 - 09h00")
    // And not the establishment's own, which is what it used to print.
    expect(text).not.toContain("11h30 - 22h00")
  })

  it("keeps the establishment's own week when it has opted out", async () => {
    // The other direction, so the fix above cannot be read as "global always
    // wins". An explicit `false` is what an owner writes by turning the
    // « horaires globaux » switch off.
    globalSettings = {
      hours: [{ day: 1, open: "07:00", close: "09:00", isClosed: false }],
    }
    store = { ...LE_COMPTOIR, useGlobalHours: false }

    const text = asText(await renderContactPage())

    expect(text).toContain("11h30 - 22h00")
    expect(text).not.toContain("07h00 - 09h00")
  })

  it("shows the real phone number and email", async () => {
    const html = await renderContactPage()

    expect(html).toContain("+33 1 42 80 12 34")
    expect(html).toContain("bonjour@lecomptoir.fr")
    // `tel:` cannot carry the spaces the printed number has.
    expect(html).toContain('href="tel:+33142801234"')
    expect(html).toContain('href="mailto:bonjour@lecomptoir.fr"')
  })

  it("never ships the invented placeholders it used to", async () => {
    // Each of these reached a real client's contact page. A visitor who acted
    // on one of them drove to the wrong street or called a stranger.
    const html = await renderContactPage()

    expect(html).not.toContain("123 Rue de la Gastronomie")
    expect(html).not.toContain("75001 Paris")
    expect(html).not.toContain("+33 1 23 45 67 89")
    expect(html).not.toContain("contact@restaurant.com")
    expect(html).not.toContain("11h00 - 22h00")
    expect(html).not.toContain("10h00 - 23h00")
  })

  it("omits a contact row the establishment has not filled in", async () => {
    store = { ...LE_COMPTOIR, phone: undefined, email: undefined }
    const html = await renderContactPage()

    expect(html).not.toContain('href="tel:')
    expect(html).not.toContain('href="mailto:')
  })

  it("waits rather than inventing anything while the query is in flight", async () => {
    store = undefined
    const html = await renderContactPage()

    expect(html).toContain("animate-pulse")
    expect(html).not.toContain("12 rue des Martyrs")
    expect(html).not.toContain("123 Rue de la Gastronomie")
  })

  it("still renders the page when no store is selected", async () => {
    store = null
    const html = await renderContactPage()

    expect(html).toContain("Adresse")
    expect(html).not.toContain("123 Rue de la Gastronomie")
  })
})
