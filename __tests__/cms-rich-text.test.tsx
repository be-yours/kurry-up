/**
 * The public site renders CMS `richtext` fields as markup, and sanitises them.
 *
 * `about.story.description` is declared `type: "richtext"` and the admin editor
 * stores `editor.getHTML()`. `AboutContent` handed that string to React as a
 * plain child, so React escaped it and the visitor read the tags:
 *
 *   <div class="text-lg …">&lt;p&gt;Notre aventure…&lt;strong&gt;…</div>
 *
 * Rendering it as HTML is only safe with a sanitiser on both ends. The write
 * end is `saveDraftBlockCore`; this file holds the render end, and asserts the
 * page as a whole rather than the component alone — the defect was in the
 * wiring, and a component test would have passed straight through it.
 */
import { describe, it, expect, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { CmsRichText } from "@/components/storefront"

const MARKUP = "<p>Notre aventure a commence avec <strong>une idee simple</strong>.</p>"
const HOSTILE = '<p>Bonjour</p><script>alert(1)</script><img src=x onerror="alert(2)">'

/** The value the mocked CMS returns for `about.story.description`. */
let storyDescription: string | null = MARKUP

vi.mock("@/lib/cms/useCmsPage", () => ({
  useCmsPage: () => ({
    isLoading: false,
    pageMeta: null,
    block: (blockKey: string) => ({
      values: {},
      field: (fieldKey: string) => ({
        text:
          blockKey === "story" && fieldKey === "description"
            ? storyDescription
            : null,
        mediaUrl: null,
        media: null,
        embedUrl: null,
        altText: null,
        raw: undefined,
      }),
    }),
  }),
}))

async function renderAboutPage(): Promise<string> {
  const AboutPage = (
    await import("@/app/(storefront)/about/_components/AboutContent")
  ).default
  return renderToStaticMarkup(<AboutPage />)
}

describe("CmsRichText", () => {
  it("emits the stored markup rather than escaping it", () => {
    const html = renderToStaticMarkup(<CmsRichText html={MARKUP} />)
    expect(html).toContain("<strong>une idee simple</strong>")
    expect(html).not.toContain("&lt;strong&gt;")
  })

  it("drops script and event handlers from a stored value", () => {
    // Rows written before the write-side guard existed are still hostile, and
    // the auto-translation and seed paths write these fields without passing
    // through the editor.
    const html = renderToStaticMarkup(<CmsRichText html={HOSTILE} />)
    expect(html).toContain("<p>Bonjour</p>")
    expect(html).not.toContain("<script")
    expect(html).not.toContain("onerror")
  })

  it("keeps the caller's typography when one is given", () => {
    const html = renderToStaticMarkup(
      <CmsRichText html={MARKUP} className="text-lg font-medium" />,
    )
    expect(html).toContain('class="text-lg font-medium"')
  })
})

describe("the about page's story description", () => {
  it("renders a richtext value as markup, not as text", async () => {
    storyDescription = MARKUP
    const html = await renderAboutPage()

    expect(html).toContain("<strong>une idee simple</strong>")
    // The exact shape of the defect: the tags arriving on screen as text.
    expect(html).not.toContain("&lt;strong&gt;")
    expect(html).not.toContain("&lt;p&gt;")
  })

  it("sanitises what it renders", async () => {
    storyDescription = HOSTILE
    const html = await renderAboutPage()

    expect(html).toContain("<p>Bonjour</p>")
    expect(html).not.toContain("<script")
    expect(html).not.toContain("onerror")
  })

  it("still renders the code fallback when the field is empty", async () => {
    // The fallback is plain text with blank lines, not markup, and the
    // container keeps `whitespace-pre-line` for it.
    storyDescription = null
    const html = await renderAboutPage()

    expect(html).toContain("Notre aventure a commenc")
    expect(html).toContain("whitespace-pre-line")
  })
})
