"use client"

import { useEffect } from "react"
import Image from "next/image"
import { useRouter } from "next/navigation"
import Link from "next/link"
import {
  ShoppingBag,
  Trash2,
  ArrowRight,
  ArrowLeft,
  Minus,
  Plus,
  X,
} from "lucide-react"
import {
  Button,
  Separator,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@be-yours/ui"
import {
  formatPrice,
  useCartHydrated,
  useCartStore,
} from "@be-yours/restaurant"
import type { OrderType } from "@be-yours/restaurant"
import { useStoreId } from "@/lib/hooks/use-store-id"
import { useStoreStatus } from "@/lib/hooks/use-store-status"
import { OrderTypeSelector } from "@/components/storefront/order-type-selector"
import { isOrderTypeOffered, ORDER_TYPES } from "@be-yours/convex-schema"

export default function CartContent() {
  const router = useRouter()
  const { storeId } = useStoreId()
  const { isOpen, services } = useStoreStatus(storeId)

  const cartHydrated = useCartHydrated()
  const items = useCartStore((s) => s.items)
  const orderType = useCartStore((s) => s.orderType)
  const updateQuantity = useCartStore((s) => s.updateQuantity)
  const removeItem = useCartStore((s) => s.removeItem)
  const clearCart = useCartStore((s) => s.clearCart)
  const setOrderType = useCartStore((s) => s.setOrderType)
  const getSubtotal = useCartStore((s) => s.getSubtotal)
  const getItemCount = useCartStore((s) => s.getItemCount)

  const subtotal = getSubtotal()
  const itemCount = getItemCount()

  // The cart's order type is persisted, so it outlives the owner switching a
  // service off: a basket built when the restaurant delivered still said
  // "delivery" the next day, and `orders.create` now refuses it. Move the
  // selection to something the restaurant actually offers rather than let the
  // customer reach checkout and be turned away there.
  useEffect(() => {
    if (!services || isOrderTypeOffered(orderType, services)) return
    const fallback = ORDER_TYPES.find((type) => isOrderTypeOffered(type, services))
    if (fallback) setOrderType(fallback)
  }, [services, orderType, setOrderType])

  // The persisted basket is not there on the first paint — zustand reads
  // localStorage after mount, and React serves the server snapshot (an empty
  // cart) for the whole hydration render. Without this, a customer who reloads
  // this page or arrives from a bookmark is shown a full-screen "Votre Box est
  // vide" over a basket that is about to appear. It self-corrects, but it is
  // the dead-end screen, and `/checkout` has read the same flag since #169.
  if (!cartHydrated) return null

  if (items.length === 0) {
    return (
      <div className="min-h-screen bg-background">
        {/* Empty hero */}
        <div className="bg-primary pb-24 pt-32 text-center md:rounded-b-[6rem] md:pb-32">
          <div className="flex justify-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-[1.5rem] bg-white/20 backdrop-blur-md">
              <ShoppingBag className="h-10 w-10 text-primary-foreground" />
            </div>
          </div>
          <h1 className="mt-6 text-4xl font-black uppercase italic tracking-tighter text-primary-foreground md:text-6xl">
            Votre Box
          </h1>
          <p className="mt-3 text-sm font-medium text-primary-foreground">
            Votre Box est vide. Parcourez notre menu pour ajouter vos plats
            préférés.
          </p>
          <Link href="/menu" className="mt-8 inline-block">
            <Button
              size="lg"
              className="h-14 rounded-2xl bg-card px-8 text-xs font-black uppercase tracking-widest text-accent-foreground shadow-xl shadow-black/10 hover:bg-muted"
            >
              Parcourir le menu
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Hero header */}
      <div className="bg-primary pb-20 pt-28 md:rounded-b-[6rem] md:pb-28">
        <div className="container mx-auto px-4">
          <div className="flex flex-col items-center text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/20 backdrop-blur-md">
              <ShoppingBag className="h-7 w-7 text-primary-foreground" />
            </div>
            <h1 className="mt-4 text-4xl font-black uppercase italic tracking-tighter text-primary-foreground md:text-6xl">
              Votre Box
            </h1>
            <p className="mt-2 text-[10px] font-bold uppercase tracking-widest text-primary-foreground">
              {itemCount}{" "}
              {itemCount > 1
                ? "articles sélectionnés"
                : "article sélectionné"}
            </p>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="container mx-auto -mt-12 px-4 pb-16 md:-mt-16">
        <div className="grid gap-8 lg:grid-cols-3">
          {/* Items list */}
          <div className="lg:col-span-2">
            {/* Clear cart bar */}
            <div className="mb-6 flex items-center justify-between rounded-[2rem] border border-border bg-card p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <Link
                  href="/menu"
                  className="flex h-10 w-10 items-center justify-center rounded-xl border border-border text-muted-foreground transition-colors hover:border-border hover:text-muted-foreground"
                >
                  <ArrowLeft className="h-4 w-4" />
                </Link>
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Continuer mes achats
                </span>
              </div>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground hover:bg-destructive/5 hover:text-destructive"
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    Tout vider
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent className="rounded-[2rem] border-none p-10">
                  <AlertDialogHeader>
                    <AlertDialogTitle className="text-3xl font-black uppercase italic tracking-tighter text-foreground">
                      Vider votre Box ?
                    </AlertDialogTitle>
                    <AlertDialogDescription className="text-lg font-medium text-muted-foreground">
                      Cela supprimera tous les articles de votre Box.
                      Êtes-vous sûr de vouloir recommencer ?
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter className="mt-8 gap-4">
                    <AlertDialogCancel className="h-14 rounded-2xl text-xs font-black uppercase tracking-widest border-border hover:bg-muted">
                      Annuler
                    </AlertDialogCancel>
                    <AlertDialogAction
                      onClick={clearCart}
                      className="h-14 rounded-2xl bg-destructive text-xs font-black uppercase tracking-widest text-destructive-foreground shadow-xl shadow-destructive/20 hover:bg-destructive/90"
                    >
                      Oui, tout vider
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>

            {/* Items */}
            <div className="space-y-4">
              {/* The page h1 is the cart title and each line is an h3, so
                  without this the outline jumps h1 -> h3. It is a real section
                  heading, not a spacer: it names the list a screen reader is
                  about to walk. `sr-only` keeps it off the visual design. */}
              <h2 className="sr-only">Articles dans votre panier</h2>
              <TooltipProvider delayDuration={300}>
                {items.map((item) => {
                  const optionsTotal = item.options.reduce(
                    (s, o) => s + o.priceModifier,
                    0
                  )
                  const unitPrice = item.price + optionsTotal
                  const lineTotal = unitPrice * item.quantity
                  // Two lines of one dish differ only by their options, so the
                  // options are what an icon-only button has to say out loud.
                  const lineLabel = item.options.length
                    ? `${item.name} (${item.options.map((o) => o.choice).join(", ")})`
                    : item.name

                  return (
                    <div
                      key={item.lineId}
                      data-line-id={item.lineId}
                      className="group flex gap-4 rounded-[2rem] border border-border bg-card p-5 shadow-sm transition-shadow hover:shadow-lg hover:shadow-muted/50 md:gap-6 md:p-6"
                    >
                      {/* Image */}
                      <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-2xl border border-border bg-muted md:h-28 md:w-28">
                        {item.imageUrl ? (
                          <Image
                            src={item.imageUrl}
                            alt={item.name}
                            fill
                            sizes="(min-width: 768px) 112px, 96px"
                            className="object-cover transition-transform duration-500 group-hover:scale-110"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center">
                            <ShoppingBag className="h-8 w-8 text-muted-foreground" />
                          </div>
                        )}
                      </div>

                      {/* Content */}
                      <div className="flex flex-1 flex-col justify-between py-0.5">
                        <div>
                          <div className="flex items-start justify-between">
                            <h3 className="text-sm font-black uppercase leading-tight tracking-tight text-foreground md:text-base">
                              {item.name}
                            </h3>

                            {/* Remove item */}
                            <AlertDialog>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <AlertDialogTrigger asChild>
                                    <button
                                      type="button"
                                      aria-label={`Retirer ${item.name} de la Box`}
                                      className="p-1 text-muted-foreground transition-colors hover:text-destructive"
                                    >
                                      <X className="h-4 w-4" />
                                    </button>
                                  </AlertDialogTrigger>
                                </TooltipTrigger>
                                <TooltipContent className="rounded-xl border-none bg-destructive px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-destructive-foreground">
                                  Retirer de la Box
                                </TooltipContent>
                              </Tooltip>
                              <AlertDialogContent className="rounded-[2rem] border-none p-10">
                                <AlertDialogHeader>
                                  <AlertDialogTitle className="text-3xl font-black uppercase italic tracking-tighter text-foreground">
                                    Retirer l&apos;article ?
                                  </AlertDialogTitle>
                                  <AlertDialogDescription className="text-lg font-medium text-muted-foreground">
                                    Êtes-vous sûr de vouloir retirer{" "}
                                    <span className="font-bold text-foreground">
                                      {item.name}
                                    </span>{" "}
                                    de votre Box ?
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter className="mt-8 gap-4">
                                  <AlertDialogCancel className="h-14 rounded-2xl text-xs font-black uppercase tracking-widest border-border hover:bg-muted">
                                    Le garder
                                  </AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() =>
                                      removeItem(item.lineId)
                                    }
                                    className="h-14 rounded-2xl bg-destructive text-xs font-black uppercase tracking-widest text-destructive-foreground shadow-xl shadow-destructive/20 hover:bg-destructive/90"
                                  >
                                    Retirer maintenant
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>

                          {/* Unit price */}
                          <p className="text-sm font-black text-accent-foreground">
                            {formatPrice(unitPrice)}
                          </p>

                          {/* Options as badges */}
                          {item.options.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {item.options.map((opt, i) => (
                                <span
                                  key={i}
                                  className="rounded-md bg-accent px-1.5 py-0.5 text-[9px] font-black uppercase text-accent-foreground"
                                >
                                  + {opt.name}: {opt.choice}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Quantity controls + line total */}
                        <div className="mt-3 flex items-center justify-between">
                          <div className="flex items-center rounded-lg border border-border bg-muted p-1">
                            {item.quantity === 1 ? (
                              <AlertDialog>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <AlertDialogTrigger asChild>
                                      <button
                                        aria-label={`Retirer ${lineLabel}`}
                                        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-all hover:bg-card hover:text-destructive hover:shadow-sm"
                                      >
                                        <Minus className="h-3 w-3" />
                                      </button>
                                    </AlertDialogTrigger>
                                  </TooltipTrigger>
                                  <TooltipContent className="rounded-xl border-none bg-muted-foreground px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-background">
                                    Retirer
                                  </TooltipContent>
                                </Tooltip>
                                <AlertDialogContent className="rounded-[2rem] border-none p-10">
                                  <AlertDialogHeader>
                                    <AlertDialogTitle className="text-3xl font-black uppercase italic tracking-tighter text-foreground">
                                      Retirer l&apos;article ?
                                    </AlertDialogTitle>
                                    <AlertDialogDescription className="text-lg font-medium text-muted-foreground">
                                      Êtes-vous sûr de vouloir retirer{" "}
                                      <span className="font-bold text-foreground">
                                        {item.name}
                                      </span>{" "}
                                      de votre Box ?
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter className="mt-8 gap-4">
                                    <AlertDialogCancel className="h-14 rounded-2xl text-xs font-black uppercase tracking-widest border-border hover:bg-muted">
                                      Le garder
                                    </AlertDialogCancel>
                                    <AlertDialogAction
                                      onClick={() =>
                                        updateQuantity(item.lineId, 0)
                                      }
                                      className="h-14 rounded-2xl bg-destructive text-xs font-black uppercase tracking-widest text-destructive-foreground shadow-xl shadow-destructive/20 hover:bg-destructive/90"
                                    >
                                      Retirer maintenant
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            ) : (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    onClick={() =>
                                      updateQuantity(
                                        item.lineId,
                                        item.quantity - 1
                                      )
                                    }
                                    aria-label={`Diminuer la quantité de ${lineLabel}`}
                                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-all hover:bg-card hover:text-muted-foreground hover:shadow-sm"
                                  >
                                    <Minus className="h-3 w-3" />
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent className="rounded-xl border-none bg-muted-foreground px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-background">
                                  Diminuer
                                </TooltipContent>
                              </Tooltip>
                            )}

                            <span className="w-10 text-center text-xs font-black text-foreground">
                              {item.quantity}
                            </span>

                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  onClick={() =>
                                    updateQuantity(
                                      item.lineId,
                                      item.quantity + 1
                                    )
                                  }
                                  aria-label={`Augmenter la quantité de ${lineLabel}`}
                                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-all hover:bg-card hover:text-muted-foreground hover:shadow-sm"
                                >
                                  <Plus className="h-3 w-3" />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent className="rounded-xl border-none bg-muted-foreground px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-background">
                                Augmenter
                              </TooltipContent>
                            </Tooltip>
                          </div>

                          {/* Line total */}
                          <span className="text-xs font-black uppercase tracking-widest text-muted-foreground">
                            {formatPrice(lineTotal)}
                          </span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </TooltipProvider>
            </div>
          </div>

          {/* Summary sidebar */}
          <div className="lg:sticky lg:top-24 lg:self-start">
            <div className="rounded-[2rem] border border-border bg-card p-8 shadow-sm">
              {/* Header */}
              <div className="mb-6 flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
                  <ShoppingBag className="h-6 w-6 text-accent-foreground" />
                </div>
                <div>
                  <h2 className="text-xl font-black uppercase italic tracking-tighter text-foreground">
                    Résumé
                  </h2>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    {itemCount} article{itemCount > 1 ? "s" : ""}
                  </p>
                </div>
              </div>

              {/* Order type */}
              <div>
                <h3 className="mb-2.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Type de commande
                </h3>
                <OrderTypeSelector
                  value={orderType}
                  onChange={(type) => setOrderType(type as OrderType)}
                  services={services}
                />
              </div>

              <Separator className="my-6" />

              {/* Totals */}
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs font-bold uppercase tracking-widest text-muted-foreground">
                  <span>Sous-total</span>
                  <span>{formatPrice(subtotal)}</span>
                </div>
                <div className="flex items-center justify-between text-xs font-bold uppercase tracking-widest text-muted-foreground">
                  <span>Livraison</span>
                  {orderType === "delivery" ? (
                    <span>Au checkout</span>
                  ) : (
                    <span className="font-black text-accent-foreground">GRATUIT</span>
                  )}
                </div>
                <div className="flex items-center justify-between text-xs font-bold uppercase tracking-widest text-muted-foreground">
                  <span>Taxes</span>
                  <span>Au checkout</span>
                </div>
              </div>

              <Separator className="my-6" />

              {/* Total */}
              <div className="flex items-center justify-between">
                <span className="text-xl font-black uppercase tracking-tighter text-foreground">
                  Total estimé
                </span>
                <span className="text-2xl font-black tracking-tighter text-accent-foreground">
                  {formatPrice(subtotal)}
                </span>
              </div>

              {/* Checkout button */}
              <Button
                className="group mt-6 h-16 w-full rounded-2xl bg-primary text-sm font-black uppercase tracking-widest text-primary-foreground shadow-xl shadow-primary/10 hover:bg-primary-hover"
                size="lg"
                onClick={() => router.push("/checkout")}
                disabled={!isOpen}
              >
                {isOpen ? (
                  <>
                    Commander maintenant
                    <ArrowRight className="ml-2 h-5 w-5 transition-transform group-hover:translate-x-1" />
                  </>
                ) : (
                  "Restaurant fermé"
                )}
              </Button>

              {/* Continue shopping link */}
              <Link
                href="/menu"
                className="mt-5 flex items-center justify-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground transition-colors hover:text-accent-foreground"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Continuer mes achats
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
