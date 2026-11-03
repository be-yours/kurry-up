/**
 * The order-tracking page carried the same crash as `/contact`, on the page a
 * customer opens immediately after paying.
 *
 * `kitchenTickets.getByTrackingToken` passes the store's `address` through
 * unflattened, so `ticket.storeBranding.address` is the required
 * `v.object({street, city, postalCode, country})`. Rendering it as a child
 * threw "Objects are not valid as a React child".
 *
 * The `&&` guard that stood in front of it never protected anything: an object
 * is always truthy, so the branch it guarded ran on every ticket that had a
 * store — which is all of them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

type Ticket = {
  orderNumber: string
  status: string
  storeBranding: {
    name: string
    slug: string
    address: {
      street: string
      city: string
      postalCode: string
      country: string
    }
  } | null
}

const TICKET: Ticket = {
  orderNumber: "A-1042",
  status: "in_progress",
  storeBranding: {
    name: "Le Comptoir des Martyrs",
    slug: "le-comptoir-des-martyrs",
    address: {
      street: "12 rue des Martyrs",
      city: "Paris",
      postalCode: "75009",
      country: "France",
    },
  },
}

let ticket: Ticket | null | undefined = TICKET

vi.mock("convex/react", () => ({ useQuery: () => ticket }))
vi.mock("next/navigation", () => ({ useParams: () => ({ token: "tok_1" }) }))
vi.mock("@/convex/_generated/api", () => ({
  api: { kitchenTickets: { getByTrackingToken: "kitchenTickets:getByTrackingToken" } },
}))

async function renderTrackPage(): Promise<string> {
  const Page = (await import("@/app/(storefront)/track/[token]/page")).default
  return renderToStaticMarkup(<Page />)
}

describe("the order tracking page", () => {
  beforeEach(() => {
    ticket = TICKET
  })

  it("renders instead of throwing on the store address object", async () => {
    await expect(renderTrackPage()).resolves.toBeTypeOf("string")
  })

  it("shows the establishment's address as an address", async () => {
    const html = await renderTrackPage()

    expect(html).toContain("12 rue des Martyrs, 75009 Paris, France")
  })

  it("shows nothing rather than an empty line when the ticket carries no store", async () => {
    ticket = { ...TICKET, storeBranding: null }
    const html = await renderTrackPage()

    expect(html).not.toContain("12 rue des Martyrs")
    expect(html).not.toContain("mt-8 text-sm")
  })
})
