"use client"

/**
 * Public order tracking by opaque token.
 *
 * `order/[orderId]/page.tsx` links here ("Suivre ma commande") and the route did
 * not exist — every one of those links was a 404.
 *
 * The token is the whole authorisation: `kitchenTickets.getByTrackingToken`
 * returns preparation state and store branding only, never customer details, so
 * a shared link leaks nothing about the person who ordered.
 */

import { useParams } from "next/navigation"
import Link from "next/link"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import { CheckCircle2, ChefHat, Clock, PackageCheck, XCircle } from "lucide-react"
import { Skeleton, Button } from "@be-yours/ui"
import { formatStoreAddress } from "@be-yours/restaurant"

const STEPS = [
  { key: "pending", label: "Reçue", icon: Clock },
  { key: "in_progress", label: "En préparation", icon: ChefHat },
  { key: "ready", label: "Prête", icon: PackageCheck },
  { key: "completed", label: "Terminée", icon: CheckCircle2 },
] as const

function stepIndex(status: string) {
  const index = STEPS.findIndex((s) => s.key === status)
  return index === -1 ? 0 : index
}

function formatTime(timestamp?: number) {
  if (!timestamp) return null
  return new Date(timestamp).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  })
}

export default function TrackOrderContent() {
  const { token } = useParams<{ token: string }>()
  const ticket = useQuery(api.kitchenTickets.getByTrackingToken, { token })

  // `storeBranding.address` is the store document's `address` object, passed
  // through unflattened by `kitchenTickets.getByTrackingToken`. Rendering it
  // as a child threw "Objects are not valid as a React child" and took down
  // the page a customer opens right after paying. The `&&` guard never
  // helped: an object is always truthy. Formatting first gives a value that
  // is genuinely empty when there is nothing to show.
  const storeAddress = ticket?.storeBranding?.address
    ? formatStoreAddress(ticket.storeBranding.address)
    : null

  if (ticket === undefined) {
    return (
      <Wrapper>
        <Skeleton className="mx-auto mb-4 h-10 w-64" />
        <Skeleton className="mx-auto mb-8 h-5 w-40" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </Wrapper>
    )
  }

  if (ticket === null) {
    return (
      <Wrapper>
        <XCircle className="mx-auto mb-8 h-12 w-12 text-muted-foreground" />
        <h1 className="mb-4 text-3xl font-black uppercase italic tracking-tighter text-foreground">
          Commande introuvable
        </h1>
        <p className="mb-8 text-lg text-muted-foreground">
          Ce lien de suivi n&apos;est plus valide.
        </p>
        <Link href="/menu">
          <Button className="h-14 rounded-2xl bg-primary px-8 font-black uppercase tracking-widest text-primary-foreground transition-all hover:bg-primary-hover">
            Retour au menu
          </Button>
        </Link>
      </Wrapper>
    )
  }

  const cancelled = ticket.status === "cancelled"
  const current = stepIndex(ticket.status)

  return (
    <Wrapper>
      {ticket.storeBranding?.name && (
        <p className="mb-2 text-xs font-black uppercase tracking-widest text-muted-foreground">
          {ticket.storeBranding.name}
        </p>
      )}

      <h1 className="mb-2 text-4xl font-black uppercase italic tracking-tighter text-foreground">
        Commande{" "}
        <span className="not-italic text-accent-foreground">
          #{ticket.orderNumber}
        </span>
      </h1>

      <p className="mb-10 text-lg text-muted-foreground">
        {cancelled
          ? "Cette commande a été annulée."
          : ticket.status === "ready"
            ? ticket.orderType === "delivery"
              ? "Votre commande part en livraison."
              : "Votre commande vous attend."
            : "Suivi en temps réel de votre commande."}
      </p>

      {cancelled ? (
        <div className="rounded-2xl bg-destructive/5 p-8 text-center">
          <XCircle className="mx-auto mb-4 h-10 w-10 text-destructive" />
          <p className="font-bold text-foreground">Commande annulée</p>
        </div>
      ) : (
        <ol className="space-y-3 text-left">
          {STEPS.map((step, index) => {
            const Icon = step.icon
            const done = index < current
            const active = index === current
            const stamp =
              step.key === "in_progress"
                ? formatTime(ticket.startedAt)
                : step.key === "ready"
                  ? formatTime(ticket.readyAt)
                  : step.key === "completed"
                    ? formatTime(ticket.completedAt)
                    : formatTime(ticket.createdAt)

            return (
              <li
                key={step.key}
                className={`flex items-center gap-4 rounded-2xl p-4 transition-colors ${
                  active
                    ? "bg-accent ring-1 ring-primary"
                    : done
                      ? "bg-card"
                      : "bg-white/60"
                }`}
              >
                <span
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${
                    done || active
                      ? "bg-accent text-accent-foreground"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  <Icon className="h-5 w-5" />
                </span>
                <span className="flex-1">
                  <span
                    className={`block font-black uppercase tracking-wide ${
                      done || active ? "text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {step.label}
                  </span>
                  {(done || active) && stamp && (
                    <span className="text-sm text-muted-foreground">{stamp}</span>
                  )}
                </span>
                {active && (
                  <span className="text-[10px] font-black uppercase tracking-widest text-accent-foreground">
                    En cours
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      )}

      {storeAddress && (
        <p className="mt-8 text-sm text-muted-foreground">{storeAddress}</p>
      )}
    </Wrapper>
  )
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-muted px-4 pb-20 pt-32">
      <div className="mx-auto max-w-lg text-center">{children}</div>
    </div>
  )
}
