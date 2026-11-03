/**
 * A published article, at its own URL.
 *
 * `/blog` linked to `/blog/${slug}` for six hard-coded demo posts and this
 * route did not exist, so every card on the public blog was a 404. It is a
 * server component on purpose: a blog earns its keep in search results, and
 * `generateMetadata` cannot run in a client one. The article is fetched twice
 * in the source and once over the wire — `getPublishedArticle` is memoized for
 * the request.
 */
import { cache } from "react"
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import Link from "next/link"
import Image from "next/image"
import { ArrowLeft } from "lucide-react"
import DOMPurify from "isomorphic-dompurify"
import { fetchQuery } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { resolveStorefrontStore } from "@/lib/convex-server"
import { absoluteUrl, buildSeoMetadata } from "@/lib/seo"
import { PRIVATE_PAGE } from "@/lib/crawler-policy"
import { getStorefrontSeoContext } from "@/lib/structured-data"
import {
  JsonLd,
  buildArticleSchema,
  buildBreadcrumbSchema,
  buildFaqSchema,
  extractFaqItems,
} from "@/lib/json-ld"
import { formatArticleDate } from "@/lib/blog/presentation"
import { ARTICLE_SANITIZE_PROFILE } from "@/lib/blog/sanitize-profile"
import { Badge } from "@be-yours/ui"

interface Props {
  params: Promise<{ slug: string }>
}

/**
 * The article at this slug, wherever in the brand it was published.
 *
 * The visitor's own establishment is asked first, because that is whose blog
 * they are reading. Failing that, the deployment's other published
 * establishments are — one owner runs one to many locations off one backend,
 * an article is written for the brand rather than for a branch, and the
 * alternative is a 404 on a link the site itself rendered. The visitor's store
 * is resolved from a cookie the browser may not have sent yet, so without this
 * the first arrival on a shared link is exactly that 404.
 *
 * Memoized for the request: `generateMetadata` and the page body both need it.
 */
const getPublishedArticle = cache(async (slug: string) => {
  try {
    const store = await resolveStorefrontStore()

    if (store) {
      const article = await fetchQuery(api.blog.getArticleBySlug, {
        storeId: store._id as Id<"stores">,
        slug,
      })
      if (article) return article
    }

    const stores = await fetchQuery(api.stores.list, {})
    for (const candidate of stores ?? []) {
      if (candidate._id === store?._id) continue
      const article = await fetchQuery(api.blog.getArticleBySlug, {
        storeId: candidate._id as Id<"stores">,
        slug,
      })
      if (article) return article
    }

    return null
  } catch {
    // A Convex outage, or a deployment with no `NEXT_PUBLIC_CONVEX_URL`. The
    // resolution above throws in both cases and used to do so outside this
    // block, which turned an outage into an unhandled 500 rather than a 404.
    return null
  }
})

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const [article, { brandName, baseUrl }] = await Promise.all([
    getPublishedArticle(slug),
    getStorefrontSeoContext(),
  ])
  const pathname = `/blog/${slug}`

  if (!article) {
    // Nothing at this URL: say so to a crawler rather than let it keep the page.
    return buildSeoMetadata({
      fallbackTitle: "Article introuvable",
      pathname,
      robots: PRIVATE_PAGE,
    })
  }

  const title = article.content.metaTitle || article.content.title
  const description = article.content.metaDescription || article.content.excerpt
  const image = article.ogImage?.url ?? article.coverImage?.url
  const canonical = absoluteUrl(pathname, baseUrl)
  const resolvedImage = image ? absoluteUrl(image, baseUrl) : undefined

  const metadata = await buildSeoMetadata({
    fallbackTitle: title,
    fallbackDescription: description,
    ...(image ? { fallbackOgImage: image } : {}),
    pathname,
    ...(brandName ? { siteName: brandName } : {}),
  })

  // An article is `og:article`, not `og:website`, and the publication date is
  // the field a feed reader and an answer engine both look for.
  return {
    ...metadata,
    openGraph: {
      type: "article",
      title,
      description,
      url: canonical,
      ...(brandName ? { siteName: brandName } : {}),
      ...(article.publishedAt
        ? { publishedTime: new Date(article.publishedAt).toISOString() }
        : {}),
      ...(resolvedImage ? { images: [{ url: resolvedImage }] } : {}),
    },
  }
}

export default async function BlogArticlePage({ params }: Props) {
  const { slug } = await params
  const article = await getPublishedArticle(slug)

  if (!article) notFound()

  // The editor stores Tiptap's HTML and the AI path stores a model's. Neither
  // is trustworthy markup, and this is the only place a visitor's browser is
  // asked to execute it — so it is sanitised here, at the render, every time.
  const content = DOMPurify.sanitize(
    article.content.content ?? "",
    ARTICLE_SANITIZE_PROFILE,
  )

  const { baseUrl, store } = await getStorefrontSeoContext()
  const breadcrumbs = buildBreadcrumbSchema(
    [
      { name: "Accueil", path: "/" },
      { name: "Blog", path: "/blog" },
      { name: article.content.title, path: `/blog/${slug}` },
    ],
    baseUrl,
  )
  const articleSchema = buildArticleSchema(
    {
      title: article.content.title,
      description: article.content.metaDescription || article.content.excerpt,
      imageUrl: article.ogImage?.url ?? article.coverImage?.url,
      publishedAt: article.publishedAt,
      updatedAt: article.content.updatedAt,
      path: `/blog/${slug}`,
    },
    { baseUrl, store },
  )
  // Read from `content`, the markup printed below, and never from the stored
  // HTML: the FAQ may only claim an answer the visitor can read on the page.
  const faqSchema = buildFaqSchema(extractFaqItems(content))

  return (
    <div className="min-h-screen bg-background dark:bg-muted text-foreground dark:text-foreground font-sans">
      <JsonLd data={breadcrumbs} />
      <JsonLd data={articleSchema} />
      <JsonLd data={faqSchema} />
      <article className="mx-auto max-w-3xl px-6 md:px-12 py-16 md:py-24">
        <Link
          href="/blog"
          className="inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-muted-foreground hover:text-accent-foreground dark:hover:text-accent-foreground transition-colors mb-10"
        >
          <ArrowLeft className="h-3 w-3" /> Tous les articles
        </Link>

        {article.category && (
          <Badge className="w-fit mb-4 px-3 py-1 rounded-full font-black tracking-widest uppercase text-[9px] bg-accent text-accent-foreground border-none">
            {article.category.name}
          </Badge>
        )}

        <h1 className="text-4xl md:text-6xl font-black tracking-tighter leading-[0.95] mb-6">
          {article.content.title}
        </h1>

        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-8">
          {[formatArticleDate(article.publishedAt), `${article.readingMinutes} min de lecture`]
            .filter(Boolean)
            .join(" · ")}
        </p>

        {article.content.excerpt && (
          <p className="text-lg md:text-xl text-muted-foreground font-medium leading-relaxed mb-10">
            {article.content.excerpt}
          </p>
        )}

        {article.coverImage?.url && (
          <div className="relative aspect-[16/9] rounded-[2rem] overflow-hidden mb-12 border border-border bg-muted">
            <Image
              src={article.coverImage.url}
              alt={article.coverImage.alt ?? article.content.title}
              fill
              sizes="(max-width: 768px) 100vw, 768px"
              className="object-cover"
              priority
            />
          </div>
        )}

        <div
          className="prose prose-lg dark:prose-invert max-w-none"
          dangerouslySetInnerHTML={{ __html: content }}
        />

        {article.tags.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-12 pt-8 border-t border-border">
            {article.tags.map((tag) => (
              <Badge
                key={tag._id}
                variant="secondary"
                className="text-[9px] font-black uppercase tracking-widest rounded-full px-3 py-1"
              >
                {tag.name}
              </Badge>
            ))}
          </div>
        )}
      </article>
    </div>
  )
}
