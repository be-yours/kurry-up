/**
 * Who may write what to S3 through `POST /api/upload`.
 *
 * The route used to ask one question — is anyone signed in — and a storefront
 * customer account answers yes. That let any customer write into `cms/`,
 * `products/`, `branding/` and `stores/`, which are read back by the admin and
 * the storefront on the application's own origin.
 *
 * The Convex twin already draws this line. `storageUpload.getPresignedUploadUrl`
 * checks `content:write` by role, with the comment: "'Logged in' included every
 * customer account, so the check is by role." The Next.js route was written
 * before that and never caught up.
 *
 * The decision is a pure function so it can be tested without a session, an S3
 * bucket or a running Convex deployment — the route stays a transport layer.
 * (It used to point at `contact-service` as the neighbouring example of that
 * shape; that route was an unauthenticated SES relay with no caller and has
 * been removed.)
 */

import { Role, hasPermission, parseRole, type Permission } from "@/lib/rbac"
import type { S3Folder } from "@/lib/aws"

/**
 * Writing here publishes content other people read: menus, logos, storefront
 * pages. It is an editorial act, and `content:write` is the permission that
 * names it. `CUSTOMER` does not hold it.
 */
const EDITORIAL_FOLDERS = new Set<S3Folder>([
  "products",
  "branding",
  "stores",
  "cms",
])

export const EDITORIAL_PERMISSION: Permission = "content:write"

/**
 * `users/` is the caller's own avatar, uploaded from the storefront account
 * page — self-service, not editorial, and the only folder the product actually
 * posts to this route. It stays open to any signed-in account, and its MIME
 * allow-list carries no SVG.
 */
export function requiresEditorialPermission(folder: S3Folder): boolean {
  return EDITORIAL_FOLDERS.has(folder)
}

export const UNAUTHENTICATED_ERROR = "Authentification requise"
export const FORBIDDEN_ERROR =
  "Vous n'avez pas les droits nécessaires pour cette opération."

export type UploadAccessDecision =
  | { allowed: true }
  | { allowed: false; status: 401 | 403; error: string }

/**
 * Decide whether a caller may upload into a folder.
 *
 * `role` is whatever the caller's Convex profile reports, which is a bare
 * string and may be absent entirely — an account can be authenticated with no
 * profile row yet. Anything that is not a role this build knows about resolves
 * to none, and none is refused: an unknown role must never widen access.
 */
export function decideUploadAccess(input: {
  folder: S3Folder
  authenticated: boolean
  role?: string | null
}): UploadAccessDecision {
  if (!input.authenticated) {
    return {
      allowed: false,
      status: 401,
      error: UNAUTHENTICATED_ERROR,
    }
  }

  if (!requiresEditorialPermission(input.folder)) {
    return { allowed: true }
  }

  const role = input.role ? parseRole(input.role) : undefined
  if (role === undefined || !hasPermission(role, EDITORIAL_PERMISSION)) {
    return {
      allowed: false,
      status: 403,
      error: FORBIDDEN_ERROR,
    }
  }

  return { allowed: true }
}

/** Exposed for the tests that pin which roles may publish content. */
export const ROLES_WITH_EDITORIAL_PERMISSION: readonly Role[] = Object.values(
  Role,
).filter((role) => hasPermission(role, EDITORIAL_PERMISSION))
