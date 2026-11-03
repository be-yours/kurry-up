// @vitest-environment jsdom
import { describe, expect, test } from "vitest"
import DOMPurify from "isomorphic-dompurify"
import {
  ARTICLE_SANITIZE_PROFILE,
  RICH_TEXT_SANITIZE_PROFILE,
} from "@/lib/blog/sanitize-profile"

/**
 * The render pass and the write pass must allow the same markup.
 *
 * `DOMPurify.sanitize(html)` with no configuration is far wider than the
 * write-time allow-list: it keeps `<form>`, `<table>`, `<svg>` and `style`.
 * None of that executes script, but a credential form or a fixed full-viewport
 * overlay on the restaurant's own domain is not something the second pass
 * should let through — and the rows this pass exists for are precisely the
 * legacy ones nothing sanitised on the way in.
 */

const article = (html: string) => DOMPurify.sanitize(html, ARTICLE_SANITIZE_PROFILE)
const richText = (html: string) => DOMPurify.sanitize(html, RICH_TEXT_SANITIZE_PROFILE)

describe("the article render profile", () => {
  test("keeps what an article is made of", () => {
    const html = "<h2>Titre</h2><p>Un <strong>plat</strong>.</p><ul><li>Un</li></ul>"
    expect(article(html)).toBe(html)
  })

  test("keeps an image and a link with their attributes", () => {
    const html = '<p><a href="https://example.com" target="_blank" rel="noopener">lien</a></p>'
    expect(article(html)).toContain('href="https://example.com"')
    expect(article('<img src="/api/files/x.png" alt="a" class="w-full">')).toContain('alt="a"')
  })

  test("drops a credential form", () => {
    const out = article('<form action="https://evil.example"><input name="cb"></form>')
    expect(out).not.toContain("<form")
    expect(out).not.toContain("<input")
  })

  test("drops a full-viewport overlay", () => {
    const out = article('<div style="position:fixed;inset:0;background:#fff">x</div>')
    expect(out).not.toContain("style=")
    expect(out).not.toContain("position:fixed")
  })

  test.each([
    ["<script>alert(1)</script>", "script"],
    ['<svg onload="alert(1)"></svg>', "svg"],
    ["<table><tr><td>x</td></tr></table>", "table"],
    ['<video autoplay src="x.mp4"></video>', "video"],
    ["<h1>trop grand</h1>", "h1"],
    ['<iframe src="https://evil.example"></iframe>', "iframe"],
  ])("drops %s", (html, tag) => {
    expect(article(html)).not.toContain(`<${tag}`)
  })

  test("refuses a javascript: link", () => {
    expect(article('<a href="javascript:alert(1)">x</a>')).not.toContain("javascript:")
  })

  /**
   * Relative `src` is how a private-bucket deployment serves every uploaded
   * image, through the `/api/files` proxy. A URI allow-list that named only
   * `https:` and `mailto:` stripped them all — the images vanished from every
   * article — so the profile leaves DOMPurify's default in place.
   */
  test("keeps a same-origin media URL", () => {
    expect(article('<img src="/api/files/cms/x/source.png" alt="a">')).toContain(
      'src="/api/files/cms/x/source.png"',
    )
  })

  test("keeps a link to another page of the site", () => {
    expect(article('<a href="/menu">menu</a>')).toContain('href="/menu"')
  })
})

describe("the rich-text render profile", () => {
  test("keeps inline formatting", () => {
    const html = "<p>Notre <strong>histoire</strong>.</p>"
    expect(richText(html)).toBe(html)
  })

  test("drops images and headings, which belong to the page's own design", () => {
    const out = richText('<h2>Titre</h2><img src="/x.png" alt="a"><p>ok</p>')
    expect(out).not.toContain("<h2")
    expect(out).not.toContain("<img")
    expect(out).toContain("<p>ok</p>")
  })
})
