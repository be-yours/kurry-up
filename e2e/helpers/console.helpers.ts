import type { Page, ConsoleMessage } from "@playwright/test"

/**
 * Known console error patterns to ignore during E2E tests.
 * These are expected errors from Convex, auth, and Next.js.
 */
const IGNORED_PATTERNS = [
  /ws:\/\//i,
  /wss:\/\//i,
  /convex/i,
  /ConvexReactClient/i,
  /401/,
  /403/,
  /Unauthorized/i,
  /hydrat/i,
  /\[HMR\]/i,
  /hot-reload/i,
  /NEXT_REDIRECT/i,
  /Failed to fetch/i,
  /AbortError/i,
  /cancelled/i,
  /net::ERR/i,
  /Module not found/i,
  /module-not-found/i,
  /500 \(Internal Server Error\)/i,
  /Failed to load resource.*500/i,
  /Internal Server Error/i,
  /Can't resolve/i,
  /Import trace/i,
  /nextjs\.org\/docs\/messages/i,
  /@be-yours/i,
]

/**
 * Collect console errors from a page, filtering out known/expected patterns.
 * Returns a cleanup function and an accessor to the collected errors.
 */
export function collectConsoleErrors(page: Page) {
  const errors: string[] = []

  const handler = (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return
    const text = msg.text()
    const isIgnored = IGNORED_PATTERNS.some((pattern) => pattern.test(text))
    if (!isIgnored) {
      errors.push(text)
    }
  }

  page.on("console", handler)

  return {
    getErrors: () => [...errors],
    cleanup: () => page.off("console", handler),
  }
}
