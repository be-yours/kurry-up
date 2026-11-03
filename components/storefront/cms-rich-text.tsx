"use client"

import DOMPurify from "isomorphic-dompurify"
import { RICH_TEXT_SANITIZE_PROFILE } from "@/lib/blog/sanitize-profile"

/**
 * Renders a CMS `richtext` field on the public site.
 *
 * Four CMS fields are declared `type: "richtext"` — `about.story.description`,
 * `sign-in.hero.subtitle`, `sign-up.hero.subtitle` and
 * `game.instructions.description`. The admin editor behind them is Tiptap, and
 * what it stores is `editor.getHTML()`. Every one of those values was then
 * handed to React as a plain child, so a visitor read the markup: the About
 * page printed `<p>Notre aventure…<strong>` on screen, tags and all.
 *
 * Rendering it as HTML is the half of the fix that shows. This is the other
 * half. Sanitising happens twice, deliberately:
 *
 *   - on write, in `saveDraftBlockCore`, with `sanitizeRichTextHtml`. That is
 *     the authoritative allow-list and it is what stops hostile markup ever
 *     reaching the table.
 *   - here, on every render, because rows written before that guard existed are
 *     still in the database, and because two other paths write these fields
 *     without going through the editor: the GPT auto-translation
 *     (`cmsAutoTranslate`) and the seed (`cmsSeed`).
 *
 * Same library and same shape as the blog renderer in
 * `app/preview/blog/[articleId]/BlogPreviewClient.tsx`.
 */
interface CmsRichTextProps {
  /** The stored `richtext` value, or the component's code fallback. */
  html: string
  /**
   * Typography for the container. Each page owns its own type scale, so there
   * is no single right answer; the default is the house `prose` container the
   * blog uses.
   */
  className?: string
}

export function CmsRichText({ html, className }: CmsRichTextProps) {
  return (
    <div
      className={className ?? "prose dark:prose-invert max-w-none"}
      dangerouslySetInnerHTML={{
        __html: DOMPurify.sanitize(html, RICH_TEXT_SANITIZE_PROFILE),
      }}
    />
  )
}
