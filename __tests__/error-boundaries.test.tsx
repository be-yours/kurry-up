/**
 * A crash has to degrade, not take the page down.
 *
 * There was one boundary in this app, at the root. App Router bubbles a render
 * error to the *nearest* `error.tsx`, so every storefront crash was caught
 * there — outside `(storefront)/layout.tsx`, which meant the header, the menu
 * link, the footer and the cart went down with the page that broke. The only
 * thing left to click was "Réessayer", which re-runs the render that just
 * failed. A visitor who hit the `/contact` crash was, in practice, stuck.
 *
 * Two things are asserted here, because both were wrong:
 *
 *  1. Each route group has its own boundary, so the crash is caught *inside*
 *     that group's layout and the chrome survives.
 *  2. Every boundary offers a way out that is not "run the same render again",
 *     and a refusal is still told apart from a crash — a refused query rethrows
 *     during render and is otherwise indistinguishable from one.
 */
import { describe, it, expect, vi } from "vitest"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { classifyBoundaryError } from "@/lib/error-boundary"

vi.mock("@sentry/nextjs", () => ({ captureException: () => {} }))

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const APP_ROOT = join(__dirname, "..", "app")

/**
 * The groups whose layout carries chrome a visitor needs after a crash.
 * `(auth)` is deliberately absent: its pages are standalone forms with no
 * navigation to preserve, and the root boundary serves them correctly.
 */
const GROUPS_WITH_CHROME = ["(storefront)", "(admin)"]

type Boundary = {
  default: (props: {
    error: Error & { digest?: string }
    reset: () => void
  }) => React.ReactElement
}

const REFUSAL = Object.assign(new Error("Server Error"), {
  data: { code: "permission_denied", message: "Refusé." },
})

const CRASH = Object.assign(
  new Error("Objects are not valid as a React child"),
  { digest: "3141592653" },
)

/** React escapes apostrophes; French copy is full of them. */
const decode = (html: string): string =>
  html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&")

async function render(modulePath: string, error: Error & { digest?: string }): Promise<string> {
  const { default: Boundary } = (await import(modulePath)) as Boundary
  return decode(renderToStaticMarkup(<Boundary error={error} reset={() => {}} />))
}

describe("the route groups that need their own boundary have one", () => {
  it.each(GROUPS_WITH_CHROME)("%s has an error.tsx of its own", (group) => {
    // Without this file the group's layout — and everything it renders — is
    // replaced by the root boundary instead of wrapping it.
    expect(existsSync(join(APP_ROOT, group, "error.tsx"))).toBe(true)
  })

  it("still has the root backstop, for what falls outside every group", () => {
    expect(existsSync(join(APP_ROOT, "error.tsx"))).toBe(true)
    expect(existsSync(join(APP_ROOT, "global-error.tsx"))).toBe(true)
  })
})

describe("classifying what arrived at the boundary", () => {
  it("reports a genuine crash", () => {
    expect(classifyBoundaryError(CRASH)).toEqual({
      denialMessage: null,
      shouldReport: true,
    })
  })

  it("reads a refusal as a refusal, and does not file it as an incident", () => {
    // Filing authorisation as an incident buries the real ones.
    expect(classifyBoundaryError(REFUSAL)).toEqual({
      denialMessage: "Votre rôle ne vous permet pas d'ouvrir cette page.",
      shouldReport: false,
    })
  })

  it("treats a refusal with nothing to display as a crash, rather than showing 'undefined'", () => {
    // Both `DENIALS[code]` and the payload's own `message` are optional. When
    // neither is there the boundary has nothing to tell the visitor, so it
    // reports and shows the crash screen instead of rendering an empty panel.
    const mute = Object.assign(new Error("Server Error"), {
      data: { code: "unheard_of" },
    })

    expect(classifyBoundaryError(mute)).toEqual({
      denialMessage: null,
      shouldReport: true,
    })
  })

  it("falls back to the payload's own message for a code it has no copy for", () => {
    const unknown = Object.assign(new Error("Server Error"), {
      data: { code: "quota_exhausted", message: "Quota de traduction épuisé." },
    })

    expect(classifyBoundaryError(unknown)).toEqual({
      denialMessage: "Quota de traduction épuisé.",
      shouldReport: false,
    })
  })
})

describe.each([
  ["the storefront boundary", "@/app/(storefront)/error", "/menu", "storefront"],
  ["the admin boundary", "@/app/(admin)/error", "/dashboard", "app"],
  ["the root boundary", "@/app/error", "/menu", "app"],
])("%s", (_name, modulePath, wayOut, surface) => {
  it("wears the palette of the surface it renders on", async () => {
    // The storefront boundary is seen by paying customers between the header
    // and the footer of a premium theme. Dropping the admin's neutral panel
    // there reads as a broken page even when it is working.
    const html = await render(modulePath, CRASH)

    if (surface === "storefront") {
      expect(html).toContain("#0D5C3F")
      expect(html).toContain("font-black")
    } else {
      expect(html).not.toContain("#0D5C3F")
      expect(html).toContain("text-2xl font-semibold")
    }
  })

  it("offers a way out that is not re-running the render that failed", async () => {
    const html = await render(modulePath, CRASH)

    expect(html).toContain(`href="${wayOut}"`)
    expect(html).toContain("Réessayer")
  })

  it("quotes the digest, which is the only handle support can be given", async () => {
    const html = await render(modulePath, CRASH)

    expect(html).toContain("3141592653")
  })

  it("shows a refusal as a refusal, with the same way out", async () => {
    const html = await render(modulePath, REFUSAL)

    expect(html).toContain("Accès refusé")
    expect(html).toContain("Votre rôle ne vous permet pas d'ouvrir cette page.")
    expect(html).toContain(`href="${wayOut}"`)
    // A refusal is not a crash: no digest to quote, and nothing to retry.
    expect(html).not.toContain("Réessayer")
  })
})

/**
 * A 404 has to look like this restaurant's site, in French.
 *
 * There was no `not-found.tsx` anywhere in any of the three applications, so
 * every unmatched address — a stale link, a QR code printed with an old path,
 * an article `blog/[slug]/page.tsx` deliberately answers `notFound()` for —
 * rendered Next's built-in default: a black page reading "404 — This page
 * could not be found." in English, with no header, no footer and no way back.
 *
 * A `not-found.tsx` is a plain render, so unlike a boundary it takes no props
 * and there is no error to classify. What is asserted is what was missing:
 * that the file exists in each place a visitor can reach one, that it is in
 * French, and that it offers somewhere to go.
 */
const NOT_FOUND_PAGES = [
  { file: "not-found.tsx", path: "../app/not-found", wayOut: "/" },
  {
    file: "(storefront)/not-found.tsx",
    path: "../app/(storefront)/not-found",
    wayOut: "/menu",
  },
  {
    file: "(admin)/not-found.tsx",
    path: "../app/(admin)/not-found",
    wayOut: "/dashboard",
  },
] as const

describe("a 404 is the establishment's own page", () => {
  it.each(NOT_FOUND_PAGES)("$file exists", ({ file }) => {
    expect(existsSync(join(APP_ROOT, file))).toBe(true)
  })

  it.each(NOT_FOUND_PAGES)("$file renders French and a way out", async ({
    path,
    wayOut,
  }) => {
    const { default: NotFound } = (await import(path)) as {
      default: () => React.ReactElement
    }
    const html = decode(renderToStaticMarkup(<NotFound />))

    expect(html).toContain("Cette page n'existe pas")
    // The English default this replaces.
    expect(html).not.toContain("This page could not be found")
    expect(html).toContain(`href="${wayOut}"`)
  })
})
