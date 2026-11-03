import { describe, expect, test } from "vitest"
import fs from "node:fs"
import path from "node:path"

/**
 * The public blog must read the database, and its links must go somewhere.
 *
 * Six articles were hard-coded across three storefront files — Unsplash
 * photography, dates in the future — and every card linked to `/blog/${slug}`
 * on a route that did not exist. Twelve dead links on every client site, and
 * `listPublishedArticles` sitting there with no callers.
 *
 * This is a source-level check because that is the shape of the defect: the
 * queries worked, the components did not call them. A behavioural test of a
 * component that renders a constant passes just as happily as one that renders
 * the truth.
 */

const APP_ROOT = path.join(__dirname, "..")

// The menu's interactive half moved to `_components/MenuContent.tsx` when the
// route grew a server shell for its metadata (#168): the blog teaser moved with
// it, and this is where it lives now.
const STOREFRONT_BLOG_SURFACES = [
  "app/(storefront)/blog/_components/BlogContent.tsx",
  "app/(storefront)/menu/_components/MenuContent.tsx",
  "app/(storefront)/_components/HomepageContent.tsx",
]

function read(rel: string): string {
  return fs.readFileSync(path.join(APP_ROOT, rel), "utf8")
}

describe("the public blog is wired to real articles", () => {
  test("an article has its own route", () => {
    expect(fs.existsSync(path.join(APP_ROOT, "app/(storefront)/blog/[slug]/page.tsx"))).toBe(true)
  })

  test("that route resolves the article by slug and renders its metadata", () => {
    const src = read("app/(storefront)/blog/[slug]/page.tsx")
    expect(src).toContain("api.blog.getArticleBySlug")
    expect(src).toContain("generateMetadata")
    expect(src).toContain("notFound")
  })

  test("the route sanitises the stored HTML before handing it to the browser", () => {
    const src = read("app/(storefront)/blog/[slug]/page.tsx")
    expect(src).toContain("DOMPurify.sanitize")
    // The sanitiser is only worth having if nothing bypasses it.
    const injections = src.match(/dangerouslySetInnerHTML/g) ?? []
    expect(injections).toHaveLength(1)
    expect(src).toContain("__html: content")
  })

  test.each(STOREFRONT_BLOG_SURFACES)("%s reads its articles from Convex", (rel) => {
    expect(read(rel)).toContain("api.blog.listPublishedArticles")
  })

  test.each(STOREFRONT_BLOG_SURFACES)("%s carries no hard-coded demo article", (rel) => {
    const src = read(rel)
    for (const ghost of [
      "secrets d",
      "producteurs locaux partenaires",
      "Manger équilibré sans effort",
      "12 Mars",
    ]) {
      expect(src).not.toContain(ghost)
    }
  })

  test.each(STOREFRONT_BLOG_SURFACES)("%s links each card to that article", (rel) => {
    const src = read(rel)
    expect(src).toContain("/blog/${post.slug}")
  })
})

describe("Auto Blog runs on a schedule", () => {
  const crons = fs.readFileSync(path.join(APP_ROOT, "convex/crons.ts"), "utf8")

  test("the planner is registered", () => {
    expect(crons).toContain("internal.blogAutoPlanner.planAutoBlogJobs")
  })

  test("the queue executor is registered", () => {
    expect(crons).toContain("internal.blogAutoGenerate.executeAutoBlogQueue")
  })

  test("both are internal — a cron has no session to authorise", () => {
    expect(crons).not.toMatch(/crons\.(cron|interval)\([^)]*\bapi\./s)
  })
})
