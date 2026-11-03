// @vitest-environment jsdom
/**
 * The kitchen seeder is offered to the role that may actually run it (#523).
 *
 * WHAT WENT WRONG. `SeedKitchenButton` gated on `if (!storeId) return null` and
 * nothing else, so « Créer commandes test » and « Nettoyer test » rendered for
 * every role on every client site, beside the real tickets on a working kitchen
 * display. `seedKitchenOrders` and `cleanKitchenSeed` are `storeMutation`s on
 * `kitchen:manage`, which no client role holds, so an owner or a cook who
 * pressed one was shown a control and then refused by a toast.
 *
 * WHY THE BUTTON IS GATED RATHER THAN DELETED FROM THE TEMPLATE. Deleting it
 * looked simpler and costs more. `convex/` is held byte-identical across the
 * two apps by `check-app-divergence`, so both mutations ship to every client
 * deployment either way; removing only the button leaves them callerless, which
 * `tests/convex/public-surface.test.ts` refuses — and the one way past that test
 * is its kept-callerless list, which its own comment requires to be identical in
 * both apps because the bench DOES call them. Recording the exception would
 * therefore have meant diverging a guard file between the twins, which is the
 * asymmetry that lets drift in.
 *
 * A control that appears exactly for whoever the server will serve is the
 * smaller change and the more honest screen. The gate is the same permission
 * the mutation checks, so the two cannot disagree.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

vi.mock("convex/react", () => ({
  useMutation: () => async () => null,
  useQuery: () => undefined,
  useAction: () => async () => null,
}))

vi.mock("sonner", () => ({ toast: { success: () => {}, error: () => {} } }))

vi.mock("@/convex/_generated/api", () => ({
  api: {
    seedKitchenOrders: {
      seedKitchenOrders: "seedKitchenOrders:seedKitchenOrders",
      cleanKitchenSeed: "seedKitchenOrders:cleanKitchenSeed",
    },
  },
}))

vi.mock("@/lib/admin/hooks", () => ({
  useAdminStoreId: () => "store_a",
}))

/** The role the component reads, set per test. */
let role: string | null = null

vi.mock("@be-yours/admin", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useAdminAuthStore: (selector: (state: { role: string | null }) => unknown) =>
      selector({ role }),
  }
})

import { SeedKitchenButton } from "@/app/(admin)/dashboard/orders/kitchen/SeedKitchenButton"

let mounted: { root: Root; container: HTMLElement } | null = null

beforeAll(() => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(() => {
  if (mounted) {
    const { root, container } = mounted
    act(() => root.unmount())
    container.remove()
    mounted = null
  }
  role = null
})

async function renderAs(as: string | null): Promise<HTMLElement> {
  role = as
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted = { root, container }
  await act(async () => {
    root.render(<SeedKitchenButton />)
  })
  return container
}

/** Every role in the product, and whether it holds `kitchen:manage`. */
const CLIENT_ROLES = [
  "client_admin",
  "manager",
  "staff",
  "kitchen",
  "delivery",
  "customer",
] as const

describe("the kitchen seeder", () => {
  it("is offered to a super admin", async () => {
    // Anti-vacuity: without this, "renders nothing" below would also pass on a
    // component that renders nothing for anybody.
    const text = (await renderAs("super_admin")).textContent ?? ""

    expect(text).toContain("Créer commandes test")
    expect(text).toContain("Nettoyer test")
  })

  for (const as of CLIENT_ROLES) {
    it(`is not offered to ${as}`, async () => {
      expect((await renderAs(as)).textContent).toBe("")
    })
  }

  it("is not offered before the role is known", async () => {
    // `null` is the session still loading. Showing the control and withdrawing
    // it is the flicker; showing nothing and adding it is not.
    expect((await renderAs(null)).textContent).toBe("")
  })
})
