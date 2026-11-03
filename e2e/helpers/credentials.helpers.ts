import { test } from "@playwright/test"

/**
 * The seeded test accounts.
 *
 * Three tests in the public project used to sign in with the literal password
 * "julien" — the same mistake `auth.setup.ts` was corrected for. A literal only
 * works on a machine where it happens to match what `scripts/seed-users.mts`
 * wrote, and `seed-users.mts` reads `SEED_PASSWORD`. Everywhere else it failed
 * as "wrong credentials", which reads like a broken sign-in form rather than a
 * missing environment variable.
 */

/**
 * The account `scripts/seed-users.mts` creates with the `client_admin` role.
 * `SEED_ADMIN_EMAIL` overrides it; the seed script reads the same variable.
 */
export const SEED_EMAIL =
  process.env.SEED_ADMIN_EMAIL ?? "test.owner@beindigital.fr"

/** Whatever the seed script was given. Only the environment knows it. */
export const SEED_PASSWORD = process.env.SEED_PASSWORD ?? ""

/**
 * Skips the calling test when no seeded password is available.
 *
 * A test that needs a real account cannot be honest about its result without
 * one: it would fail on a missing variable and be read as a defect. Call this
 * first in any test that signs in.
 */
export function requireSeedPassword(): void {
  test.skip(
    SEED_PASSWORD === "",
    "SEED_PASSWORD is not set — run scripts/seed-users.mts and export the same value"
  )
}
