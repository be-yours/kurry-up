// @vitest-environment jsdom

/**
 * Renders the real storefront chrome to static HTML, for visual review (#507).
 *
 * WHY A TEST WRITES FILES. A layout family is CSS, and the one question that
 * decides whether its rule is right — does this lay out the way it is meant to —
 * cannot be answered here: **jsdom parses CSS and does not lay it out**, so
 * `getComputedStyle` hands back the declared value and no geometry. That is why
 * `nav`, `hero` and `menu` were held back while `tex`, `up` and `foot` shipped:
 * the first three move boxes, the last three do not.
 *
 * A real browser is the only instrument, and a real browser needs real markup.
 * Copying the components' markup into a fixture would test the copy, so this
 * renders the COMPONENTS and serialises what they produced. The assertions are
 * the ones that would make the artefact worthless if they failed — the hooks the
 * CSS selects on have to be present, and the tree has to be more than a stub.
 *
 * `scripts/layout-harness.mjs` turns these fragments into one page per family
 * value, with `app/globals.css` compiled as Next compiles it.
 * `.layout-harness/` is gitignored: it is an instrument, not an output.
 */

import fs from "node:fs"
import path from "node:path"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OUT = path.resolve(__dirname, "../.layout-harness/fragments")

/** Which route the header thinks it is on. `/` is the transparent-header case. */
let pathname = "/"

/** Enough of a catalogue to lay out: two rows at three columns, varied names. */
const DISHES = [
  { _id: "p1", name: "Pizza Reine", description: "Jambon, champignons, mozzarella di bufala", price: 1250, isActive: true, categoryId: "c1" },
  { _id: "p2", name: "Margherita", description: "San Marzano, basilic, huile d'olive", price: 1050, isActive: true, categoryId: "c1" },
  { _id: "p3", name: "Quatre fromages", description: "Gorgonzola, chèvre, parmesan, mozzarella", price: 1450, isActive: true, categoryId: "c1" },
  { _id: "p4", name: "Calzone", description: "Ricotta, épinards, œuf", price: 1390, isActive: true, categoryId: "c1" },
  { _id: "p5", name: "Tiramisu", description: "Mascarpone, café, cacao amer", price: 650, isActive: true, categoryId: "c2" },
  { _id: "p6", name: "Panna cotta", description: "Vanille de Madagascar, coulis de fruits rouges", price: 590, isActive: true, categoryId: "c2" },
]

const STORE = {
  _id: "stores_harness",
  name: "Le Comptoir",
  address: { street: "12 rue de la Paix", postalCode: "75002", city: "Paris" },
  phone: "01 23 45 67 89",
  email: "bonjour@lecomptoir.fr",
}

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

vi.mock("convex/react", () => ({
  useQuery: () => [STORE],
  useMutation: () => async () => null,
  useAction: () => async () => null,
}))

// `api.stores.list` and friends are only ever compared by identity by the mocked
// `useQuery`, so any stable object will do — but it has to exist at every depth.
const apiProxy: unknown = new Proxy(
  {},
  { get: (_t, key) => (key === "then" ? undefined : apiProxy) }
)
vi.mock("@/convex/_generated/api", () => ({ api: apiProxy }))

// The CMS block the hero reads. The image matters: without one the media column
// is empty, and half the values under review are about where that column sits.
const HERO_IMAGE = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2MDAgNjAwIj48cmVjdCB3aWR0aD0iNjAwIiBoZWlnaHQ9IjYwMCIgcng9IjQwIiBmaWxsPSIjZjRhMjYxIi8+PGNpcmNsZSBjeD0iMzAwIiBjeT0iMzAwIiByPSIxOTAiIGZpbGw9IiNlNzZmNTEiLz48L3N2Zz4="

vi.mock("@/lib/cms/useCmsPage", () => ({
  useCmsPage: () => ({
    block: (name: string) => ({
      field: (field: string) =>
        name === "hero" && field === "image" ? { mediaUrl: HERO_IMAGE, altText: "" } : {},
    }),
  }),
}))

vi.mock("@/lib/hooks", () => ({
  useStoreId: () => ({ storeId: STORE._id, store: STORE, isLoading: false }),
}))

vi.mock("@/lib/hooks/use-store-id", () => ({
  useStoreId: () => ({ storeId: STORE._id, store: STORE, isLoading: false }),
}))

vi.mock("sonner", () => ({ toast: { success: () => {}, error: () => {} } }))

vi.mock("@be-yours/restaurant", () => ({
  /* The collector's emitter moved into this package with the collector; a
     component that adds to the cart now imports it from here, so a partial
     mock has to carry it or the import throws. It is a no-op in a test: the
     real one is inert until a mounted collector registers an emitter. */
  recordSignal: () => {},
  // Called both ways in this tree — with a selector, and bare for the whole
  // store — so the mock has to answer both.
  useCartStore: (selector?: (s: unknown) => unknown) => {
    const state = { getItemCount: () => 2, items: [], addItem: () => {} }
    return typeof selector === "function" ? selector(state) : state
  },
  useStorefrontStoreSelection: (selector?: (s: unknown) => unknown) => {
    const state = { storeId: STORE._id, setStoreId: () => {} }
    return typeof selector === "function" ? selector(state) : state
  },
  isProductAvailable: () => true,
  useLocalizedDocument: <T,>(doc: T) => doc,
  // The categories band localises its names the way the carte does.
  useLocalizedDocuments: <T,>(docs: readonly T[] | undefined | null) => docs ?? [],
  formatPrice: (cents: number) =>
    new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(cents / 100),
  useTranslation: () => ({
    locale: "fr",
    // Every key the chrome and the home page ask for, so the artefact a human
    // reviews reads as the storefront does instead of showing `footer.myOrders`.
    t: (key: string, params?: Record<string, string | number>) => {
      const text =
        {
          "nav.home": "Accueil",
          "nav.menu": "Carte",
          "nav.about": "Le lieu",
          "nav.blog": "Journal",
          "nav.contact": "Contact",
          "nav.cart": "Panier",
          "nav.account": "Mon compte",
          "footer.navigation": "Navigation",
          "footer.usefulLinks": "Liens utiles",
          "footer.myOrders": "Mes commandes",
          "footer.myFavorites": "Mes favoris",
          "footer.myAddresses": "Mes adresses",
          "footer.ourRestaurants": "Nos restaurants",
          "product.price": "Prix",
          "blog.readMore": "Lire la suite",
          "storefront.categoryProductsOne": "{count} produit",
          "storefront.categoryProductsOther": "{count} produits",
        }[key] ?? key
      return text.replace(/\{(\w+)\}/g, (whole, name: string) => String(params?.[name] ?? whole))
    },
  }),
}))

// The chrome's own children are not what any layout family selects on, and each
// drags in a tree of its own. Stubbed to one element so the bar keeps its real
// child count and the artefact stays about the arrangement.
vi.mock("@/components/storefront/cart-sheet", () => ({
  CartSheet: () => <button type="button" aria-label="Panier">Panier</button>,
}))
vi.mock("@/components/storefront/store-selector-dropdown", () => ({
  StoreSelectorDropdown: () => <button type="button">Paris 2e</button>,
}))
vi.mock("@/components/storefront/language-selector-dropdown", () => ({
  LanguageSelectorDropdown: () => <button type="button">FR</button>,
}))
vi.mock("@/components/storefront/user-menu", () => ({
  UserMenu: () => <button type="button">Compte</button>,
}))

/**
 * framer-motion, at rest.
 *
 * NOT a convenience. `motion.div` writes its INITIAL state as inline style and
 * animates from there on a frame loop, and nothing advances frames here — so the
 * serialised hero carried `opacity: 0` on both of its columns and the artefact
 * showed an empty section. What a layout family arranges is where the boxes
 * COME TO REST, which is what a plain element gives.
 */
vi.mock("framer-motion", () => {
  const passthrough = ({ children, ...rest }: Record<string, unknown> & { children?: React.ReactNode }) => {
    const {
      initial: _i, animate: _a, exit: _e, transition: _t, variants: _v,
      whileHover: _wh, whileTap: _wt, whileInView: _wi, viewport: _vp,
      layout: _l, layoutId: _li, drag: _d, style, className, ...html
    } = rest as Record<string, unknown>
    return <div className={className as string} style={style as React.CSSProperties} {...html}>{children}</div>
  }
  const motion = new Proxy({}, { get: () => passthrough })
  return {
    motion,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    MotionConfig: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    useReducedMotion: () => false,
  }
})

vi.mock("@/lib/parse-colored-text", () => ({
  parseColoredText: (text: string) => text,
}))

vi.mock("next/image", () => ({
  // A plain <img> at the same box: next/image needs a loader and a real file,
  // and what is under review is where the media column SITS.
  //
  // base64 rather than the readable `svg+xml,<svg …>` form: the reviewer turns
  // each page into a data: URL of its own, and a data URI carrying raw quotes
  // and spaces inside that one made the page unopenable — it looked like a
  // missing file.
  default: ({ alt, className }: { alt?: string; className?: string }) => (
    <img
      alt={alt ?? ""}
      className={className}
      src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MDAgNDAwIj48cmVjdCB3aWR0aD0iNDAwIiBoZWlnaHQ9IjQwMCIgZmlsbD0iI2MyNDEwYyIvPjwvc3ZnPg=="
    />
  ),
}))

const { StorefrontHeader } = await import("@/components/storefront/storefront-header")
const { StorefrontFooter } = await import("@/components/storefront/storefront-footer")
const HomepageContent = (await import("@/app/(storefront)/_components/HomepageContent")).default
// The page mounts tooltips without a provider of its own — the real one lives
// in the storefront layout, above it.
const { TooltipProvider } = await import("@be-yours/ui")
const { ProductGrid } = await import("@/components/storefront/product-grid")

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  // jsdom ships neither, and framer-motion's viewport triggers want both.
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = Observer
  ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = Observer
  fs.mkdirSync(OUT, { recursive: true })
})

const mounted: Array<{ root: Root; container: HTMLElement }> = []

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
})

async function renderToHtml(node: React.ReactElement): Promise<string> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(node)
  })
  return container.innerHTML
}

function emit(name: string, html: string): void {
  fs.writeFileSync(path.join(OUT, `${name}.html`), html)
}

describe("the storefront chrome, serialised for a browser", () => {
  test("the header over a hero — the transparent state", async () => {
    pathname = "/"
    const html = await renderToHtml(<StorefrontHeader hasBanner={false} />)

    // The two things that make the artefact worth looking at: it is the real
    // bar, and it is the transparent variant rather than the opaque one.
    expect(html).toContain("<header")
    expect(html).toContain("bg-transparent")
    expect(html).toContain("Accueil")

    emit("header-transparent", html)
  })

  test("the header on an inner page — the opaque state", async () => {
    pathname = "/menu"
    const html = await renderToHtml(<StorefrontHeader hasBanner={false} />)

    expect(html).toContain("bg-card/90")
    expect(html).not.toContain("bg-transparent")

    emit("header-opaque", html)
  })

  test("the footer, with its layout hooks intact", async () => {
    const html = await renderToHtml(<StorefrontFooter />)

    // The hooks `foot` selects on. A renamed class would leave the rules
    // matching nothing and the artefact looking identical under all three
    // values, which is the one failure a screenshot cannot distinguish from
    // "the rule is wrong".
    for (const hook of [
      "storefront-footer",
      "storefront-footer-cols",
      "storefront-footer-brand",
      "storefront-footer-note",
    ]) {
      expect(html, hook).toContain(hook)
    }

    emit("footer", html)
  })

  test("the homepage hero, with its layout hooks intact", async () => {
    pathname = "/"
    const html = await renderToHtml(
      <TooltipProvider>
        <HomepageContent />
      </TooltipProvider>
    )

    for (const hook of [
      "storefront-hero",
      "storefront-hero-row",
      "storefront-hero-text",
      "storefront-hero-media",
    ]) {
      expect(html, hook).toContain(hook)
    }

    // The hero and the section under it, taken from the DOM rather than sliced
    // out of the string — a string slice can cut a tag in half, and the artefact
    // has to be markup a browser parses the way the app's is parsed.
    //
    // The section under it earns its place: the features strip rides on a
    // negative margin INTO the hero's bottom curve, so a value that changes that
    // curve changes where the strip sits. The rest of the homepage is not what
    // this family arranges, and carrying it put the page over the size the
    // reviewer will open.
    const hero = document.querySelector(".storefront-hero")
    expect(hero, "no .storefront-hero in the rendered homepage").not.toBeNull()
    emit("hero", (hero?.outerHTML ?? "") + (hero?.nextElementSibling?.outerHTML ?? ""))
  })

  test("the dish grid, which is what `menu` arranges", async () => {
    // `ProductGrid` rather than the whole menu page: the page is a hero, a
    // search bar, a category row, formules, platform tiles and a blog strip, and
    // only this grid is what the family lays out. Mocking the page to get at it
    // would be mocking six things to look at one.
    const html = await renderToHtml(
      <TooltipProvider>
        <ProductGrid
          products={DISHES as never}
          storeId={STORE._id as never}
          isStoreOpen
          onProductClick={() => {}}
          onAddToCart={() => {}}
        />
      </TooltipProvider>
    )

    expect(html).toContain("storefront-menu")
    // Enough dishes to see a grid rather than a row, and prices to align.
    expect(html).toContain("Pizza Reine")
    expect(html.match(/storefront-menu-item/g)?.length).toBe(DISHES.length)

    emit("menu", html)
  })
})
