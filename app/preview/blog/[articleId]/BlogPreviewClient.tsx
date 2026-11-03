"use client"

import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import { formatDate } from "@/lib/admin/formatters"
import DOMPurify from "isomorphic-dompurify"
import { ARTICLE_SANITIZE_PROFILE } from "@/lib/blog/sanitize-profile"
import Link from "next/link"
import { ArrowLeft, Eye } from "lucide-react"
import { Badge, Button } from "@be-yours/ui"
import { LoadingState } from "@/components/admin/LoadingState"
import type { Id } from "@/convex/_generated/dataModel"

interface BlogPreviewClientProps {
  articleId: string
}

const STATUS_LABELS: Record<string, string> = {
  draft: "Brouillon",
  scheduled: "Planifié",
  published: "Publié",
  archived: "Archivé",
}

export function BlogPreviewClient({ articleId }: BlogPreviewClientProps) {
  const article = useQuery(api.blog.getAdminArticle, {
    articleId: articleId as Id<"blogArticles">,
  })

  if (article === undefined) {
    return <LoadingState variant="form" />
  }

  if (article === null) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        Article non trouve.
      </div>
    )
  }

  const draft = article.draftContent
  const coverImageUrl =
    article.draftMedia?.coverImage?.sourceUrl ??
    article.draftMedia?.coverImage?.url ??
    null
  const categoryName = article.draftCategory?.name ?? null
  const tags = article.draftTags ?? []

  const sanitizedContent = draft?.content
    ? DOMPurify.sanitize(draft.content, ARTICLE_SANITIZE_PROFILE)
    : ""

  return (
    <div className="min-h-screen bg-background">
      {/* Preview banner */}
      <div className="sticky top-0 z-50 border-b bg-warning/10">
        <div className="mx-auto max-w-4xl flex items-center justify-between px-4 py-2">
          <div className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-warning" />
            <span className="text-sm font-medium text-warning">
              Aperçu
            </span>
            <Badge variant="outline" className="text-xs">
              {STATUS_LABELS[article.status] ?? article.status}
            </Badge>
          </div>
          <Link href={`/dashboard/content/blog/${articleId}`}>
            <Button variant="ghost" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Retour a l&apos;editeur
            </Button>
          </Link>
        </div>
      </div>

      {/* Article content */}
      <article className="mx-auto max-w-3xl px-4 py-10 space-y-8">
        {/* Category */}
        {categoryName && (
          <p className="text-sm font-medium text-primary-ink uppercase tracking-wider">
            {categoryName}
          </p>
        )}

        {/* Title */}
        <h1 className="text-3xl sm:text-4xl font-bold leading-tight">
          {draft?.title || "Sans titre"}
        </h1>

        {/* Excerpt */}
        {draft?.excerpt && (
          <p className="text-lg text-muted-foreground leading-relaxed">
            {draft.excerpt}
          </p>
        )}

        {/* Tags */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            {tags.map((tag: any) => (
              <Badge key={tag._id} variant="secondary" className="text-xs">
                {tag.name}
              </Badge>
            ))}
          </div>
        )}

        {/* Cover image */}
        {coverImageUrl && (
          <div className="rounded-lg overflow-hidden border">
            <img
              src={coverImageUrl}
              alt={draft?.coverImageAlt ?? draft?.title ?? ""}
              className="w-full h-auto object-cover"
            />
          </div>
        )}

        {/* Content */}
        {sanitizedContent && (
          <div
            className="prose prose-lg dark:prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: sanitizedContent }}
          />
        )}

        {/* Date info */}
        <div className="pt-8 border-t text-sm text-muted-foreground">
          {article.publishedAt && (
            <p>Publié le {formatDate(article.publishedAt)}</p>
          )}
          {article.updatedAt && (
            <p>Derniere modification le {formatDate(article.updatedAt)}</p>
          )}
        </div>
      </article>
    </div>
  )
}
