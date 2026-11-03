"use client"

import { useState } from "react"
import { useQuery, useMutation } from "convex/react"
import { api } from "@/convex/_generated/api"
import { convexErrorMessage } from "@/lib/convex-error"
import { useAdminStoreId } from "@/lib/admin/hooks"
import { toast } from "sonner"
import { FileText, Plus, FolderOpen, Sparkles } from "lucide-react"
import { Button, Tabs, TabsList, TabsTrigger } from "@be-yours/ui"
import { LoadingState } from "@/components/admin/LoadingState"
import { EmptyState } from "@/components/admin/EmptyState"
import { BlogArticlesTable } from "./BlogArticlesTable"
import { CreateArticleDialog } from "./CreateArticleDialog"
import { BlogCategoryManager } from "./BlogCategoryManager"
import { GenerateArticleDialog } from "./GenerateArticleDialog"
import { DeleteConfirmDialog } from "@/components/admin/DeleteConfirmDialog"
import type { Id } from "@/convex/_generated/dataModel"

type StatusFilter = "all" | "draft" | "scheduled" | "published" | "archived"

export function BlogContent() {
  const storeId = useAdminStoreId()

  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [generateDialogOpen, setGenerateDialogOpen] = useState(false)
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{
    id: Id<"blogArticles">
    title: string
  } | null>(null)

  // Status filter
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")

  // Query with optional status filter
  const articles = useQuery(
    api.blog.listAdminArticles,
    storeId
      ? {
          storeId,
          ...(statusFilter !== "all" && { status: statusFilter }),
        }
      : "skip",
  )

  // Mutations
  const publishArticle = useMutation(api.blog.publishArticle)
  const archiveArticle = useMutation(api.blog.archiveArticle)
  const unarchiveArticle = useMutation(api.blog.unarchiveArticle)
  const deleteArticle = useMutation(api.blog.deleteArticle)

  const [isDeleting, setIsDeleting] = useState(false)

  const handlePublish = async (articleId: Id<"blogArticles">) => {
    try {
      await publishArticle({ articleId })
      toast.success("Article publié")
    } catch (err) {
      toast.error(
        convexErrorMessage(err, {}, "Erreur lors de la publication"),
      )
    }
  }

  const handleArchive = async (articleId: Id<"blogArticles">) => {
    try {
      await archiveArticle({ articleId })
      toast.success("Article archive")
    } catch (err) {
      toast.error(
        convexErrorMessage(err, {}, "Erreur lors de l'archivage"),
      )
    }
  }

  const handleUnarchive = async (articleId: Id<"blogArticles">) => {
    try {
      await unarchiveArticle({ articleId })
      toast.success("Article desarchive")
    } catch (err) {
      toast.error(
        convexErrorMessage(err, {}, "Erreur lors du desarchivage"),
      )
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setIsDeleting(true)
    try {
      await deleteArticle({ articleId: deleteTarget.id })
      toast.success("Article supprimé")
      setDeleteTarget(null)
    } catch (err) {
      toast.error(
        convexErrorMessage(err, {}, "Erreur lors de la suppression"),
      )
    } finally {
      setIsDeleting(false)
    }
  }

  if (!storeId) return null

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Blog</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Gerez vos articles de blog.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCategoryManagerOpen(true)}
          >
            <FolderOpen className="mr-2 h-4 w-4" />
            Catégories
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setGenerateDialogOpen(true)}
          >
            <Sparkles className="mr-2 h-4 w-4" />
            Générer avec l&apos;IA
          </Button>
          <Button size="sm" onClick={() => setCreateDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Nouvel article
          </Button>
        </div>
      </div>

      {/* Status tabs */}
      <Tabs
        value={statusFilter}
        onValueChange={(v) => setStatusFilter(v as StatusFilter)}
      >
        <TabsList>
          <TabsTrigger value="all">Tous</TabsTrigger>
          <TabsTrigger value="draft">Brouillons</TabsTrigger>
          <TabsTrigger value="scheduled">Planifiés</TabsTrigger>
          <TabsTrigger value="published">Publiés</TabsTrigger>
          <TabsTrigger value="archived">Archivés</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Content */}
      {articles === undefined ? (
        <LoadingState variant="table" />
      ) : articles.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="Aucun article"
          description={
            statusFilter === "all"
              ? "Créez votre premier article de blog."
              : "Aucun article avec ce statut."
          }
          action={
            statusFilter === "all"
              ? {
                  label: "Nouvel article",
                  onClick: () => setCreateDialogOpen(true),
                }
              : undefined
          }
        />
      ) : (
        <BlogArticlesTable
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          articles={articles as any}
          onPublish={handlePublish}
          onArchive={handleArchive}
          onUnarchive={handleUnarchive}
          onDelete={(id, title) => setDeleteTarget({ id, title })}
        />
      )}

      {/* Dialogs */}
      <CreateArticleDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onOpenCategoryManager={() => setCategoryManagerOpen(true)}
      />
      <GenerateArticleDialog
        open={generateDialogOpen}
        onOpenChange={setGenerateDialogOpen}
      />
      <BlogCategoryManager
        open={categoryManagerOpen}
        onOpenChange={setCategoryManagerOpen}
      />
      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        onConfirm={handleDelete}
        title="Supprimer l'article"
        description={`Etes-vous sur de vouloir supprimer l'article "${deleteTarget?.title}" ? Cette action est irréversible.`}
        isDeleting={isDeleting}
      />
    </div>
  )
}
