"use client"

import { Suspense } from "react"
import { useParams, useSearchParams } from "next/navigation"
import Link from "next/link"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { CheckCircle, Package, ArrowLeft, ExternalLink, Loader2 } from "lucide-react"
import { Badge, Separator, Skeleton, OrderStatusBadge } from "@be-yours/ui"
import { formatPrice, useOrderStatusLabels } from "@be-yours/restaurant"

function OrderConfirmationContent() {
  const { orderId } = useParams<{ orderId: string }>()
  const searchParams = useSearchParams()
  const viewToken = searchParams.get("token") ?? undefined

  // The eight status words, in the language this page is being read in. They
  // used to be a private map here AND eight hardcoded English labels inside
  // `OrderStatusBadge`, so the same order read « Preparing » on the badge and
  // « En préparation » two lines below it, and neither followed the language
  // the diner had chosen. One vocabulary now, translated once.
  const statusLabels = useOrderStatusLabels()

  const order = useQuery(api.orders.getById, {
    id: orderId as Id<"orders">,
    viewToken,
  })

  // The tracking token used to come from `kitchenTickets.getByOrder`, which is
  // guarded by `kitchen:read` — so a guest was refused and the "Suivre ma
  // commande" button never appeared for the only people who needed it. It now
  // comes from the order's own read path, under the same rule as the order
  // itself: the view token, or the customer who placed it.
  const trackingToken = useQuery(
    api.orders.getTrackingToken,
    orderId ? { orderId: orderId as Id<"orders">, viewToken } : "skip"
  ) ?? undefined

  // Loading
  if (order === undefined) {
    return (
      <div className="min-h-screen bg-background pt-20">
        <section className="pt-24 pb-20 px-6 md:px-12 bg-primary rounded-b-[4rem] md:rounded-b-[8rem]">
          <div className="max-w-7xl mx-auto text-center">
            <Skeleton className="h-10 w-48 mx-auto mb-4 rounded-xl" />
            <Skeleton className="h-6 w-64 mx-auto rounded-lg" />
          </div>
        </section>
        <div className="max-w-4xl mx-auto px-6 md:px-12 py-12">
          <div className="flex justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-accent-foreground" />
          </div>
        </div>
      </div>
    )
  }

  // Not found
  if (order === null) {
    return (
      <div className="min-h-screen bg-background pt-20">
        <section className="pt-24 pb-20 px-6 md:px-12 bg-primary rounded-b-[4rem] md:rounded-b-[8rem]">
          <div className="max-w-7xl mx-auto text-center">
            <h1 className="text-6xl md:text-8xl font-black text-primary-foreground tracking-tighter leading-none italic">
              Commande <span className="text-primary-foreground not-italic">introuvable</span>
            </h1>
          </div>
        </section>
        <div className="max-w-4xl mx-auto px-6 md:px-12 py-12 text-center">
          <Package className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
          <p className="text-muted-foreground mb-6">
            Cette commande n&apos;existe pas ou vous n&apos;avez pas accès.
          </p>
          <Link
            href="/menu"
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-8 py-3 font-black uppercase tracking-widest text-primary-foreground text-xs hover:bg-primary-hover transition-colors"
          >
            Retour au menu
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background text-foreground font-sans overflow-x-hidden pt-20 transition-colors duration-500">
      {/* Hero */}
      <section className="pt-24 pb-20 px-6 md:px-12 bg-primary relative overflow-hidden rounded-b-[4rem] md:rounded-b-[8rem]">
        <div className="absolute top-0 right-0 w-full h-full opacity-10 pointer-events-none">
          <div className="absolute top-1/4 right-1/4 w-96 h-96 bg-white/20 rounded-full blur-[100px]" />
          <div className="absolute bottom-0 left-0 w-[800px] h-[800px] bg-primary/10 rounded-full blur-[120px]" />
        </div>

        <div className="max-w-7xl mx-auto relative z-10 text-center">
          <Link
            href="/menu"
            className="mb-6 inline-flex items-center gap-1.5 text-sm text-primary-foreground transition-colors hover:underline hover:underline-offset-4 font-medium"
          >
            <ArrowLeft className="h-4 w-4" />
            Retour au menu
          </Link>

          <div className="flex justify-center mb-8">
            <div className="rounded-full bg-white/20 backdrop-blur-md p-4">
              <CheckCircle className="h-10 w-10 text-primary-foreground" />
            </div>
          </div>

          <h1 className="text-5xl md:text-7xl font-black text-primary-foreground tracking-tighter leading-none mb-6 italic">
            Commande <span className="text-primary-foreground not-italic">confirmée</span>
          </h1>
          <p className="text-xl text-primary-foreground max-w-2xl mx-auto font-medium">
            <span className="font-mono font-bold text-primary-foreground">{order.orderNumber}</span>
          </p>
        </div>
      </section>

      <div className="max-w-4xl mx-auto px-6 md:px-12 py-12">
        {/* Tracking CTA */}
        {trackingToken && (
          <Link
            href={`/track/${trackingToken}`}
            className="mb-8 flex items-center justify-between rounded-[2rem] bg-primary p-6 text-primary-foreground shadow-xl shadow-primary/10 hover:bg-primary-hover transition-all group"
          >
            <div>
              <p className="font-black uppercase tracking-widest text-[10px] text-primary-foreground mb-1">
                Suivi en temps réel
              </p>
              <p className="text-lg font-black">
                Suivre ma commande
              </p>
            </div>
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10 group-hover:bg-white/20 transition-colors">
              <ExternalLink className="h-5 w-5" />
            </div>
          </Link>
        )}

        <div className="grid gap-8 lg:grid-cols-2">
          {/* Order details */}
          <div className="rounded-[2rem] bg-card border border-border shadow-2xl shadow-black/[0.04] p-8">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-black uppercase tracking-tighter">Détails</h2>
              <OrderStatusBadge status={order.status} labels={statusLabels} />
            </div>

            <div className="space-y-4 text-sm">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground font-bold uppercase tracking-widest text-[10px]">Type</span>
                <Badge className="bg-muted text-muted-foreground border-none font-black text-[10px] uppercase">
                  {order.type === "delivery"
                    ? "Livraison"
                    : order.type === "pickup"
                      ? "À emporter"
                      : "Sur place"}
                </Badge>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground font-bold uppercase tracking-widest text-[10px]">Statut</span>
                <span className="font-bold text-foreground">{statusLabels[order.status] ?? order.status}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground font-bold uppercase tracking-widest text-[10px]">Client</span>
                <span className="font-bold text-foreground">{order.customerInfo.name}</span>
              </div>
              {order.customerInfo.email && (
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground font-bold uppercase tracking-widest text-[10px]">Email</span>
                  <span className="font-medium text-muted-foreground">{order.customerInfo.email}</span>
                </div>
              )}
              {order.deliveryAddress && (
                <div className="flex justify-between items-start">
                  <span className="text-muted-foreground font-bold uppercase tracking-widest text-[10px]">Adresse</span>
                  <span className="text-right font-medium text-muted-foreground">
                    {order.deliveryAddress.street}, {order.deliveryAddress.postalCode}{" "}
                    {order.deliveryAddress.city}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Items + totals */}
          <div className="rounded-[2rem] bg-card border border-border shadow-2xl shadow-black/[0.04] p-8">
            <h2 className="text-lg font-black uppercase tracking-tighter mb-6">Articles</h2>

            <div className="space-y-4">
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- order items from Convex */}
              {order.items.map((item: any, i: number) => (
                <div key={i} className="flex justify-between text-sm">
                  <div>
                    <span className="font-bold text-foreground">{item.productName}</span>
                    <span className="text-muted-foreground font-bold ml-2">x{item.quantity}</span>
                    {item.selectedOptions?.length > 0 && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {item.selectedOptions
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          .map((o: any) => o.choiceName ?? o.optionName)
                          .join(", ")}
                      </p>
                    )}
                  </div>
                  <span className="font-black text-foreground">{formatPrice(item.subtotal)}</span>
                </div>
              ))}
            </div>

            <Separator className="my-6 bg-muted" />

            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground font-bold uppercase tracking-widest text-[10px]">Sous-total</span>
                <span className="font-bold text-muted-foreground">{formatPrice(order.subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground font-bold uppercase tracking-widest text-[10px]">dont TVA</span>
                <span className="font-bold text-muted-foreground">{formatPrice(order.taxAmount)}</span>
              </div>
              {order.deliveryFee !== undefined && order.deliveryFee > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground font-bold uppercase tracking-widest text-[10px]">Livraison</span>
                  <span className="font-bold text-muted-foreground">{formatPrice(order.deliveryFee)}</span>
                </div>
              )}
              {/* Without this line the receipt does not add up: the discount was
                  stored on the order and shown nowhere. */}
              {order.discountAmount !== undefined && order.discountAmount > 0 && (
                <div className="flex justify-between">
                  <span className="text-success font-bold uppercase tracking-widest text-[10px]">Réduction</span>
                  <span className="font-bold text-success">-{formatPrice(order.discountAmount)}</span>
                </div>
              )}
            </div>

            <Separator className="my-6 bg-muted" />

            <div className="flex justify-between items-center">
              <span className="font-black uppercase tracking-tighter text-lg">Total</span>
              <span className="text-2xl font-black text-accent-foreground">{formatPrice(order.total)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function OrderConfirmationScreen() {
  return (
    <Suspense>
      <OrderConfirmationContent />
    </Suspense>
  )
}
