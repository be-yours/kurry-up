"use client"

/**
 * Post-payment landing page.
 *
 * Every card, PayPal and SumUp checkout redirected here and got a 404: the
 * route was referenced from `checkout/page.tsx` but never written. The customer
 * had just paid and had no idea whether the order existed.
 *
 * This page finishes the transaction: it asks the provider to confirm the
 * payment, empties the cart, and hands over a tracking link.
 */

import { Suspense, useEffect, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import Link from "next/link"
import { useAction, useConvex } from "convex/react"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { CheckCircle2, Loader2, AlertTriangle } from "lucide-react"
import { Button } from "@be-yours/ui"
import { useCartStore, clearCheckoutAttempt } from "@be-yours/restaurant"
import { convexErrorMessage } from "@/lib/convex-error"

type Outcome =
  | { state: "verifying" }
  | {
      state: "paid"
      orderId?: string
      orderNumber?: string
      viewToken?: string
      email?: string
    }
  | { state: "pending"; label: string; orderId?: string; viewToken?: string }
  /** Paid, then cancelled: the money is owed back and has not been sent yet. */
  | { state: "refund_pending"; orderId?: string; viewToken?: string }
  | { state: "failed"; message: string }

/**
 * Payment statuses a *customer* may be shown, in French.
 *
 * This screen used to print the raw status token straight from the database.
 * `refund_pending` would therefore have reached a customer verbatim, in
 * English, under a sentence promising the order would be prepared. Anything
 * not named here is not shown at all: no detail beats an internal token.
 */
const CUSTOMER_PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: "en attente",
  processing: "en cours de traitement",
  failed: "échoué",
  refunded: "remboursé",
  partially_refunded: "partiellement remboursé",
  refund_pending: "remboursement en cours",
}

function CheckoutSuccessContent() {
  const params = useSearchParams()
  const clearCart = useCartStore((s) => s.clearCart)

  const orderId = params.get("orderId") ?? undefined
  // Stripe appends session_id; PayPal appends token; SumUp carries checkoutId.
  const sessionId = params.get("session_id") ?? undefined
  const paypalToken = params.get("token") ?? undefined
  const checkoutId = params.get("checkoutId") ?? undefined

  const verifyStripe = useAction(api.stripe.verifyCheckoutSession)
  const capturePayPal = useAction(api.paypal.capturePayPalOrder)
  const verifySumUp = useAction(api.sumup.verifyCheckout)
  // Read imperatively: this runs once inside the effect, not on every render.
  const convex = useConvex()

  const [outcome, setOutcome] = useState<Outcome>({ state: "verifying" })
  // Verification must run once: capturing a PayPal order twice is an error, and
  // React would otherwise re-run this on every render.
  const hasRun = useRef(false)

  useEffect(() => {
    if (hasRun.current) return
    hasRun.current = true

    async function fetchPaymentState(args: { orderId: Id<"orders"> }) {
      return convex.query(api.orders.getPaymentState, args)
    }

    async function finish() {
      try {
        if (sessionId) {
          const result = await verifyStripe({ sessionId })
          settle(result.status, result)
        } else if (paypalToken && orderId) {
          const result = await capturePayPal({
            paypalOrderId: paypalToken,
            orderId: orderId as Id<"orders">,
          })
          settle(result.status, result)
        } else if (checkoutId && orderId) {
          const result = await verifySumUp({
            checkoutId,
            orderId: orderId as Id<"orders">,
          })
          settle(result.status, result)
        } else if (orderId) {
          // No provider reference in the URL. This is NOT a cash order — cash
          // confirms on the checkout page and never lands here. It is a return
          // path that lost its reference, the SumUp 3-D Secure redirect above
          // all: the bank sends the browser straight to the redirect URL,
          // bypassing the widget callback that would have carried the checkout
          // id.
          //
          // This branch used to announce "votre paiement a bien été reçu" and
          // empty the basket, with nothing checked at all — a refused card got
          // a confirmation screen. Ask the server what actually happened.
          const state = await fetchPaymentState({
            orderId: orderId as Id<"orders">,
          })
          if (!state) {
            setOutcome({
              state: "failed",
              message: "Cette commande est introuvable.",
            })
          } else if (state.paymentStatus === "paid") {
            setOutcome({
              state: "paid",
              orderId,
              orderNumber: state.orderNumber,
            })
            clearCart()
            clearCheckoutAttempt()
          } else if (state.paymentStatus === "refund_pending") {
            // Cancelled after payment. Telling this customer their order "sera
            // préparée dès réception" would be the opposite of the truth.
            setOutcome({ state: "refund_pending", orderId })
          } else {
            setOutcome({ state: "pending", label: state.paymentStatus })
          }
        } else {
          setOutcome({
            state: "failed",
            message: "Lien de confirmation incomplet.",
          })
        }
      } catch (error) {
        // `error.message` was read here, and this screen renders it to a diner
        // who has already been charged. Convex redacts a thrown `Error` in
        // production, so what they read was "[CONVEX A(stripe:verify…)] Server
        // Error". `SettlementRejectedError` — the refusal that says the payment
        // does not settle this order — now travels as a `ConvexError`, so its
        // sentence survives; a provider fault still falls back, because there
        // is genuinely nothing to tell the customer about one.
        console.error("Payment confirmation failed", error)
        setOutcome({
          state: "failed",
          message: convexErrorMessage(
            error,
            {},
            "La confirmation du paiement a échoué. Contactez le restaurant avec votre numéro de commande."
          ),
        })
      }
    }

    function settle(
      status: string,
      result: {
        orderId?: string
        orderNumber?: string
        viewToken?: string
        email?: string
      }
    ) {
      if (status === "paid") {
        setOutcome({ state: "paid", ...result, orderId: result.orderId ?? orderId })
        // Only now: the basket must survive a failed or abandoned payment.
        clearCart()
        clearCheckoutAttempt()
      } else {
        // Carry the view token through: the pending screen offers a link to the
        // order, and without the token that link is a dead end for a guest —
        // exactly the person who just paid and has no account.
        setOutcome({
          state: "pending",
          label: status,
          orderId: result.orderId ?? orderId,
          viewToken: result.viewToken,
        })
      }
    }

    void finish()
  }, [
    sessionId,
    paypalToken,
    checkoutId,
    orderId,
    verifyStripe,
    capturePayPal,
    verifySumUp,
    clearCart,
    convex,
  ])

  if (outcome.state === "verifying") {
    return (
      <Shell>
        <Loader2 className="mx-auto mb-8 h-12 w-12 animate-spin text-muted-foreground" />
        <h1 className="mb-4 text-3xl font-black uppercase italic tracking-tighter text-foreground">
          Confirmation en cours
        </h1>
        <p className="text-lg text-muted-foreground">
          Nous vérifions votre paiement. Ne fermez pas cette page.
        </p>
      </Shell>
    )
  }

  if (outcome.state === "failed") {
    return (
      <Shell tone="danger">
        <AlertTriangle className="mx-auto mb-8 h-12 w-12 text-destructive" />
        <h1 className="mb-4 text-3xl font-black uppercase italic tracking-tighter text-foreground">
          Confirmation impossible
        </h1>
        <p className="mb-2 text-lg text-muted-foreground">{outcome.message}</p>
        <p className="mb-8 text-sm text-muted-foreground">
          Si votre compte a été débité, contactez le restaurant avec le numéro de
          commande — la commande n&apos;a pas été perdue.
        </p>
        <Actions orderId={orderId} />
      </Shell>
    )
  }

  if (outcome.state === "refund_pending") {
    return (
      <Shell>
        <Loader2 className="mx-auto mb-8 h-12 w-12 text-accent-solid" />
        <h1 className="mb-4 text-3xl font-black uppercase italic tracking-tighter text-foreground">
          Commande annulée
        </h1>
        <p className="mb-8 text-lg text-muted-foreground">
          Cette commande a été annulée. Votre remboursement est en cours de
          traitement et sera crédité sur votre moyen de paiement d&apos;origine.
        </p>
        <Actions orderId={outcome.orderId ?? orderId} viewToken={outcome.viewToken} />
      </Shell>
    )
  }

  if (outcome.state === "pending") {
    // Never print the raw token: show the French label, or no detail at all.
    const statusLabel = CUSTOMER_PAYMENT_STATUS_LABELS[outcome.label]
    return (
      <Shell>
        <Loader2 className="mx-auto mb-8 h-12 w-12 text-accent-solid" />
        <h1 className="mb-4 text-3xl font-black uppercase italic tracking-tighter text-foreground">
          Paiement en attente
        </h1>
        <p className="mb-8 text-lg text-muted-foreground">
          Votre banque n&apos;a pas encore confirmé le paiement
          {statusLabel ? ` (statut : ${statusLabel})` : ""}. La commande
          sera préparée dès réception.
        </p>
        <Actions orderId={outcome.orderId ?? orderId} viewToken={outcome.viewToken} />
      </Shell>
    )
  }

  // Only offer tracking when we hold a view token. `/order/[orderId]` without
  // one resolves to nothing for a guest, so the button would be a dead end for
  // exactly the people who need it most.
  const trackHref =
    outcome.orderId && outcome.viewToken
      ? `/order/${outcome.orderId}?token=${outcome.viewToken}`
      : undefined

  return (
    <Shell>
      <div className="mx-auto mb-8 flex h-24 w-24 items-center justify-center rounded-full bg-success text-success-foreground">
        <CheckCircle2 className="h-12 w-12" />
      </div>
      <h1 className="mb-4 text-4xl font-black uppercase italic tracking-tighter text-foreground">
        Commande <span className="not-italic text-accent-foreground">Confirmée</span>
      </h1>

      {/* The order number, or nothing: the tail of the internal id used to stand
          in for it, and it is a reference the restaurant cannot look up. */}
      {outcome.orderNumber && (
        <div className="mb-6">
          <span className="rounded-full bg-muted px-4 py-2 text-xs font-black uppercase leading-none tracking-widest text-muted-foreground">
            Commande #{outcome.orderNumber}
          </span>
        </div>
      )}

      <p className="mb-8 text-lg leading-relaxed text-muted-foreground">
        Votre paiement a bien été reçu.
        {outcome.email && (
          <>
            {" "}
            Une confirmation part à{" "}
            <span className="font-bold text-foreground">{outcome.email}</span>.
          </>
        )}
      </p>

      <div className="flex flex-col justify-center gap-4 sm:flex-row">
        {trackHref && (
          <Link href={trackHref}>
            <Button className="h-14 rounded-2xl bg-primary px-8 font-black uppercase tracking-widest text-primary-foreground transition-all hover:bg-primary-hover">
              Suivre ma commande
            </Button>
          </Link>
        )}
        <Link href="/menu">
          <Button
            variant={trackHref ? "outline" : "default"}
            className={
              trackHref
                ? "h-14 rounded-2xl border-border px-8 font-black uppercase tracking-widest transition-all"
                : "h-14 rounded-2xl bg-primary px-8 font-black uppercase tracking-widest text-primary-foreground transition-all hover:bg-primary-hover"
            }
          >
            Retour au menu
          </Button>
        </Link>
      </div>

      {trackHref && (
        <p className="mt-6 text-xs text-muted-foreground">
          Gardez ce lien : c&apos;est le seul moyen de retrouver cette commande
          sans compte.
        </p>
      )}
    </Shell>
  )
}

function Actions({
  orderId,
  viewToken,
}: {
  orderId?: string
  viewToken?: string
}) {
  // `/order/[orderId]` answers the customer who placed the order or the holder
  // of the view token, and nobody else. Offering the link without a token sent
  // a guest to an empty page; better no button than a broken one.
  const href =
    orderId && viewToken ? `/order/${orderId}?token=${viewToken}` : undefined

  return (
    <div className="flex flex-col justify-center gap-4 sm:flex-row">
      {href && (
        <Link href={href}>
          <Button className="h-14 rounded-2xl bg-primary px-8 font-black uppercase tracking-widest text-primary-foreground transition-all hover:bg-primary-hover">
            Voir la commande
          </Button>
        </Link>
      )}
      <Link href="/cart">
        <Button
          variant="outline"
          className="h-14 rounded-2xl border-border px-8 font-black uppercase tracking-widest transition-all"
        >
          Retour au panier
        </Button>
      </Link>
    </div>
  )
}

function Shell({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode
  tone?: "neutral" | "danger"
}) {
  return (
    <div
      className={`min-h-screen px-4 pb-20 pt-32 ${
        tone === "danger" ? "bg-destructive/5" : "bg-muted"
      }`}
    >
      <div className="mx-auto max-w-xl text-center">{children}</div>
    </div>
  )
}

export default function CheckoutSuccessPage() {
  return (
    <Suspense
      fallback={
        <Shell>
          <Loader2 className="mx-auto h-12 w-12 animate-spin text-muted-foreground" />
        </Shell>
      }
    >
      <CheckoutSuccessContent />
    </Suspense>
  )
}
