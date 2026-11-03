"use client"

import { useState, useEffect, useSyncExternalStore, useRef } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ShoppingBag, Menu, X } from "lucide-react"
import { motion, AnimatePresence } from "framer-motion"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@be-yours/ui"
import {
  useCartStore,
  useTranslation,
} from "@be-yours/restaurant"
import { useCmsPage } from "@/lib/cms/useCmsPage"
import { resolveBrandName } from "@/lib/cms/brand-name"
import { useStoreId } from "@/lib/hooks/use-store-id"
import { useReservationEntry } from "@/lib/hooks/use-reservation-entry"
import { mergeNavLinks, siteNavLinks } from "@/lib/site-routes"
import { CartSheet } from "./cart-sheet"
import { StoreSelectorDropdown } from "./store-selector-dropdown"
import { ReserveLink } from "./reserve-link"
import { LanguageSelectorDropdown } from "./language-selector-dropdown"
import { ThemeToggle } from "./theme-toggle"
import { UserMenu } from "./user-menu"

/**
 * The engine's five nav entries, by translation key.
 *
 * The labels were a module-level constant of French literals, which is a
 * shape that cannot follow a language switch — the array is built once at
 * import time, before any locale exists. The hrefs stay constant; only the
 * label is resolved per render.
 *
 * A site's own pages are not listed here: they come from `site/routes.ts` and
 * are merged in below. The five count 10, 20, 30, 40, 50 in this order, which is
 * what a site's `order` is measured against.
 */
const NAV_LINKS = [
  { href: "/", labelKey: "nav.home" },
  { href: "/menu", labelKey: "nav.menu" },
  { href: "/about", labelKey: "nav.about" },
  { href: "/blog", labelKey: "nav.blog" },
  { href: "/contact", labelKey: "nav.contact" },
]

export function StorefrontHeader({ hasBanner = false }: { hasBanner?: boolean }) {
  const pathname = usePathname()
  const { t } = useTranslation()
  // The registry is read here rather than at import: a handful of entries, and
  // the same call serves a test that swaps it. The mobile overlay below reads
  // the same list, so a site link is in both or in neither.
  const navLinks = mergeNavLinks(
    NAV_LINKS.map((link) => ({ href: link.href, label: t(link.labelKey) })),
    siteNavLinks("header"),
  )
  const itemCount = useCartStore((s) => s.getItemCount())

  // null when the module is off — for EVERY surface below. See the hook.
  const reservation = useReservationEntry()
  // The establishment whose header this is — the last link of the brand-name
  // chain below, and the same hook the footer already uses.
  const { store } = useStoreId()
  const cms = useCmsPage("storefront-layout")
  const logoUrl = cms.block("branding").field("logo").mediaUrl
  /* NEVER THE VENDOR'S NAME (#613). This read `?? "BeYours"`, and the seed
     never wrote the `branding` block — it wrote `header.brandName`, one
     accordion below in the same editor, which nothing read. So a delivered
     restaurant served its diners our brand on its own domain. The chain now
     ends at the establishment's own `stores.name`. */
  const brandName = resolveBrandName({
    branding: cms.block("branding").field("brandName").text,
    legacyHeader: cms.block("header").field("brandName").text,
    storeName: store?.name,
  })

  const [isScrolled, setIsScrolled] = useState(false)
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [isCartOpen, setIsCartOpen] = useState(false)
  const hasMounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  )

  /*
    The badge is a `<span>` holding a number, which a screen reader announces
    on neither focus nor change — so the cart button said "Ouvrir la Box" to a
    blind diner with four dishes in it exactly as it did to one with none. The
    count belongs in the button's own name, which is read every time the button
    is reached.

    `hasMounted` gates it for the same reason it gates the badge: the cart is
    rehydrated from `localStorage` after hydration, and a label built from a
    count the server did not have is a mismatch React will complain about.
    Announcing a CHANGE is `CartAnnouncer`'s job; this is what the control is
    called.
  */
  const cartLabel =
    hasMounted && itemCount > 0
      ? t("accessibility.openBoxWithCount", { count: itemCount })
      : t("accessibility.openBox")

  const isHomePage = pathname === "/"

  // On non-home pages, always show the scrolled/solid variant
  const showTransparent = isHomePage && !isScrolled

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 50)
    handleScroll()
    window.addEventListener("scroll", handleScroll, { passive: true })
    return () => window.removeEventListener("scroll", handleScroll)
  }, [])

  // Close mobile menu on route change
  const prevPathname = useRef(pathname)
  useEffect(() => {
    if (prevPathname.current !== pathname) {
      prevPathname.current = pathname
      // eslint-disable-next-line react-hooks/set-state-in-effect -- legitimate side effect on route change
      setIsMobileMenuOpen(false)
    }
  }, [pathname])

  return (
    <>
      <header
        className={`fixed left-0 right-0 z-40 transition-all duration-300 ${
          hasBanner ? "top-[40px]" : "top-0"
        } ${
          showTransparent
            ? "bg-transparent border-transparent"
            : "bg-card/90 backdrop-blur-md shadow-sm border-b border-border"
        }`}
      >
        {/* `storefront-nav*` are hooks for the `nav` layout family (#507), not
            styling. Tailwind's generated class names are not a contract, so the
            rules in `app/globals.css` need names of their own. The default here
            IS `left`, so an unstyled bar is already correct. */}
        <div className="storefront-nav flex items-center justify-between gap-4 px-6 py-4 lg:px-12">
          {/* Logo */}
          <Link
            href="/"
            className={`storefront-nav-brand shrink-0 whitespace-nowrap font-black text-xl tracking-tighter transition-colors duration-300 ${
              showTransparent ? "text-white" : "text-accent-foreground"
            }`}
          >
            {logoUrl ? (
              <img
                src={logoUrl}
                alt={brandName}
                className="h-8 w-auto object-contain"
              />
            ) : (
              brandName
            )}
          </Link>

          {/* Desktop nav */}
          <nav className="storefront-nav-links hidden items-center gap-5 lg:flex xl:gap-8">
            {navLinks.map((link) => {
              const isActive = pathname === link.href
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`relative whitespace-nowrap font-black text-sm uppercase tracking-widest transition-colors duration-300 ${
                    showTransparent
                      ? "text-white hover:text-white/80"
                      : isActive
                        ? "text-accent-foreground"
                        : "text-muted-foreground hover:text-accent-foreground"
                  }`}
                >
                  {link.label}
                  {isActive && (
                    <span
                      className={`absolute -bottom-1 left-0 right-0 h-0.5 rounded-full ${
                        showTransparent ? "bg-white" : "bg-accent-solid"
                      }`}
                    />
                  )}
                </Link>
              )
            })}

            {/* Rendered only while the establishment's reservation switch is on:
                its own booking page, or the owner's external tool. */}
            {reservation && (
              <ReserveLink
                entry={reservation}
                className={`whitespace-nowrap font-black text-sm uppercase tracking-widest transition-colors duration-300 ${
                  showTransparent
                    ? "text-white hover:text-white/80"
                    : "text-muted-foreground hover:text-accent-foreground"
                }`}
              >
                {t("nav.reserve")}
              </ReserveLink>
            )}
          </nav>

          {/* Desktop right actions: Lang → Theme → Store → Cart */}
          <TooltipProvider delayDuration={300}>
            <div className="storefront-nav-actions hidden shrink-0 items-center gap-3 lg:flex">
              <LanguageSelectorDropdown variant={showTransparent ? "transparent" : "solid"} />
              <ThemeToggle variant={showTransparent ? "transparent" : "solid"} />
              <StoreSelectorDropdown variant={showTransparent ? "transparent" : "solid"} />

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setIsCartOpen(true)}
                    className={`relative flex h-10 w-10 items-center justify-center rounded-full border transition-all duration-300 ${
                      showTransparent
                        ? "bg-white/10 border-white/20 text-white hover:bg-white/20"
                        : "bg-card border-border shadow-sm text-accent-foreground hover:bg-muted"
                    }`}
                    aria-label={cartLabel}
                  >
                    <ShoppingBag className="h-4 w-4" />
                    {hasMounted && itemCount > 0 && (
                      <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent-solid text-[10px] font-bold text-accent-solid-foreground">
                        {itemCount > 99 ? "99+" : itemCount}
                      </span>
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent>{t("cart.boxTitle")}</TooltipContent>
              </Tooltip>

              <UserMenu variant={showTransparent ? "transparent" : "solid"} />
            </div>
          </TooltipProvider>

          {/* Mobile: Lang → Store → Cart → Hamburger */}
          <div className="flex items-center gap-3 lg:hidden">
            <LanguageSelectorDropdown variant={showTransparent ? "transparent" : "solid"} />
            <StoreSelectorDropdown variant={showTransparent ? "transparent" : "solid"} />

            <button
              type="button"
              onClick={() => setIsCartOpen(true)}
              className={`relative flex h-10 w-10 items-center justify-center rounded-full border transition-all duration-300 ${
                showTransparent
                  ? "bg-white/10 border-white/20 text-white"
                  : "bg-card border-border shadow-sm text-accent-foreground"
              }`}
              aria-label={cartLabel}
            >
              <ShoppingBag className="h-4 w-4" />
              {hasMounted && itemCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent-solid text-[10px] font-bold text-accent-solid-foreground">
                  {itemCount > 99 ? "99+" : itemCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className={`flex h-10 w-10 items-center justify-center rounded-full border transition-all duration-300 ${
                showTransparent
                  ? "bg-white/10 border-white/20 text-white"
                  : "bg-card border-border shadow-sm text-accent-foreground"
              }`}
              aria-label={
                isMobileMenuOpen
                  ? t("accessibility.closeMenu")
                  : t("accessibility.openMenu")
              }
            >
              {isMobileMenuOpen ? (
                <X className="h-4 w-4" />
              ) : (
                <Menu className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Mobile full-screen menu overlay */}
      <AnimatePresence>
        {isMobileMenuOpen && (
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "tween", duration: 0.3, ease: "easeInOut" }}
            className="fixed inset-0 z-40 flex flex-col bg-primary lg:hidden"
          >
            {/* Close button */}
            <div className="flex items-center justify-between px-6 py-4">
              <span className="font-black text-xl tracking-tighter text-primary-foreground">
                {logoUrl ? (
                  <img
                    src={logoUrl}
                    alt={brandName}
                    className="h-8 w-auto object-contain brightness-0 invert"
                  />
                ) : (
                  brandName
                )}
              </span>
              <button
                type="button"
                onClick={() => setIsMobileMenuOpen(false)}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-hover border border-white/20 text-primary-foreground"
                aria-label={t("accessibility.closeMenu")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Nav links */}
            <nav className="flex flex-1 flex-col justify-center gap-2 px-10">
              {navLinks.map((link, index) => {
                const isActive = pathname === link.href
                return (
                  <motion.div
                    key={link.href}
                    initial={{ opacity: 0, x: 40 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.1 + index * 0.06, duration: 0.3 }}
                  >
                    <Link
                      href={link.href}
                      className={`block text-4xl font-black uppercase tracking-tight transition-colors ${
                        isActive
                          ? "text-primary-foreground underline decoration-4 underline-offset-8"
                          : "text-primary-foreground hover:underline hover:underline-offset-8"
                      }`}
                    >
                      {link.label}
                    </Link>
                  </motion.div>
                )
              })}

              {reservation && (
                <motion.div
                  initial={{ opacity: 0, x: 40 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.1 + navLinks.length * 0.06, duration: 0.3 }}
                >
                  <ReserveLink
                    entry={reservation}
                    className="block text-4xl font-black uppercase tracking-tight text-primary-foreground transition-colors hover:underline hover:underline-offset-8"
                  >
                    {t("nav.reserve")}
                  </ReserveLink>
                </motion.div>
              )}
            </nav>

            {/* Account and colour scheme at the bottom */}
            <div className="flex items-center gap-3 px-10 pb-8">
              <UserMenu variant="overlay" />
              <ThemeToggle variant="overlay" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <CartSheet open={isCartOpen} onOpenChange={setIsCartOpen} />
    </>
  )
}
