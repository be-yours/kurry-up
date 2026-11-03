import { describe, it, expect } from "vitest"
import { Role } from "@/lib/rbac"
import type { S3Folder } from "@/lib/aws"
import {
  decideUploadAccess,
  requiresEditorialPermission,
  ROLES_WITH_EDITORIAL_PERMISSION,
  EDITORIAL_PERMISSION,
  UNAUTHENTICATED_ERROR,
  FORBIDDEN_ERROR,
} from "../upload-authorization"

const EDITORIAL: S3Folder[] = ["products", "branding", "stores", "cms"]

describe("requiresEditorialPermission", () => {
  it.each(EDITORIAL)("guards %s, which the restaurant publishes from", (folder) => {
    expect(requiresEditorialPermission(folder)).toBe(true)
  })

  it("leaves users/ open — it is the caller's own avatar", () => {
    expect(requiresEditorialPermission("users")).toBe(false)
  })
})

describe("decideUploadAccess", () => {
  it("refuses an anonymous caller with 401", () => {
    const decision = decideUploadAccess({
      folder: "users",
      authenticated: false,
    })
    expect(decision).toEqual({
      allowed: false,
      status: 401,
      error: UNAUTHENTICATED_ERROR,
    })
  })

  /**
   * The report's first step: sign up on the storefront, then upload. This is
   * the case the route answered 200 to.
   */
  it.each(EDITORIAL)(
    "refuses a signed-in CUSTOMER writing to %s with 403",
    (folder) => {
      const decision = decideUploadAccess({
        folder,
        authenticated: true,
        role: Role.CUSTOMER,
      })
      expect(decision).toEqual({
        allowed: false,
        status: 403,
        error: FORBIDDEN_ERROR,
      })
    },
  )

  it("lets a signed-in CUSTOMER upload their own avatar", () => {
    expect(
      decideUploadAccess({
        folder: "users",
        authenticated: true,
        role: Role.CUSTOMER,
      }),
    ).toEqual({ allowed: true })
  })

  it.each([Role.CLIENT_ADMIN, Role.MANAGER, Role.SUPER_ADMIN])(
    "lets %s publish content",
    (role) => {
      expect(
        decideUploadAccess({ folder: "cms", authenticated: true, role }),
      ).toEqual({ allowed: true })
    },
  )

  it.each([Role.KITCHEN, Role.WAITER, Role.DELIVERY])(
    "refuses %s, who is staff but not an editor",
    (role) => {
      expect(
        decideUploadAccess({ folder: "cms", authenticated: true, role }).allowed,
      ).toBe(false)
    },
  )

  describe("fails closed when the role cannot be established", () => {
    it.each([
      ["absent", undefined],
      ["null", null],
      ["empty", ""],
      ["unknown to this build", "editor_in_chief"],
      ["a permission string", EDITORIAL_PERMISSION],
    ] as const)("refuses a role that is %s", (_label, role) => {
      expect(
        decideUploadAccess({ folder: "cms", authenticated: true, role }).allowed,
      ).toBe(false)
    })
  })

  it("does not consult the role for a folder that does not need one", () => {
    // The route skips the Convex round-trip for users/, so the decision has to
    // stand without a role at all.
    expect(
      decideUploadAccess({ folder: "users", authenticated: true, role: null }),
    ).toEqual({ allowed: true })
  })
})

describe("who holds content:write", () => {
  it("is the three editorial roles, and CUSTOMER is not among them", () => {
    // Pinned so that widening the role table is a deliberate act with a failing
    // test attached, not a side effect.
    expect([...ROLES_WITH_EDITORIAL_PERMISSION].sort()).toEqual(
      [Role.SUPER_ADMIN, Role.CLIENT_ADMIN, Role.MANAGER].sort(),
    )
    expect(ROLES_WITH_EDITORIAL_PERMISSION).not.toContain(Role.CUSTOMER)
  })
})
