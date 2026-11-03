"use client"

/**
 * SumUp card widget host.
 *
 * `checkout/page.tsx` redirects here after creating a SumUp checkout, and the
 * route did not exist — which made the SumUp payment path unusable end to end,
 * not merely broken at the end.
 *
 * NOTE: SumUp is not configured on this deployment, so this page has been
 * written against the published widget contract but not exercised against a
 * live account. The provider integrations are due a dedicated review pass.
 */

import { Suspense, useEffect, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import Link from "next/link"
import { AlertTriangle, Loader2 } from "lucide-react"
import { Button } from "@be-yours/ui"

const SUMUP_SDK_URL = "https://gateway.sumup.com/gateway/ecom/card/v2/sdk.js"

declare global {
  interface Window {
    SumUpCard?: {
      mount: (options: {
        id: string
        checkoutId: string
        onResponse: (type: string, body: unknown) => void
      }) => void
    }
  }
}

function loadSumUpSdk(): Promise<void> {
  if (window.SumUpCard) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SUMUP_SDK_URL}"]`
    )
    if (existing) {
      existing.addEventListener("load", () => resolve())
      existing.addEventListener("error", () =>
        reject(new Error("Le module de paiement SumUp n'a pas pu être chargé."))
      )
      return
    }

    const script = document.createElement("script")
    script.src = SUMUP_SDK_URL
    script.async = true
    script.onload = () => resolve()
    script.onerror = () =>
      reject(new Error("Le module de paiement SumUp n'a pas pu être chargé."))
    document.head.appendChild(script)
  })
}

function CheckoutPayContent() {
  const params = useSearchParams()
  const orderId = params.get("orderId") ?? undefined
  const checkoutId = params.get("checkoutId") ?? undefined

  const [sdkError, setSdkError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const mounted = useRef(false)

  // An incomplete link is knowable at render time — deriving it here rather
  // than setting state from the effect avoids a cascading render.
  const linkIncomplete = !orderId || !checkoutId
  const error = linkIncomplete ? "Lien de paiement incomplet." : sdkError

  useEffect(() => {
    if (mounted.current || linkIncomplete) return
    mounted.current = true

    loadSumUpSdk()
      .then(() => {
        if (!window.SumUpCard) {
          throw new Error("Le module de paiement SumUp est indisponible.")
        }

        window.SumUpCard.mount({
          id: "sumup-card",
          checkoutId,
          onResponse: (type) => {
            // The widget reports the outcome; the server re-checks it on the
            // success page before anything is marked paid. The widget's word
            // alone is never enough.
            if (type === "success" || type === "sent") {
              window.location.href = `/checkout/success?orderId=${orderId}&checkoutId=${checkoutId}`
            } else if (type === "error") {
              setSdkError(
                "Le paiement a été refusé. Aucun montant n'a été débité."
              )
            }
          },
        })
        setReady(true)
      })
      .catch((e: unknown) => {
        setSdkError(
          e instanceof Error ? e.message : "Le paiement n'a pas pu démarrer."
        )
      })
  }, [orderId, checkoutId, linkIncomplete])

  if (error) {
    return (
      <div className="min-h-screen bg-muted px-4 pb-20 pt-32">
        <div className="mx-auto max-w-xl text-center">
          <AlertTriangle className="mx-auto mb-8 h-12 w-12 text-destructive" />
          <h1 className="mb-4 text-3xl font-black uppercase italic tracking-tighter text-foreground">
            Paiement indisponible
          </h1>
          <p className="mb-8 text-lg text-muted-foreground">{error}</p>
          <div className="flex flex-col justify-center gap-4 sm:flex-row">
            <Link href="/checkout">
              <Button className="h-14 rounded-2xl bg-primary px-8 font-black uppercase tracking-widest text-primary-foreground transition-all hover:bg-primary-hover">
                Choisir un autre moyen
              </Button>
            </Link>
            <Link href="/cart">
              <Button
                variant="outline"
                className="h-14 rounded-2xl border-border px-8 font-black uppercase tracking-widest transition-all"
              >
                Revoir mon panier
              </Button>
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-muted px-4 pb-20 pt-32">
      <div className="mx-auto max-w-xl">
        <h1 className="mb-2 text-center text-3xl font-black uppercase italic tracking-tighter text-foreground">
          Paiement <span className="not-italic text-accent-foreground">sécurisé</span>
        </h1>
        <p className="mb-8 text-center text-sm text-muted-foreground">
          Réglez par carte pour finaliser votre commande.
        </p>

        {!ready && (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        )}

        <div
          id="sumup-card"
          className="rounded-2xl bg-card p-6 shadow-sm"
          aria-live="polite"
        />

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Ne fermez pas cette page pendant le traitement.
        </p>
      </div>
    </div>
  )
}

export default function CheckoutPayPage() {
  return (
    <Suspense fallback={null}>
      <CheckoutPayContent />
    </Suspense>
  )
}
