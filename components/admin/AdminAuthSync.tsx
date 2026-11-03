"use client"

import { useEffect } from "react"
import { useQuery } from "convex/react"
import { authClient } from "@/lib/auth-client"
import { useAdminAuthStore } from "@be-yours/admin"
import { api } from "@/convex/_generated/api"
import type { Role } from "@/lib/rbac"

/**
 * Sync component that bridges Better Auth session + Convex userProfile
 * into the admin Zustand store. Renders nothing visually.
 */
export function AdminAuthSync() {
  const { data: session, isPending: sessionLoading } =
    authClient.useSession()

  // `getMyProfile` reads the caller's own profile from their session. The
  // previous `getByUserId` took a user id and performed no identity check, so
  // any visitor could read anyone's role and store list.
  const profile = useQuery(
    api.userProfiles.getMyProfile,
    session?.user?.id ? {} : "skip"
  )

  const setAuth = useAdminAuthStore((s) => s.setAuth)
  const setLoading = useAdminAuthStore((s) => s.setLoading)
  const clearAuth = useAdminAuthStore((s) => s.clearAuth)

  useEffect(() => {
    // Still loading session
    if (sessionLoading) {
      setLoading(true)
      return
    }

    // No session = not authenticated
    if (!session?.user) {
      clearAuth()
      return
    }

    // Session exists but profile still loading from Convex
    if (profile === undefined) {
      setLoading(true)
      return
    }

    // Both session and profile are ready
    const user = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name ?? undefined,
      image: session.user.image ?? undefined,
    }

    const role = (profile?.role ?? "customer") as Role

    // The module checkboxes the owner ticked. The sidebar runs the server's
    // own `profileAllowsPermission` against them, so an entry is drawn only
    // when the server would serve the screen behind it. An absent list means
    // unrestricted, exactly as the server reads it.
    const permissions = profile?.permissions ?? []

    const signOut = async () => {
      await authClient.signOut()
      clearAuth()
    }

    setAuth(user, role, signOut, permissions)
  }, [session, sessionLoading, profile, setAuth, setLoading, clearAuth])

  return null
}
