"use client"

import { useState } from "react"
import Link from "next/link"
import { useMutation, useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import { useAdminStoreId } from "@/lib/admin/hooks"
import { Lock, AlertTriangle } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Button,
  Badge,
} from "@be-yours/ui"
import { LoadingState } from "@/components/admin/LoadingState"
import { BlogAutoConfigForm } from "./BlogAutoConfigForm"

const QUOTA_UNLIMITED_THRESHOLD = 9999

const REASONS_WITH_UPGRADE = [
  "Aucun abonnement Auto Blog actif",
  "Abonnement inactif",
  "Aucun plan Auto Blog actif",
]

export function BlogAutoConfigPage() {
  const storeId = useAdminStoreId()
  const accessStatus = useQuery(api.blogAutoConfig.getAccessStatus)
  const config = useQuery(
    api.blogAutoConfig.getByStoreId,
    storeId ? { storeId } : "skip"
  )

  // Loading state
  if (accessStatus === undefined || (storeId && config === undefined)) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <LoadingState variant="cards" count={2} />
      </div>
    )
  }

  // Locked state
  if (!accessStatus.allowed) {
    const showUpgradeLink = REASONS_WITH_UPGRADE.includes(
      accessStatus.reason ?? ""
    )
    return (
      <div className="space-y-6">
        <PageHeader />
        <LockedView reason={accessStatus.reason} showUpgradeLink={showUpgradeLink} />
      </div>
    )
  }

  // Form state
  const ab = accessStatus.entitlements?.autoBlog
  const monthlyQuota = ab?.monthlyQuota ?? 0
  const isUnlimited = monthlyQuota >= QUOTA_UNLIMITED_THRESHOLD

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <PageHeader />
        <Badge variant="outline" className="text-sm">
          {isUnlimited
            ? "Quota illimité"
            : `${accessStatus.remainingQuota} / ${monthlyQuota} articles restants`}
        </Badge>
      </div>
      {storeId && (
        <BlogAutoConfigForm
          config={config ?? null}
          accessStatus={accessStatus}
          storeId={storeId}
        />
      )}
    </div>
  )
}

function PageHeader() {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">
        Configuration Auto Blog
      </h1>
      <p className="text-sm text-muted-foreground mt-1">
        Configurez la génération automatique d&apos;articles pour votre blog.
      </p>
    </div>
  )
}


function LockedView({
  reason,
  showUpgradeLink,
}: {
  reason?: string
  showUpgradeLink: boolean
}) {
  return (
    <Card className="border-dashed">
      <CardHeader className="text-center pb-2">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          {reason === "Quota mensuel atteint" ? (
            <AlertTriangle className="h-6 w-6 text-warning" />
          ) : (
            <Lock className="h-6 w-6 text-muted-foreground" />
          )}
        </div>
        <CardTitle className="text-lg">
          {reason === "Quota mensuel atteint"
            ? "Quota mensuel atteint"
            : "Auto Blog non disponible"}
        </CardTitle>
        <CardDescription>
          {reason ?? "Vous n'avez pas accès à cette fonctionnalité."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-3 pb-6">
        {showUpgradeLink && (
          <Button asChild>
            <Link href="/dashboard/subscription">Voir les abonnements</Link>
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
