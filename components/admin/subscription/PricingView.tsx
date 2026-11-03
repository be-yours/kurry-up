"use client"

import { useState } from "react"
import { useAction } from "convex/react"
import { api } from "@/convex/_generated/api"
import { toast } from "sonner"
import { Badge } from "@be-yours/ui"
import { cn } from "@/lib/utils"
import {
  PricingCard,
  type BillingInterval,
  type PlanKey,
  type PlanConfig,
} from "./PricingCard"

const PLANS: PlanConfig[] = [
  {
    key: "starter",
    name: "Starter",
    monthlyPrice: "19€",
    annualPrice: "15€",
    annualSavingLabel: "2 mois offerts",
    description: "Idéal pour commencer",
    features: [
      { label: "2 articles / mois", included: true },
      { label: "3 sujets maximum", included: true },
      { label: "5 images IA / mois", included: true },
      { label: "3 analyses Image vers Produit / mois", included: true },
      { label: "Multi-langue", included: false },
      { label: "Publication automatique", included: false },
    ],
  },
  {
    key: "pro",
    name: "Pro",
    monthlyPrice: "49€",
    annualPrice: "39€",
    annualSavingLabel: "2 mois offerts",
    description: "Pour les restaurants ambitieux",
    badge: "Populaire",
    features: [
      { label: "8 articles / mois", included: true },
      { label: "Sujets illimités", included: true },
      { label: "20 images IA / mois", included: true },
      { label: "15 analyses Image vers Produit / mois", included: true },
      { label: "Multi-langue", included: false },
      { label: "Publication automatique", included: true },
    ],
  },
  {
    key: "enterprise",
    name: "Enterprise",
    monthlyPrice: "99€",
    annualPrice: "79€",
    annualSavingLabel: "2 mois offerts",
    description: "Pour les chaînes et groupes",
    features: [
      { label: "30 articles / mois", included: true },
      { label: "Sujets illimités", included: true },
      { label: "100 images IA / mois", included: true },
      { label: "50 analyses Image vers Produit / mois", included: true },
      { label: "Multi-langue", included: true },
      { label: "Publication automatique", included: true },
    ],
  },
]

export function PricingView() {
  const [billing, setBilling] = useState<BillingInterval>("monthly")
  const [loadingPlan, setLoadingPlan] = useState<PlanKey | null>(null)
  const createCheckoutSession = useAction(
    api.bidSubscription.createCheckoutSession
  )

  const handleSubscribe = async (plan: PlanKey) => {
    setLoadingPlan(plan)
    try {
      const result = await createCheckoutSession({ plan, billing })
      if (result?.url) {
        // eslint-disable-next-line react-hooks/immutability
        window.location.href = result.url
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Erreur lors de la redirection vers le paiement"
      )
      setLoadingPlan(null)
    }
  }

  return (
    <div className="space-y-8">
      {/* Billing toggle */}
      <div className="flex items-center justify-center gap-3">
        <button
          onClick={() => setBilling("monthly")}
          className={cn(
            "text-sm font-medium transition-colors",
            billing === "monthly"
              ? "text-foreground"
              : "text-muted-foreground"
          )}
        >
          Mensuel
        </button>
        <button
          role="switch"
          aria-checked={billing === "annual"}
          onClick={() =>
            setBilling(billing === "monthly" ? "annual" : "monthly")
          }
          className={cn(
            "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
            billing === "annual" ? "bg-primary" : "bg-muted"
          )}
        >
          <span
            className={cn(
              "inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
              billing === "annual" ? "translate-x-6" : "translate-x-1"
            )}
          />
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setBilling("annual")}
            className={cn(
              "text-sm font-medium transition-colors",
              billing === "annual"
                ? "text-foreground"
                : "text-muted-foreground"
            )}
          >
            Annuel
          </button>
          {billing === "annual" && (
            <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
              2 mois offerts
            </Badge>
          )}
        </div>
      </div>

      {/* Plan cards */}
      <div className="grid gap-6 md:grid-cols-3">
        {PLANS.map((plan) => (
          <PricingCard
            key={plan.key}
            plan={plan}
            billing={billing}
            isLoading={loadingPlan === plan.key}
            isDisabled={loadingPlan !== null}
            onSubscribe={() => handleSubscribe(plan.key)}
          />
        ))}
      </div>
    </div>
  )
}
