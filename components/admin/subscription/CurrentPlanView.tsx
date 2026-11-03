"use client"

import { useState } from "react"
import { useAction } from "convex/react"
import { api } from "@/convex/_generated/api"
import { convexErrorMessage } from "@/lib/convex-error"
import { toast } from "sonner"
import { Check, X, ExternalLink, Loader2 } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Button,
  Badge,
  Separator,
} from "@be-yours/ui"

const PLAN_LABELS: Record<string, string> = {
  starter: "Starter",
  pro: "Pro",
  enterprise: "Enterprise",
}

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  active: {
    label: "Actif",
    className:
      "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  },
  trialing: {
    label: "Période d'essai",
    className:
      "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  },
}

interface CurrentPlanViewProps {
  entitlements: {
    autoBlog: {
      enabled: boolean
      plan?: string
      monthlyQuota: number
      maxTopics?: number
      monthlyImageQuota?: number
      allowMultiLanguage: boolean
      allowAutoPublish: boolean
    }
    imageToProduct?: {
      enabled: boolean
      monthlyAnalysisQuota: number
    }
    stripeCustomerId?: string
    subscriptionStatus?: string
  }
}

export function CurrentPlanView({ entitlements }: CurrentPlanViewProps) {
  const [isLoading, setIsLoading] = useState(false)
  const createPortalSession = useAction(
    api.bidSubscription.createPortalSession
  )

  const handleOpenPortal = async () => {
    setIsLoading(true)
    try {
      const result = await createPortalSession({})
      if (result?.url) {
        window.location.href = result.url
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Erreur lors de l'ouverture du portail"
      )
      setIsLoading(false)
    }
  }

  const { autoBlog, imageToProduct, subscriptionStatus } = entitlements
  const planName = autoBlog.plan
    ? (PLAN_LABELS[autoBlog.plan] ?? autoBlog.plan)
    : "Inconnu"
  const statusInfo = subscriptionStatus
    ? (STATUS_CONFIG[subscriptionStatus] ?? {
        label: subscriptionStatus,
        className: "bg-muted text-muted-foreground",
      })
    : { label: "Inconnu", className: "bg-muted text-muted-foreground" }

  // Fallback image quota from plan if not yet stored in entitlements
  const IMAGE_QUOTA_BY_PLAN: Record<string, number> = {
    starter: 5,
    pro: 20,
    enterprise: 100,
  }
  const imageQuota =
    autoBlog.monthlyImageQuota ??
    (autoBlog.plan ? IMAGE_QUOTA_BY_PLAN[autoBlog.plan] ?? 0 : 0)

  // Image-to-Product quota
  const ITP_QUOTA_BY_PLAN: Record<string, number> = {
    starter: 3,
    pro: 15,
    enterprise: 50,
  }
  const itpQuota =
    imageToProduct?.monthlyAnalysisQuota ??
    (autoBlog.plan ? ITP_QUOTA_BY_PLAN[autoBlog.plan] ?? 0 : 0)
  const itpEnabled = imageToProduct?.enabled ?? itpQuota > 0

  const features = [
    {
      label: `${autoBlog.monthlyQuota} articles / mois`,
      included: true,
      section: "Auto Blog" as const,
    },
    {
      label:
        autoBlog.maxTopics === undefined
          ? "Sujets illimités"
          : `${autoBlog.maxTopics} sujets maximum`,
      included: true,
      section: "Auto Blog" as const,
    },
    {
      label: imageQuota > 0
        ? `${imageQuota} images IA / mois`
        : "Images IA",
      included: imageQuota > 0,
      section: "Auto Blog" as const,
    },
    {
      label: "Multi-langue",
      included: autoBlog.allowMultiLanguage,
      section: "Auto Blog" as const,
    },
    {
      label: "Publication automatique",
      included: autoBlog.allowAutoPublish,
      section: "Auto Blog" as const,
    },
    {
      label: itpEnabled
        ? `${itpQuota} analyses Image vers Produit / mois`
        : "Image vers Produit",
      included: itpEnabled,
      section: "Image vers Produit" as const,
    },
  ]

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="text-lg">Plan actuel</CardTitle>
              <CardDescription>Votre abonnement BeYours</CardDescription>
            </div>
            <Badge className={statusInfo.className}>{statusInfo.label}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <span className="text-2xl font-bold">{planName}</span>

          <Separator />

          <ul className="space-y-2.5">
            {features.map((feature) => (
              <li
                key={feature.label}
                className="flex items-center gap-2 text-sm"
              >
                {feature.included ? (
                  <Check className="h-4 w-4 text-success shrink-0" />
                ) : (
                  <X className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
                <span
                  className={!feature.included ? "text-muted-foreground" : ""}
                >
                  {feature.label}
                </span>
              </li>
            ))}
          </ul>

          <Separator />

          <Button
            onClick={handleOpenPortal}
            disabled={isLoading}
            className="w-full sm:w-auto"
          >
            {isLoading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <ExternalLink className="mr-2 h-4 w-4" />
            )}
            Gérer mon abonnement
          </Button>
        </CardContent>
      </Card>

      {autoBlog.plan && autoBlog.plan !== "enterprise" && (
        <UpgradePrompt currentPlan={autoBlog.plan as "starter" | "pro"} />
      )}
    </div>
  )
}

function UpgradePrompt({
  currentPlan,
}: {
  currentPlan: "starter" | "pro"
}) {
  const [isLoading, setIsLoading] = useState(false)
  const createPortalSession = useAction(
    api.bidSubscription.createPortalSession
  )

  const nextPlan = currentPlan === "starter" ? "Pro" : "Enterprise"
  const message =
    currentPlan === "starter"
      ? "Passez au plan Pro pour la publication automatique, 20 images IA, 15 analyses Image vers Produit et 8 articles par mois."
      : "Passez au plan Enterprise pour le multi-langue, 100 images IA, 50 analyses Image vers Produit et 30 articles par mois."

  const handleUpgrade = async () => {
    setIsLoading(true)
    try {
      const result = await createPortalSession({})
      if (result?.url) {
        window.location.href = result.url
      }
    } catch (err) {
      toast.error(
        convexErrorMessage(err, {}, "Erreur")
      )
      setIsLoading(false)
    }
  }

  return (
    <Card className="border-dashed bg-muted/30">
      <CardContent className="py-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <p className="text-sm font-medium">
              Évoluez vers {nextPlan}
            </p>
            <p className="text-sm text-muted-foreground mt-0.5">{message}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleUpgrade}
            disabled={isLoading}
          >
            {isLoading && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Changer de plan
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
