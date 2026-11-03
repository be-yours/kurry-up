"use client"

import { useRouter } from "next/navigation"
import { formatDate } from "@/lib/admin/formatters"
import { Clock, MoreHorizontal, Pencil, Upload, Archive, ArchiveRestore, Trash2 } from "lucide-react"
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@be-yours/ui"
import type { Id } from "@/convex/_generated/dataModel"

interface ArticleRow {
  _id: Id<"blogArticles">
  status: string
  hasUnpublishedChanges: boolean
  scheduledPublishAt?: number
  publishedAt?: number
  draftTitle: string
  draftSlug: string
  category: { _id: Id<"blogCategories">; name: string } | null
  updatedAt: number
}

interface BlogArticlesTableProps {
  articles: ArticleRow[]
  onPublish: (articleId: Id<"blogArticles">) => void
  onArchive: (articleId: Id<"blogArticles">) => void
  onUnarchive: (articleId: Id<"blogArticles">) => void
  onDelete: (articleId: Id<"blogArticles">, title: string) => void
}

function StatusBadges({ article }: { article: ArticleRow }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {article.status === "draft" && (
        <Badge variant="secondary" className="text-[10px]">
          Brouillon
        </Badge>
      )}
      {article.status === "scheduled" && (
        <Badge variant="outline" className="text-[10px]">
          <Clock className="mr-1 h-2.5 w-2.5" />
          Planifié {article.scheduledPublishAt ? formatDate(article.scheduledPublishAt) : ""}
        </Badge>
      )}
      {article.status === "published" && (
        <Badge variant="default" className="text-[10px]">
          Publié
        </Badge>
      )}
      {article.status === "archived" && (
        <Badge variant="outline" className="text-[10px]">
          Archivé
        </Badge>
      )}
      {article.hasUnpublishedChanges && article.status === "published" && (
        <Badge variant="secondary" className="text-[10px]">
          Modifie
        </Badge>
      )}
    </div>
  )
}

export function BlogArticlesTable({
  articles,
  onPublish,
  onArchive,
  onUnarchive,
  onDelete,
}: BlogArticlesTableProps) {
  const router = useRouter()

  return (
    <div className="rounded-lg border overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Titre</TableHead>
            <TableHead className="hidden md:table-cell">Catégorie</TableHead>
            <TableHead>Statut</TableHead>
            <TableHead className="hidden sm:table-cell">Modifié le</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {articles.map((article) => (
            <TableRow
              key={article._id}
              className="cursor-pointer hover:bg-muted/50"
              onClick={() => router.push(`/dashboard/content/blog/${article._id}`)}
            >
              <TableCell>
                <div>
                  <p className="font-medium">{article.draftTitle}</p>
                  <p className="text-xs text-muted-foreground">
                    /{article.draftSlug}
                  </p>
                </div>
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <span className="text-sm text-muted-foreground">
                  {article.category?.name ?? "—"}
                </span>
              </TableCell>
              <TableCell>
                <StatusBadges article={article} />
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                <span className="text-sm text-muted-foreground">
                  {formatDate(article.updatedAt)}
                </span>
              </TableCell>
              <TableCell className="text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation()
                        router.push(`/dashboard/content/blog/${article._id}`)
                      }}
                    >
                      <Pencil className="mr-2 h-4 w-4" />
                      Modifier
                    </DropdownMenuItem>
                    {(article.status === "draft" || article.status === "scheduled") && (
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation()
                          onPublish(article._id)
                        }}
                      >
                        <Upload className="mr-2 h-4 w-4" />
                        Publier
                      </DropdownMenuItem>
                    )}
                    {article.status !== "archived" && (
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation()
                          onArchive(article._id)
                        }}
                      >
                        <Archive className="mr-2 h-4 w-4" />
                        Archiver
                      </DropdownMenuItem>
                    )}
                    {article.status === "archived" && (
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation()
                          onUnarchive(article._id)
                        }}
                      >
                        <ArchiveRestore className="mr-2 h-4 w-4" />
                        Desarchiver
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={(e) => {
                        e.stopPropagation()
                        onDelete(article._id, article.draftTitle)
                      }}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Supprimer
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
