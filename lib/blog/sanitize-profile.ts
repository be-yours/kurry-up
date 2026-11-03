/**
 * The render-time half of the allow-list in
 * `@be-yours/convex-functions/htmlSanitize`.
 *
 * DOMPurify's default is much wider than what may be *written*: it keeps
 * `<form>`, `<table>`, `<svg>`, `<video autoplay>` and `style`. None of that is
 * script execution, but a credential form or a fixed full-viewport overlay on
 * the restaurant's own domain is not something the second pass should let
 * through either — and the rows this pass exists for are exactly the legacy
 * ones written before anything sanitised on the way in.
 *
 * The two lists are kept side by side deliberately: DOMPurify parses in the
 * browser and `sanitize-html` in a Convex isolate, so they cannot be one
 * module, but they can name the same tags. Not `as const`: DOMPurify's config
 * declares mutable `string[]`, and a readonly tuple is not assignable to it.
 *
 * `ALLOWED_URI_REGEXP` is deliberately left at DOMPurify's default. A custom
 * one naming only `https?:` and `mailto:` was tried and was wrong twice: it
 * stripped `src="/api/files/…"`, which is how every uploaded image on a
 * private-bucket deployment is served, and it did not stop `data:` anyway —
 * DOMPurify permits that on `img` through a separate path. `javascript:` and
 * `vbscript:` are refused by the default, and the write pass refuses `data:`
 * outright for anything stored from here on.
 */
export const ARTICLE_SANITIZE_PROFILE = {
  ALLOWED_TAGS: [
    "p", "h2", "h3", "h4",
    "strong", "em", "u", "s",
    "ul", "ol", "li",
    "a", "img",
    "blockquote", "hr", "br",
  ],
  ALLOWED_ATTR: ["href", "target", "rel", "src", "alt", "class"],
}

/** The narrower list for CMS rich-text blocks: no images, no headings. */
export const RICH_TEXT_SANITIZE_PROFILE = {
  ALLOWED_TAGS: [
    "p", "strong", "em", "u", "s",
    "ul", "ol", "li",
    "a", "blockquote", "br",
  ],
  ALLOWED_ATTR: ["href", "target", "rel"],
}
