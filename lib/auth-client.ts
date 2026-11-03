import { createAuthClient } from "better-auth/react";
import { convexClient } from "@convex-dev/better-auth/client/plugins";

/**
 * Better Auth client for the themes app.
 *
 * For RBAC (roles and permissions), import from @/lib/rbac:
 * - Role enum, Permission type
 * - hasPermission, requirePermission, etc.
 * - AuthUser, AuthSession types
 *
 * @example
 * ```ts
 * import { authClient } from '@/lib/auth-client'
 * import { Role, hasPermission } from '@/lib/rbac'
 *
 * const { data: session } = authClient.useSession()
 * const canEdit = hasPermission(session?.user.role, 'products:write')
 * ```
 */
export const authClient = createAuthClient({
  plugins: [convexClient()],
});

// Re-export RBAC types for convenience
export type { Role, Permission, AuthUser, AuthSession } from './rbac'
