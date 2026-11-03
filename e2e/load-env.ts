import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"

/**
 * Reads the app's env files into `process.env`.
 *
 * Shared by `playwright.config.ts` and `scripts/seed-users.mts` because both
 * have to bootstrap their own environment before doing anything, and they must
 * agree on what a line means.
 *
 * The parsing matters more than it looks. `npx convex dev` writes
 *
 *   CONVEX_DEPLOYMENT=dev:youthful-goose-352 # team: …, project: beyours-reference
 *
 * and taking everything after the `=` hands the Convex CLI a deployment name
 * with the comment glued to it — which it answers with "InvalidDeploymentName:
 * Couldn't parse deployment name  beyours-reference", pointing nowhere near the
 * env file. An inline comment needs whitespace before the `#`, so a value
 * containing `#` with no space survives; anything stranger should be quoted.
 *
 * Values already in the environment win: a shell export beats both files.
 */
export function loadEnvFiles(appRoot: string, fileNames: string[]): void {
  for (const fileName of fileNames) {
    const envPath = resolve(appRoot, fileName)
    if (!existsSync(envPath)) continue

    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue

      const eqIdx = trimmed.indexOf("=")
      if (eqIdx === -1) continue

      const key = trimmed.slice(0, eqIdx).trim()
      if (!key || process.env[key]) continue

      process.env[key] = parseValue(trimmed.slice(eqIdx + 1))
    }
  }
}

function parseValue(raw: string): string {
  const value = raw.trim()

  const quote = value[0]
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1)
    if (end !== -1) return value.slice(1, end)
    return value.slice(1)
  }

  const comment = value.search(/\s#/)
  return comment === -1 ? value : value.slice(0, comment).trimEnd()
}
