/**
 * Seed script to create test users via Better Auth API + Convex userProfiles.
 *
 * All emails use @beindigital.fr with "test." prefix to identify test accounts.
 *
 * Prerequisites:
 *   - Next.js dev server running (pnpm dev)
 *   - Convex dev running (pnpx convex dev)
 *
 * Usage:
 *   cd apps/reference
 *   npx tsx scripts/seed-users.mts
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { loadEnvFiles } from "../e2e/load-env.js"

const run = promisify(execFile)

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
loadEnvFiles(appRoot, [".env.e2e", ".env.local"])

// ── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000"

// Never hardcode the deployment URL or passwords. Both come from the environment
// (.env.local for local dev, GitHub Secrets in CI). SEED_PASSWORD is for throwaway
// test accounts only — never reuse a real password.
const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL ?? ""
const SEED_PASSWORD = process.env.SEED_PASSWORD ?? ""

if (!CONVEX_URL) {
  console.error("NEXT_PUBLIC_CONVEX_URL is required (set it in .env.local). Aborting.")
  process.exit(1)
}
if (!SEED_PASSWORD) {
  console.error(
    "SEED_PASSWORD is required (set it in .env.e2e — test accounts only). Aborting."
  )
  process.exit(1)
}

// `convex/auth.ts` sets minPasswordLength: 12. Saying so here beats letting
// Better Auth reject the sign-up with a message about the request body.
const MIN_PASSWORD_LENGTH = 12
if (SEED_PASSWORD.length < MIN_PASSWORD_LENGTH) {
  console.error(
    `SEED_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters — the ` +
      `server enforces it (convex/auth.ts, minPasswordLength). Aborting.`
  )
  process.exit(1)
}

/**
 * The owner account the e2e suite signs in as.
 *
 * Overridable because a password cannot be reset from here: the script signs
 * existing accounts in rather than resetting them, so an address whose password
 * has been lost is unusable forever. Pointing at a fresh address is the way out,
 * and `e2e/auth.setup.ts` reads the same variable.
 */
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "test.owner@beindigital.fr"

/**
 * Better Auth refuses any state-changing request whose `Origin` is missing.
 *
 * Node's `fetch` sends none — a browser always does — so every call here came
 * back `403 MISSING_OR_NULL_ORIGIN` and the script ended on "No account could
 * be created or opened. Nothing to seed." The CI step runs it with `|| true`,
 * so the run continued to Playwright against an empty database and the failure
 * surfaced 400 tests later as an admin screen that would not load.
 *
 * `BASE_URL` is what a browser would send, and `convex/auth.ts` lists it in
 * `trustedOrigins` (through `SITE_URL`, plus the localhost range).
 */
const AUTH_HEADERS = {
  "Content-Type": "application/json",
  Origin: BASE_URL,
} as const

type UserRole =
  | "client_admin"
  | "manager"
  | "kitchen"
  | "waiter"
  | "customer"

interface SeedUser {
  name: string
  email: string
  password: string
  role: UserRole
}

// All test accounts share the SEED_PASSWORD supplied via the environment.
const SEED_USERS: SeedUser[] = [
  // Owner
  {
    name: "Mamadou Seck",
    email: ADMIN_EMAIL,
    password: SEED_PASSWORD,
    role: "client_admin",
  },
  // Team members
  {
    name: "Marie Martin",
    email: "test.manager@beindigital.fr",
    password: SEED_PASSWORD,
    role: "manager",
  },
  {
    name: "Pierre Dupont",
    email: "test.cuisine@beindigital.fr",
    password: SEED_PASSWORD,
    role: "kitchen",
  },
  {
    name: "Sophie Laurent",
    email: "test.service@beindigital.fr",
    password: SEED_PASSWORD,
    role: "waiter",
  },
  // Regular customers
  {
    name: "Jean Durand",
    email: "test.client1@beindigital.fr",
    password: SEED_PASSWORD,
    role: "customer",
  },
  {
    name: "Camille Moreau",
    email: "test.client2@beindigital.fr",
    password: SEED_PASSWORD,
    role: "customer",
  },
]

// ── Helpers ──────────────────────────────────────────────────────────────────

async function signUpUser(
  user: SeedUser
): Promise<{ id: string; email: string; name: string } | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        name: user.name,
        email: user.email,
        password: user.password,
      }),
    })

    const data = await res.json()

    if (!res.ok) {
      console.error(`  [SKIP] ${user.email} - HTTP ${res.status}:`, data?.message ?? data)
      return null
    }

    if (data.user) {
      console.log(`  [OK]   ${user.email} -> id: ${data.user.id}`)
      return { id: data.user.id, email: data.user.email, name: data.user.name }
    }

    if (data.id) {
      console.log(`  [OK]   ${user.email} -> id: ${data.id}`)
      return { id: data.id, email: data.email, name: data.name }
    }

    console.error(`  [SKIP] ${user.email} - Unexpected response:`, JSON.stringify(data))
    return null
  } catch (err) {
    console.error(`  [ERR]  ${user.email} -`, err)
    return null
  }
}

/**
 * Recover an existing account's id by signing in.
 *
 * Seeding has to be repeatable. The script used to stop at "No users were
 * created. They may already exist." — which meant that after a partial run, the
 * accounts existed, their profiles did not, and no amount of re-running could
 * ever repair it. Step 2 is independent of step 1 and must be reached either
 * way.
 */
async function signInUser(
  user: SeedUser
): Promise<{ id: string; email: string; name: string } | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ email: user.email, password: user.password }),
    })

    const data = await res.json()
    if (!res.ok || !data?.user?.id) {
      // Report what the server said. An earlier version guessed "wrong
      // password", and the real answer was EMAIL_NOT_VERIFIED — a guess in an
      // error message sends whoever reads it down the wrong path.
      const detail = data?.code ?? data?.message ?? `HTTP ${res.status}`
      console.error(`  [ERR]  ${user.email} exists but cannot be opened: ${detail}`)
      if (data?.code === "EMAIL_NOT_VERIFIED") {
        console.error(
          "         Seeded accounts have no mailbox. Set AUTH_ALLOW_UNVERIFIED_EMAIL=true" +
            " on the TEST deployment (npx convex env set), never on a client one."
        )
      }
      return null
    }

    console.log(`  [SAME] ${user.email} -> id: ${data.user.id} (already existed)`)
    return { id: data.user.id, email: data.user.email, name: data.user.name }
  } catch (err) {
    console.error(`  [ERR]  ${user.email} -`, err)
    return null
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== BeYours Engine - Test User Seeding ===\n")
  console.log(`Better Auth URL: ${BASE_URL}`)
  console.log(`Convex URL: ${CONVEX_URL}\n`)

  // Step 1: Create users via Better Auth sign-up API
  console.log("Step 1: Creating users via Better Auth...\n")

  const createdUsers: { user: { id: string; email: string; name: string }; role: UserRole }[] = []

  for (const seedUser of SEED_USERS) {
    // An account that already exists is not a reason to stop: its profile may
    // still be missing, and step 2 is what carries the role.
    const user = (await signUpUser(seedUser)) ?? (await signInUser(seedUser))
    if (user) {
      createdUsers.push({ user, role: seedUser.role })
    }
    // Small delay between requests
    await new Promise((r) => setTimeout(r, 500))
  }

  if (createdUsers.length === 0) {
    console.error("\nNo account could be created or opened. Nothing to seed.")
    process.exitCode = 1
    return
  }

  console.log(`\n${createdUsers.length}/${SEED_USERS.length} accounts ready.\n`)

  // Step 2: Create userProfiles in Convex
  console.log("Step 2: Creating userProfiles in Convex...\n")

  // Profiles go through `internalUpsert`, run by the Convex CLI.
  //
  // `userProfiles.upsert` is internal now and demands an authenticated actor
  // with the right to hand out roles — that is the whole point of it. This
  // script has no session, so it used to fail with "Not authenticated" on
  // every user while
  // still printing "Seeding complete!": the accounts existed, none of them had
  // a role, and the e2e suite then failed on an admin screen for reasons that
  // pointed nowhere near here.
  //
  // `npx convex run` authenticates as the deployment itself, which is the
  // correct authority for provisioning — and is not reachable from a browser.
  let failed = 0

  for (const { user, role } of createdUsers) {
    try {
      await run("npx", [
        "convex",
        "run",
        "userProfiles:internalUpsert",
        JSON.stringify({
          userId: user.id,
          role,
          storeIds: [],
          permissions: [],
          language: "fr",
        }),
      ])
      console.log(`  [OK]   Profile for ${user.email} (${role})`)
    } catch (err: unknown) {
      failed += 1
      const message =
        err && typeof err === "object" && "stderr" in err
          ? String((err as { stderr: unknown }).stderr).trim()
          : err instanceof Error
            ? err.message
            : String(err)
      console.error(`  [ERR]  Profile for ${user.email}: ${message}`)
    }
  }

  if (failed > 0) {
    // Say so, and exit non-zero. A seed script that announces success while
    // leaving every account role-less is worse than one that crashes.
    console.error(
      `\n=== Seeding FAILED: ${failed}/${createdUsers.length} profiles were not created ===\n`
    )
    process.exitCode = 1
    return
  }

  // Step 3: the restaurant the staff will administer.
  //
  // Accounts alone are not a usable fixture: with an empty `stores` table every
  // profile carries `storeIds: []`, so authentication succeeds and every admin
  // screen still renders nothing.
  console.log("\nStep 3: Seeding the test restaurant...\n")

  try {
    const { stdout } = await run("npx", [
      "convex",
      "run",
      "seedFixture:internalSeedFixture",
      "{}",
    ])
    const summary = stdout.trim().split("\n").pop() ?? ""
    console.log(`  [OK]   ${summary}`)
  } catch (err: unknown) {
    const message =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr).trim()
        : String(err)
    console.error(`  [ERR]  Restaurant fixture: ${message}`)
    console.error(
      "\n=== Seeding FAILED: accounts exist but there is no restaurant to administer ===\n"
    )
    process.exitCode = 1
    return
  }

  console.log("\n=== Seeding complete! ===\n")

  console.log("Test users summary:")
  console.log("-".repeat(75))
  console.log(`  ${"Name".padEnd(20)} ${"Email".padEnd(35)} Role`)
  console.log("-".repeat(75))
  for (const { user, role } of createdUsers) {
    console.log(`  ${user.name.padEnd(20)} ${user.email.padEnd(35)} ${role}`)
  }
  console.log("-".repeat(75))
  console.log("\nAll accounts use the password from the SEED_PASSWORD env var.")
}

main().catch(console.error)
