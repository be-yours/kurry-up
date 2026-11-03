"use client"

import { Check, X, Loader2 } from "lucide-react"
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  CardDescription,
  Button,
  Badge,
  Separator,
} from "@be-yours/ui"
import { cn } from "@/lib/utils"

export type BillingInterval = "monthly" | "annual"
export type PlanKey = "starter" | "pro" | "enterprise"

export interface PlanFeature {
  label: string
  included: boolean
}

export interface PlanConfig {
  key: PlanKey
  name: string
  monthlyPrice: string
  annualPrice: string
  annualSavingLabel: string
  description: string
  badge?: string
  features: PlanFeature[]
}

interface PricingCardProps {
  plan: PlanConfig
  billing: BillingInterval
  isLoading: boolean
  isDisabled: boolean
  onSubscribe: () => void
}

export function PricingCard({
  plan,
  billing,
  isLoading,
  isDisabled,
  onSubscribe,
}: PricingCardProps) {
  const isPro = plan.key === "pro"
  const price = billing === "annual" ? plan.annualPrice : plan.monthlyPrice
  const billingLabel =
    billing === "annual" ? "/ mois, facturé annuellement" : "/ mois"

  return (
    <Card
      className={cn(
        "relative flex flex-col",
        isPro && "border-primary ring-2 ring-primary ring-offset-2"
      )}
    >
      {plan.badge && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <Badge className="bg-primary text-primary-foreground">
            {plan.badge}
          </Badge>
        </div>
      )}

      <CardHeader className="pb-0">
        <CardTitle className="text-lg">{plan.name}</CardTitle>
        <CardDescription>{plan.description}</CardDescription>
        <div className="mt-4">
          <span className="text-3xl font-bold">{price}</span>
          <span className="text-sm text-muted-foreground ml-1">
            {billingLabel}
          </span>
        </div>
        {billing === "annual" && (
          <p className="text-xs text-success mt-1">
            {plan.annualSavingLabel}
          </p>
        )}
      </CardHeader>

      <CardContent className="flex-1 pt-4">
        <Separator className="mb-4" />
        <ul className="space-y-2.5">
          {plan.features.map((feature) => (
            <li key={feature.label} className="flex items-center gap-2 text-sm">
              {feature.included ? (
                <Check className="h-4 w-4 text-success shrink-0" />
              ) : (
                <X className="h-4 w-4 text-muted-foreground shrink-0" />
              )}
              <span
                className={cn(!feature.included && "text-muted-foreground")}
              >
                {feature.label}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>

      <CardFooter>
        <Button
          className="w-full"
          variant={isPro ? "default" : "outline"}
          onClick={onSubscribe}
          disabled={isDisabled}
        >
          {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isLoading ? "Redirection..." : "Choisir ce plan"}
        </Button>
      </CardFooter>
    </Card>
  )
}
