"use client"

import { useRouter, useParams } from "next/navigation"
import { authClient } from "@/lib/auth-client"
import { BlogPreviewClient } from "./BlogPreviewClient"

export default function BlogPreviewPage() {
  const params = useParams<{ articleId: string }>()
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

  return <BlogPreviewClient articleId={params.articleId} />
}
