import { StoreTheme } from "@/components/storefront/store-theme"

/**
 * The account screens render on the STOREFRONT's palette, not the engine's.
 *
 * WHY THE SCOPE. This layout used to be a bare fragment, so the six pages under
 * it resolved `:root`/`.dark` from `app/globals.css` — the administration's
 * orange — while painting themselves with the storefront's greens as literal
 * hex. Those literals were not a coincidence: `#0D5C3F` is `hsl(158 75% 21%)`,
 * which is `.storefront-theme`'s `--primary` digit for digit, `#0A412D` is its
 * `--primary-hover` and `#FDFCF6` its `--background`. The scope was derived
 * from these pages; it just never reached them. Carrying it here says what the
 * markup already meant, and it is the right audience — a diner signing in to
 * order is the same person the storefront serves.
 *
 * WHY `StoreTheme` TOO. The scope alone only supplies the storefront's
 * DEFAULTS. `buildBrandingCss` writes the establishment's own palette
 * unlayered — to `:root` and, since #410, to `.storefront-theme` as well,
 * because a property declared on an element beats the one it would inherit and
 * this scope is on an element of its own. But it writes nothing unless
 * something mounts it, and until now the only mount was
 * `app/(storefront)/layout.tsx`. Without this line an establishment that has
 * chosen its colours on the Design screen would still meet its customers on a
 * sign-in page in someone else's green.
 *
 * No `initialCss`: the storefront layout resolves the cookie's store on the
 * server to spare a returning visitor one repaint, and an authentication form
 * should not wait on Convex before it renders. A branded establishment repaints
 * once, after hydration.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="storefront-theme bg-background text-foreground">
      <StoreTheme />
      {children}
    </div>
  )
}
