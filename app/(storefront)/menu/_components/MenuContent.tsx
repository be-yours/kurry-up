"use client"

import { useState, useMemo, useCallback, useEffect, useRef, Suspense } from "react"
import Link from "next/link"
import Image from "next/image"
import { useSearchParams, useRouter } from "next/navigation"
import { Search, SlidersHorizontal, ChevronDown, ChevronRight, X, ArrowRight } from "lucide-react"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import {
  Button,
  Badge,
  Dialog,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@be-yours/ui"
import {
  filterProducts,
  sortProducts,
  useCartStore,
  isProductAvailable,
  useLocalizedDocuments,
} from "@be-yours/restaurant"
import type { CategoryDoc, ProductDoc, ProductSortBy } from "@be-yours/restaurant"
import type { Id } from "@/convex/_generated/dataModel"
import { useStoreId } from "@/lib/hooks/use-store-id"
import { useStoreStatus } from "@/lib/hooks/use-store-status"
import { formatArticleDate } from "@/lib/blog/presentation"
import { ProductGrid } from "@/components/storefront/product-grid"
import { FormuleCard, type Formule } from "@/components/storefront/formule-card"
import { ProductDetailClient } from "@/components/storefront/product-detail-client"
import { MenuPagination } from "@/components/storefront/menu-pagination"
import { toast } from "sonner"
import { recordSignal } from "@be-yours/restaurant"

/**
 * How each delivery platform is presented, when this establishment is on it.
 *
 * The copy and the brand colours only; the LINK comes from the store's own
 * integration row. Keeping them apart is the point — a tile that can render
 * without a URL is how the two marketplace home pages ended up hard-coded on
 * every menu page in the product.
 */
const DELIVERY_PLATFORMS = {
  uberEats: {
    name: "Uber Eats",
    headline: "Livraison rapide",
    blurb: "Recevez vos plats préférés directement chez vous",
  },
  deliveroo: {
    name: "Deliveroo",
    headline: "À votre porte",
    blurb: "Commandez et faites-vous livrer en quelques minutes",
  },
} as const

/**
 * The platforms' own brand colours, spelled where the scanner can read them.
 *
 * Deliberately NOT a field on `DELIVERY_PLATFORMS` above, and this is the one
 * place in this file where a lint-shaped concern decides the shape of the
 * code. `tests/a11y/contrast.test.ts` resolves a foreground against the
 * nearest surface painted in the SAME tree: a `bg-` class reached through a
 * variable is invisible to it, so the black tile copy read as black on the
 * page background — 1.14:1, a failure the rendered pixels never produce
 * (black on #06C167 measures about 11:1).
 *
 * A ternary in the class list is a shape the scanner does resolve — it reads
 * each branch as its own state — so the colours stay data-driven for a reader
 * and stay measurable for the guard. Brand hexes rather than tokens because
 * they are Uber Eats' and Deliveroo's identity, not this establishment's
 * palette; the design system has no opinion about them and must not repaint
 * them.
 */

const ITEMS_PER_PAGE = 12

function MenuContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { storeId } = useStoreId()
  const { isOpen, timeZone } = useStoreStatus(storeId)

  // The platforms this establishment is actually listed on, with its own page
  // on each. Empty — and the whole section absent — until an owner fills them
  // in on the store's integration card.
  const deliveryLinks = useQuery(
    api.storeIntegrations.publicLinks,
    storeId ? { storeId: storeId as Id<"stores"> } : "skip"
  )

  const addItem = useCartStore((s) => s.addItem)
  const cartStoreId = useCartStore((s) => s.storeId)

  // URL state
  const categorySlug = searchParams.get("category")
  const searchQuery = searchParams.get("q") ?? ""
  const sortBy = (searchParams.get("sort") as ProductSortBy) ?? "popular"

  // Local state
  const [search, setSearch] = useState(searchQuery)
  const [selectedProduct, setSelectedProduct] = useState<ProductDoc | null>(null)
  const [filters, setFilters] = useState({ availableOnly: false })
  const [currentPage, setCurrentPage] = useState(1)

  // Queries
  const rawProducts = useQuery(
    api.products.list,
    storeId ? { storeId: storeId as Id<"stores"> } : "skip"
  )
  const rawCategories = useQuery(
    api.categories.list,
    storeId ? { storeId: storeId as Id<"stores"> } : "skip"
  )
  /**
   * The *formules* on offer, with their sections resolved (#352).
   *
   * `listActive`, not `list`: the second is guarded and unfiltered, which is
   * right for the screen that switches a formule off and wrong here — a diner
   * must not be shown a deactivated bundle and must not need a session to see an
   * active one. See the comment on `menus.list`.
   */
  const formules = useQuery(
    api.menus.listActive,
    storeId ? { storeId: storeId as Id<"stores"> } : "skip"
  ) as Formule[] | undefined
  // The teaser below used to render three hard-coded posts, each linking back
  // to /blog. These are the owner's three most recent published articles.
  const latestArticles = useQuery(
    api.blog.listPublishedArticles,
    storeId ? { storeId: storeId as Id<"stores">, limit: 3 } : "skip"
  )

  // Swap in the visitor's language before anything reads a name. Doing it here
  // rather than at each render site means the search box, the category chips
  // and the line the quick-add writes into the cart all speak the same
  // language as the card the customer clicked.
  // The generic is spelled out because the Convex queries come back as `any`
  // — the shared handlers are untyped — and inference would otherwise widen
  // both lists to the bare translatable shape.
  const localizedProducts = useLocalizedDocuments<ProductDoc>(rawProducts)
  const localizedCategories = useLocalizedDocuments<CategoryDoc>(rawCategories)
  const products = rawProducts === undefined ? undefined : localizedProducts
  const categories = rawCategories === undefined ? undefined : localizedCategories

  // Find active category ID from slug
  const activeCategoryId = useMemo(() => {
    if (!categorySlug || !categories) return undefined
    return categories.find((c: { slug: string; _id: string }) => c.slug === categorySlug)?._id
  }, [categorySlug, categories])

  // Filter & sort
  const filteredProducts = useMemo(() => {
    if (!products) return undefined
    const filtered = filterProducts(products, {
      categoryId: activeCategoryId,
      search: search || undefined,
      availableOnly: filters.availableOnly,
    })
    return sortProducts(filtered, sortBy)
  }, [products, activeCategoryId, search, sortBy, filters])

  // Reset page on filter/sort/category/search change
  const prevFilterKey = useRef(`${categorySlug}-${search}-${sortBy}-${filters.availableOnly}`)
  useEffect(() => {
    const key = `${categorySlug}-${search}-${sortBy}-${filters.availableOnly}`
    if (prevFilterKey.current !== key) {
      prevFilterKey.current = key
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset pagination on filter change
      setCurrentPage(1)
    }
  }, [categorySlug, search, sortBy, filters])

  // Pagination
  const totalPages = filteredProducts ? Math.ceil(filteredProducts.length / ITEMS_PER_PAGE) : 0
  const paginatedProducts = useMemo(() => {
    if (!filteredProducts) return undefined
    const start = (currentPage - 1) * ITEMS_PER_PAGE
    return filteredProducts.slice(start, start + ITEMS_PER_PAGE)
  }, [filteredProducts, currentPage])

  // URL helpers
  const updateSearchParams = useCallback(
    (key: string, value: string | null) => {
      const params = new URLSearchParams(searchParams.toString())
      if (value) {
        params.set(key, value)
      } else {
        params.delete(key)
      }
      router.replace(`/menu?${params.toString()}`, { scroll: false })
    },
    [router, searchParams]
  )

  const handleCategorySelect = (slug: string | null) => {
    updateSearchParams("category", slug)
  }

  const handleSearchSubmit = () => {
    updateSearchParams("q", search || null)
  }

  const handleQuickAdd = (product: ProductDoc) => {
    if (!storeId) return
    if (cartStoreId && cartStoreId !== storeId) {
      toast.error("Vous avez des articles d'un autre restaurant.")
      return
    }
    if (!isProductAvailable(product, timeZone)) return

    if (product.options && product.options.length > 0) {
      setSelectedProduct(product)
      return
    }

    addItem({
      productId: product._id,
      name: product.name,
      price: product.price,
      taxRate: product.taxRate,
      categoryId: product.categoryId,
      quantity: 1,
      options: [],
      imageUrl: product.images?.[0],
    })
    toast.success(`${product.name} ajouté à la Box`)
  }

  // Active category name
  const activeCategoryName = categorySlug
    ? categories?.find((c: { slug: string }) => c.slug === categorySlug)?.name ?? categorySlug
    : "Tout"

  const sortLabel = {
    popular: "Recommandé",
    name: "Nom A-Z",
    price: "Prix croissant",
  }[sortBy]

  return (
    <div className="min-h-screen bg-background text-foreground font-sans overflow-x-hidden pt-20 transition-colors duration-500">
      {/* ─── HERO ─── */}
      <section className="pt-24 pb-20 px-6 md:px-12 bg-primary relative overflow-hidden rounded-b-[4rem] md:rounded-b-[8rem]">
        {/* Decorative blurs */}
        <div className="absolute top-0 right-0 w-full h-full opacity-10 pointer-events-none">
          <div className="absolute top-1/4 right-1/4 w-96 h-96 bg-white/20 rounded-full blur-[100px]" />
          <div className="absolute bottom-0 left-0 w-[800px] h-[800px] bg-primary/10 rounded-full blur-[120px]" />
        </div>

        <div className="max-w-7xl mx-auto relative z-10 text-center">
          <Badge className="bg-primary-hover text-primary-foreground border-white/30 backdrop-blur-md px-4 py-1.5 rounded-full mb-8 font-black tracking-widest uppercase text-[10px] shadow-lg">
            Notre Carte
          </Badge>
          <h1 className="text-6xl md:text-8xl font-black text-primary-foreground tracking-tighter leading-none mb-8 italic">
            Découvrez Notre <br />
            <span className="text-primary-foreground not-italic">Menu</span>
          </h1>
          <p className="text-xl text-primary-foreground max-w-2xl mx-auto mb-12 font-medium">
            Explorez notre sélection de plats préparés avec soin
          </p>

          {/* Search bar */}
          <div className="max-w-3xl mx-auto relative group">
            <div className="bg-card rounded-[2rem] p-2 shadow-2xl flex items-center gap-2 border-4 border-white/10 group-focus-within:border-primary/20 transition-all">
              <div className="pl-6 flex items-center justify-center">
                <Search className="h-6 w-6 text-muted-foreground" />
              </div>
              <input
                type="text"
                aria-label="Rechercher un plat"
                placeholder="Rechercher un plat..."
                className="flex-1 h-14 bg-transparent border-none outline-none text-lg font-bold placeholder:text-muted-foreground text-foreground"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearchSubmit()}
              />
              {search && (
                <button
                  type="button"
                  aria-label="Effacer la recherche"
                  onClick={() => {
                    setSearch("")
                    updateSearchParams("q", null)
                  }}
                  className="p-2 text-muted-foreground hover:text-muted-foreground"
                >
                  <X className="h-5 w-5" />
                </button>
              )}
              <Button
                onClick={handleSearchSubmit}
                className="h-14 px-8 rounded-2xl bg-primary hover:bg-primary-hover text-primary-foreground font-black uppercase tracking-widest text-xs shadow-xl transition-all"
              >
                Rechercher
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* ─── CATEGORIES ─── */}
      <section className="py-12 max-w-7xl mx-auto uppercase px-6 md:px-12">
        <div className="flex items-center justify-start md:justify-center gap-4 mb-12 overflow-x-auto pb-8 pt-4 -mx-6 px-6 md:-mx-12 md:px-12 scrollbar-hide">
          <button
            onClick={() => handleCategorySelect(null)}
            className={`flex items-center gap-3 px-8 py-4 rounded-2xl font-black uppercase tracking-widest text-[10px] transition-all duration-300 border-2 shrink-0 h-14 ${
              !categorySlug
                ? "bg-primary border-primary text-primary-foreground shadow-lg shadow-primary/25"
                : "bg-card border-border text-muted-foreground hover:border-border hover:bg-muted"
            }`}
          >
            <span className="text-xl leading-none">✨</span>
            Tout
          </button>
          {(categories ?? []).map((cat: { _id: string; slug: string; name: string }) => (
            <button
              key={cat._id}
              onClick={() => handleCategorySelect(cat.slug)}
              className={`flex items-center gap-3 px-8 py-4 rounded-2xl font-black uppercase tracking-widest text-[10px] transition-all duration-300 border-2 shrink-0 h-14 ${
                categorySlug === cat.slug
                  ? "bg-primary border-primary text-primary-foreground shadow-lg shadow-primary/25"
                  : "bg-card border-border text-muted-foreground hover:border-border hover:bg-muted"
              }`}
            >
              {cat.name}
            </button>
          ))}
        </div>

        {/* ─── SHOWING + FILTERS + SORT ─── */}
        <div className="flex flex-col md:flex-row items-center justify-between mb-16 px-4 gap-6">
          <div>
            <h2 className="text-2xl font-black tracking-tighter text-foreground uppercase">
              Affichage : <span className="text-accent-foreground">{activeCategoryName}</span>
              {/* `aria-hidden` because the sentence below says the same thing
                  properly. A bare "(7)" read out after a heading is not an
                  answer to "how many dishes match what I just typed". */}
              <span aria-hidden="true" className="ml-2 text-muted-foreground">
                ({filteredProducts?.length ?? 0})
              </span>
            </h2>
            {/*
              How many dishes the search, the category chips and the
              availability filter just left.

              The number is rendered in the heading above and a heading is not
              a live region: a diner using a screen reader typed into the
              search box and heard nothing at all, on the one control whose
              entire purpose is to change this count. Polite and atomic, so the
              whole sentence is read once the typing stops rather than a digit
              at a time.
            */}
            <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
              {filteredProducts === undefined
                ? ""
                : `${filteredProducts.length} ${
                    filteredProducts.length === 1 ? "plat" : "plats"
                  } — ${activeCategoryName}`}
            </p>
          </div>

          <div className="flex items-center gap-4">
            {/* Filter toggle */}
            <Button
              variant="outline"
              onClick={() => setFilters((prev) => ({ availableOnly: !prev.availableOnly }))}
              className={`h-12 rounded-xl border-border bg-card font-bold text-muted-foreground gap-2 px-6 hover:bg-muted transition-all ${
                filters.availableOnly ? "border-primary bg-accent text-accent-foreground" : ""
              }`}
            >
              <SlidersHorizontal className="h-4 w-4" />
              {filters.availableOnly ? "Disponible" : "Filtres"}
              {filters.availableOnly && (
                <Badge className="ml-1 h-5 w-5 p-0 flex items-center justify-center bg-primary rounded-full text-[10px] border-none">
                  1
                </Badge>
              )}
            </Button>

            {/* Sort Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="h-12 rounded-xl border-border bg-card font-bold text-muted-foreground gap-2 px-6 hover:bg-muted transition-all"
                >
                  Trier par : <span className="text-accent-foreground font-black">{sortLabel}</span>
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="rounded-2xl p-2 min-w-[200px] shadow-2xl border-border bg-card">
                <DropdownMenuItem
                  onClick={() => updateSearchParams("sort", null)}
                  className="rounded-xl font-bold text-muted-foreground p-3 cursor-pointer hover:bg-muted"
                >
                  Recommandé
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => updateSearchParams("sort", "name")}
                  className="rounded-xl font-bold text-muted-foreground p-3 cursor-pointer hover:bg-muted"
                >
                  Nom A-Z
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => updateSearchParams("sort", "price")}
                  className="rounded-xl font-bold text-muted-foreground p-3 cursor-pointer hover:bg-muted"
                >
                  Prix croissant
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* ─── FORMULES ───
            Above the à-la-carte grid, and only when there are any. A formule is
            what an establishment wants sold: it is the higher basket and the
            thing the carte is built around at lunch.

            Hidden entirely while the query is loading and when it answers
            empty — not a skeleton, and not an empty state. « Aucune formule »
            is a message about the establishment's offering that most
            establishments would not want printed on their carte. */}
        {formules && formules.length > 0 && (
          <div className="mb-12">
            <h2 className="mb-4 text-2xl font-black tracking-tight">Nos formules</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {formules.map((formule) => (
                <FormuleCard key={formule._id} formule={formule} />
              ))}
            </div>
          </div>
        )}

        {/* ─── GRID ─── */}
        <div className="mb-8">
          <ProductGrid
            products={paginatedProducts}
            storeId={storeId}
            isStoreOpen={isOpen}
            timeZone={timeZone}
            onProductClick={setSelectedProduct}
            onAddToCart={handleQuickAdd}
          />
        </div>

        {/* ─── PAGINATION ─── */}
        <MenuPagination
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={setCurrentPage}
        />
      </section>

      {/* ─── DELIVERY APPS SECTION ───
          Rendered ONLY for the platforms this establishment is actually
          listed on, and linked to its OWN page there.

          It used to be two tiles hard-coded to `https://www.ubereats.com` and
          `https://www.deliveroo.com` — the marketplaces' home pages, not this
          restaurant — shown unconditionally under « Commandez aussi sur vos
          apps » with a COMMANDER button, whether or not the store had either
          integration. A restaurant's own site was routing its own customers
          into a marketplace to be shown the competition, and paying commission
          on anything they ordered there.

          `storeIntegrations.publicLinks` answers with the enabled integrations
          that carry a URL the owner typed; nothing else can produce a tile. */}
      {deliveryLinks && deliveryLinks.length > 0 && (
      <section className="py-24 px-6 md:px-12 max-w-7xl mx-auto mb-24">
        <div className="text-center mb-16">
          <Badge className="bg-primary/10 text-accent-foreground border-primary/20 px-4 py-1.5 rounded-full mb-6 font-black tracking-widest uppercase text-[10px]">
            Livraison
          </Badge>
          <h2 className="text-5xl md:text-7xl font-black tracking-tighter text-foreground leading-tight">
            Commandez aussi sur{" "}
            <span className="text-accent-foreground italic">vos apps</span>
          </h2>
        </div>

        <div className={`grid grid-cols-1 gap-8 ${deliveryLinks.length > 1 ? "md:grid-cols-2" : "max-w-2xl mx-auto"}`}>
          {deliveryLinks.map((link) => {
            const platform = DELIVERY_PLATFORMS[link.platform]
            return (
              <a
                key={link.platform}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                /* An order this establishment will take and this site will
                   never record: the diner leaves for the marketplace and comes
                   back as a platform order, if at all. */
                onClick={() => recordSignal("platform_link")}
                className={`group relative overflow-hidden rounded-[3rem] p-12 flex flex-col items-center text-center transition-all shadow-2xl shadow-primary/10 ${
                  link.platform === "uberEats" ? "bg-[#06C167]" : "bg-[#00CCBC]"
                } hover:-translate-y-2 duration-300`}
              >
                <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full blur-3xl -mr-32 -mt-32 group-hover:scale-150 transition-transform duration-700" />
                <div className="h-24 w-full relative mb-8 flex items-center justify-center">
                  <div className="text-black text-4xl font-black tracking-tighter uppercase italic">
                    {platform.name}
                  </div>
                </div>
                <h3 className="text-2xl font-black text-black mb-4">{platform.headline}</h3>
                <p className="text-black font-medium mb-8 max-w-xs">{platform.blurb}</p>
                <Button className="h-14 px-8 rounded-2xl bg-card border-none font-black uppercase tracking-widest text-xs shadow-xl group-hover:px-10 transition-all text-foreground">
                  Commander <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </a>
            )
          })}
        </div>
      </section>
      )}

      {/* ─── CTA SECTION ─── */}
      <section className="py-24 px-6 md:px-12 max-w-7xl mx-auto mb-24">
        <div className="relative rounded-[4rem] bg-primary p-12 md:p-24 overflow-hidden text-center md:text-left flex flex-col md:flex-row items-center justify-between gap-12">
          <div className="absolute top-0 right-0 w-96 h-96 bg-white/10 rounded-full blur-3xl -mr-48 -mt-48" />
          <div className="relative z-10 max-w-2xl">
            <Badge className="bg-primary-hover text-primary-foreground border-white/30 backdrop-blur-md px-4 py-1.5 rounded-full mb-6 font-black tracking-widest uppercase text-[10px]">
              Une question ?
            </Badge>
            <h2 className="text-4xl md:text-6xl font-black text-primary-foreground tracking-tighter leading-none mb-6 italic">
              Besoin d&apos;aide pour{" "}
              <span className="text-primary-foreground not-italic">votre commande ?</span>
            </h2>
            <p className="text-lg text-primary-foreground font-medium">
              Notre équipe est disponible pour répondre à toutes vos questions
            </p>
          </div>
          <Link href="/contact">
            <Button className="relative z-10 h-20 px-12 rounded-[2rem] bg-primary-foreground hover:text-primary-hover text-primary font-black uppercase tracking-widest text-sm shadow-2xl transition-all hover:scale-105 group">
              Contactez-nous
              <ArrowRight className="ml-3 h-5 w-5 group-hover:translate-x-2 transition-transform" />
            </Button>
          </Link>
        </div>
      </section>

      {/* ─── BLOG SECTION ─── */}
      {(latestArticles?.length ?? 0) > 0 && (
        <section className="py-24 px-6 md:px-12 max-w-7xl mx-auto bg-card rounded-[5rem] shadow-sm mb-24 border border-border">
          <div className="flex items-end justify-between mb-16 px-8">
            <div>
              <h2 className="text-5xl md:text-7xl font-black tracking-tighter text-foreground leading-[0.9] mb-6 whitespace-pre-line">
                Consultez notre{"\n"}
                <span className="text-accent-foreground italic">Blog</span>
              </h2>
              <div className="h-2 w-24 bg-primary rounded-full" />
            </div>
            <Link href="/blog">
              <Button variant="ghost" className="text-accent-foreground font-black uppercase tracking-widest text-[10px] items-center gap-2 hover:bg-accent">
                Tout voir <ChevronRight className="h-4 w-4" />
              </Button>
            </Link>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-12 px-8">
            {latestArticles?.map((post) => (
              <Link key={post._id} href={`/blog/${post.slug}`} className="group">
                <div className="bg-muted rounded-[2.5rem] overflow-hidden shadow-lg shadow-black/[0.03] border border-border hover:shadow-xl transition-all h-full flex flex-col">
                  <div className="relative aspect-[16/10] overflow-hidden bg-muted">
                    {post.coverImage?.url && (
                      <Image
                        src={post.coverImage.url}
                        alt={post.coverImage.alt ?? post.title}
                        fill
                        className="object-cover group-hover:scale-110 transition-all duration-700"
                      />
                    )}
                    <div className="absolute top-4 left-4 bg-card px-4 py-2 rounded-2xl shadow-lg border border-border">
                      <p className="text-[10px] font-black uppercase tracking-widest text-accent-foreground">
                        {formatArticleDate(post.publishedAt)}
                      </p>
                    </div>
                  </div>
                  <div className="p-8 flex-1 flex flex-col">
                    <h3 className="text-xl font-black tracking-tighter text-foreground leading-tight group-hover:text-accent-foreground transition-colors">
                      {post.title}
                    </h3>
                    <div className="mt-auto pt-6 flex items-center text-[10px] font-black uppercase tracking-widest text-accent-foreground group-hover:gap-3 gap-2 transition-all">
                      Lire la suite <ArrowRight className="h-3 w-3" />
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* ─── PRODUCT DETAIL DIALOG ─── */}
      <Dialog
        open={!!selectedProduct}
        onOpenChange={(open) => !open && setSelectedProduct(null)}
      >
        <DialogContent className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto p-0 border-none rounded-[3rem]">
          <DialogTitle className="sr-only">Détail du produit</DialogTitle>
          {selectedProduct && storeId && (
            <ProductDetailClient
              product={selectedProduct}
              storeId={storeId}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default function MenuPageContent() {
  return (
    <Suspense>
      <MenuContent />
    </Suspense>
  )
}
