/**
 * The CMS preview frame.
 *
 * `PreviewClient` renders the storefront in a same-origin `<iframe>`. The frame
 * was blank in every environment because `next.config.ts` sent
 * `X-Frame-Options: DENY` and the CSP said `frame-ancestors 'none'` — the
 * browser refused the frame before the component ever mattered.
 *
 * The header half of that is covered in
 * `lib/security/__tests__/content-security-policy.test.ts`. This file covers
 * the component half: the frame exists and points at the storefront route in
 * preview mode. `e2e/cms/cms-preview.spec.ts` asserts the two together against
 * a real browser, but the e2e suite only runs where a Convex backend is
 * configured, so the guard that runs on every push lives here.
 */
import { describe, it, expect, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("@/lib/hooks/use-store-id", () => ({
  useStoreId: () => null,
}))

async function renderPreview(pageSlug: string): Promise<string> {
  const { PreviewClient } = await import("@/app/preview/[pageSlug]/PreviewClient")
  return renderToStaticMarkup(<PreviewClient pageSlug={pageSlug} />)
}

describe("PreviewClient", () => {
  it("frames the storefront route with preview=true", async () => {
    const html = await renderPreview("about")

    expect(html).toContain("<iframe")
    expect(html).toContain('src="/about?preview=true"')
  })

  it("titles the frame so the e2e suite can find it", async () => {
    // `e2e/cms/cms-preview.spec.ts` locates the frame by `title^='Preview'`;
    // renaming it here without renaming it there gives a green suite over a
    // frame nobody looked inside.
    const html = await renderPreview("about")

    expect(html).toMatch(/title="Preview: [^"]+"/)
  })

  it("says so instead of framing nothing for an unknown page", async () => {
    const html = await renderPreview("not-a-page")

    expect(html).not.toContain("<iframe")
    expect(html).toContain("not-a-page")
  })
})
