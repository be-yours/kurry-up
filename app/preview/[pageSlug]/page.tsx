"use client"

import { useRouter } from "next/navigation"
import { useParams } from "next/navigation"
import { authClient } from "@/lib/auth-client"
import { PreviewClient } from "./PreviewClient"

export default function PreviewPage() {
  const params = useParams<{ pageSlug: string }>()
  const router = useRouter()
  const { data: session, isPending } = authClient.useSession()

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Chargement...</p>
      </div>
    )
  }

  if (!session) {
    router.push("/sign-in")
    return null
  }

  return <PreviewClient pageSlug={params.pageSlug} />
}
