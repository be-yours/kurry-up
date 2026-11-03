"use client"

import { useState, useCallback, useRef, useEffect } from "react"
import { useQuery, useMutation } from "convex/react"
import { api } from "@/convex/_generated/api"
import { convexErrorMessage } from "@/lib/convex-error"
import { useAdminStoreId } from "@/lib/admin/hooks"
import { slugify, formatDate } from "@/lib/admin/formatters"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import Link from "next/link"
import {
  ArrowLeft,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Upload,
  Clock,
  Archive,
  ArchiveRestore,
  Trash2,
  X,
  Plus,
  Eye,
  ChevronDown,
} from "lucide-react"
import {
  Button,
  Badge,
  Input,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@be-yours/ui"
import { LoadingState } from "@/components/admin/LoadingState"
import { DeleteConfirmDialog } from "@/components/admin/DeleteConfirmDialog"
import { BlogRichTextEditor } from "./BlogRichTextEditor"
import { CmsMediaPicker } from "@/components/admin/cms/CmsMediaPicker"
import type { Id } from "@/convex/_generated/dataModel"

interface BlogArticleEditorProps {
  articleId: string
}

type SaveStatus = "idle" | "saving" | "saved" | "error"

const DEBOUNCE_MS = 1500

interface DraftContent {
  title: string
  slug: string
  excerpt: string
  content: string
  coverImageId?: string
  coverImageAlt?: string
  ogImageId?: string
  metaTitle?: string
  metaDescription?: string
}

export function BlogArticleEditor({ articleId }: BlogArticleEditorProps) {
  const storeId = useAdminStoreId()
  const router = useRouter()

  // Convex queries
  const article = useQuery(
    api.blog.getAdminArticle,
    { articleId: articleId as Id<"blogArticles"> },
  )
  const categories = useQuery(
    api.blog.listCategories,
    storeId ? { storeId } : "skip",
  )
  const allTags = useQuery(
    api.blog.listTags,
    storeId ? { storeId } : "skip",
  )

  // Convex mutations
  const saveDraft = useMutation(api.blog.saveDraft)
  const publishArticle = useMutation(api.blog.publishArticle)
  const scheduleArticle = useMutation(api.blog.scheduleArticle)
  const unscheduleArticle = useMutation(api.blog.unscheduleArticle)
  const archiveArticle = useMutation(api.blog.archiveArticle)
  const unarchiveArticle = useMutation(api.blog.unarchiveArticle)
  const deleteArticle = useMutation(api.blog.deleteArticle)
  const createTag = useMutation(api.blog.createTag)
  const deleteTag = useMutation(api.blog.deleteTag)

  // Local state
  const [localDraft, setLocalDraft] = useState<DraftContent>({
    title: "",
    slug: "",
    excerpt: "",
    content: "",
  })
  const [localCategoryId, setLocalCategoryId] = useState<string>("")
  const [localTagIds, setLocalTagIds] = useState<string[]>([])
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle")
  const [hasManuallyEditedSlug, setHasManuallyEditedSlug] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [newTagInput, setNewTagInput] = useState("")
  const [scheduleDate, setScheduleDate] = useState("")

  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false)

  // Media picker states
  const [coverPickerOpen, setCoverPickerOpen] = useState(false)
  const [ogPickerOpen, setOgPickerOpen] = useState(false)

  // Refs for auto-save
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initializedForArticleRef = useRef<string | null>(null)
  const isSavingRef = useRef(false)
  const savingPromiseRef = useRef<Promise<void> | null>(null)
  const lastSavedSnapshotRef = useRef<string>("")

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  // Initialize local state from server (only when articleId changes)
  useEffect(() => {
    if (!article) return
    if (initializedForArticleRef.current === articleId) return

    initializedForArticleRef.current = articleId

    const draft = article.draftContent
    const newDraft: DraftContent = {
      title: draft?.title ?? "",
      slug: draft?.slug ?? "",
      excerpt: draft?.excerpt ?? "",
      content: draft?.content ?? "",
      coverImageId: draft?.coverImageId,
      coverImageAlt: draft?.coverImageAlt,
      ogImageId: draft?.ogImageId,
      metaTitle: draft?.metaTitle,
      metaDescription: draft?.metaDescription,
    }
    setLocalDraft(newDraft)
    setLocalCategoryId(article.draftCategoryId ?? "")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tagIds = article.draftTags?.map((t: any) => t._id) ?? []
    setLocalTagIds(tagIds)
    setHasManuallyEditedSlug(false)

    // Initialize schedule date if scheduled
    if (article.status === "scheduled" && article.scheduledPublishAt) {
      setScheduleDate(timestampToDatetimeLocal(article.scheduledPublishAt))
    }

    // Set initial snapshot
    lastSavedSnapshotRef.current = JSON.stringify({
      draft: newDraft,
      categoryId: article.draftCategoryId ?? "",
      tagIds,
    })
  }, [article, articleId])

  // Build current snapshot for dirty comparison
  const getCurrentSnapshot = useCallback(() => {
    return JSON.stringify({
      draft: localDraft,
      categoryId: localCategoryId,
      tagIds: localTagIds,
    })
  }, [localDraft, localCategoryId, localTagIds])

  // Execute save mutation
  const executeSave = useCallback(
    async (draft: DraftContent, categoryId: string, tagIds: string[]) => {
      if (!storeId) return

      isSavingRef.current = true
      setSaveStatus("saving")

      const promise = (async () => {
        try {
          await saveDraft({
            articleId: articleId as Id<"blogArticles">,
            draftContent: {
              ...draft,
              updatedAt: Date.now(),
            },
            categoryId: categoryId as Id<"blogCategories">,
            tagIds: tagIds as Id<"blogTags">[],
          })
          lastSavedSnapshotRef.current = JSON.stringify({
            draft,
            categoryId,
            tagIds,
          })
          setSaveStatus("saved")
          setTimeout(() => setSaveStatus("idle"), 2000)
        } catch (err) {
          setSaveStatus("error")
          toast.error(
            convexErrorMessage(err, {}, "Erreur de sauvegarde"),
          )
        } finally {
          isSavingRef.current = false
          savingPromiseRef.current = null
        }
      })()

      savingPromiseRef.current = promise
      return promise
    },
    [storeId, articleId, saveDraft],
  )

  // Schedule autosave (debounced)
  const scheduleAutosave = useCallback(
    (draft: DraftContent, categoryId: string, tagIds: string[]) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)

      debounceRef.current = setTimeout(() => {
        executeSave(draft, categoryId, tagIds)
      }, DEBOUNCE_MS)
    },
    [executeSave],
  )

  // Flush pending save before critical actions
  const flushPendingSave = useCallback(async () => {
    // Cancel pending debounce
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }

    // Wait for in-flight save
    if (isSavingRef.current && savingPromiseRef.current) {
      await savingPromiseRef.current
    }

    // Check if dirty
    const currentSnapshot = getCurrentSnapshot()
    if (currentSnapshot !== lastSavedSnapshotRef.current) {
      await executeSave(localDraft, localCategoryId, localTagIds)
    }
  }, [getCurrentSnapshot, executeSave, localDraft, localCategoryId, localTagIds])

  // Handle field changes with autosave
  const handleDraftChange = useCallback(
    (field: keyof DraftContent, value: string | undefined) => {
      setLocalDraft((prev) => {
        const next = { ...prev, [field]: value }
        // Auto-generate slug from title if not manually edited
        if (field === "title" && !hasManuallyEditedSlug) {
          next.slug = slugify(value ?? "")
        }
        scheduleAutosave(next, localCategoryId, localTagIds)
        return next
      })
    },
    [hasManuallyEditedSlug, localCategoryId, localTagIds, scheduleAutosave],
  )

  const handleSlugChange = useCallback(
    (value: string) => {
      setHasManuallyEditedSlug(true)
      setLocalDraft((prev) => {
        const next = { ...prev, slug: value }
        scheduleAutosave(next, localCategoryId, localTagIds)
        return next
      })
    },
    [localCategoryId, localTagIds, scheduleAutosave],
  )

  const handleCategoryChange = useCallback(
    (value: string) => {
      setLocalCategoryId(value)
      scheduleAutosave(localDraft, value, localTagIds)
    },
    [localDraft, localTagIds, scheduleAutosave],
  )

  const handleTagToggle = useCallback(
    (tagId: string) => {
      setLocalTagIds((prev) => {
        const next = prev.includes(tagId)
          ? prev.filter((id) => id !== tagId)
          : [...prev, tagId]
        scheduleAutosave(localDraft, localCategoryId, next)
        return next
      })
    },
    [localDraft, localCategoryId, scheduleAutosave],
  )

  const handleMediaSelect = useCallback(
    (field: "coverImageId" | "ogImageId", mediaId: string) => {
      setLocalDraft((prev) => {
        const next = { ...prev, [field]: mediaId }
        scheduleAutosave(next, localCategoryId, localTagIds)
        return next
      })
    },
    [localCategoryId, localTagIds, scheduleAutosave],
  )

  const handleMediaRemove = useCallback(
    (field: "coverImageId" | "ogImageId") => {
      setLocalDraft((prev) => {
        const next = { ...prev, [field]: undefined }
        scheduleAutosave(next, localCategoryId, localTagIds)
        return next
      })
    },
    [localCategoryId, localTagIds, scheduleAutosave],
  )

  // Create tag with deduplication
  const handleCreateTag = async () => {
    if (!storeId || !newTagInput.trim()) return

    const normalizedSlug = slugify(newTagInput.trim())

    // Check existing tags for duplicate by slug
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existingTag = allTags?.find((t: any) => t.slug === normalizedSlug)
    if (existingTag) {
      // Tag exists — just select it if not already selected
      if (!localTagIds.includes(existingTag._id)) {
        handleTagToggle(existingTag._id)
      }
      setNewTagInput("")
      return
    }

    try {
      const tagId = await createTag({
        storeId,
        name: newTagInput.trim(),
      })
      setLocalTagIds((prev) => {
        const next = [...prev, tagId]
        scheduleAutosave(localDraft, localCategoryId, next)
        return next
      })
      setNewTagInput("")
    } catch (err) {
      toast.error(
        convexErrorMessage(err, {}, "Erreur lors de la création du tag"),
      )
    }
  }

  /**
   * Remove a tag from the establishment altogether (#524).
   *
   * Distinct from un-selecting it, which is the × on a chip above: that takes
   * the tag off THIS article, this removes it from the picker for good. The
   * editor has created tags since it was written and nothing deleted one, so
   * every typo and every abandoned idea stayed in the list for the life of the
   * establishment.
   *
   * Confirmed, because it is not undoable and it reaches every article that
   * carries the tag — the server deletes the joins with it, which is what stops
   * a row pointing at nothing.
   */
  const handleDeleteTag = async (tagId: string, name: string) => {
    if (
      !window.confirm(
        `Supprimer le tag « ${name} » ? Il sera retiré de tous les articles qui le portent.`,
      )
    ) {
      return
    }
    try {
      await deleteTag({ tagId: tagId as Id<"blogTags"> })
      // Locally too: the article's own selection is client state and the server
      // has just removed the join behind it.
      setLocalTagIds((prev) => prev.filter((id) => id !== tagId))
      toast.success(`Tag « ${name} » supprimé`)
    } catch (err) {
      toast.error(
        convexErrorMessage(err, {}, "Erreur lors de la suppression du tag"),
      )
    }
  }

  // Client-side validation before publish — returns all missing fields
  const validateForPublish = (): string[] => {
    const missing: string[] = []
    if (!localDraft.title.trim()) missing.push("Titre")
    if (!localDraft.slug.trim()) missing.push("Slug")
    if (!localDraft.excerpt.trim()) missing.push("Extrait")
    if (!localDraft.coverImageId) missing.push("Image de couverture")
    if (!localDraft.content.trim()) missing.push("Contenu")
    return missing
  }

  const showValidationErrors = (missing: string[]) => {
    toast.error("Éléments manquants pour la publication", {
      description: missing.map((m) => `• ${m}`).join("\n"),
      duration: 6000,
    })
  }

  // Publish
  const handlePublish = async () => {
    const missing = validateForPublish()
    if (missing.length > 0) {
      showValidationErrors(missing)
      return
    }

    setPublishing(true)
    try {
      await flushPendingSave()
      await publishArticle({ articleId: articleId as Id<"blogArticles"> })
      toast.success("Article publié")
    } catch (err) {
      toast.error(
        convexErrorMessage(err, {}, "Erreur lors de la publication"),
      )
    } finally {
      setPublishing(false)
    }
  }

  // Schedule
  const handleSchedule = async () => {
    if (!scheduleDate) return

    const missing = validateForPublish()
    if (missing.length > 0) {
      showValidationErrors(missing)
      return
    }

    const timestamp = new Date(scheduleDate).getTime()
    if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
      toast.error("La date de publication doit être dans le futur")
      return
    }

    try {
      await flushPendingSave()
      await scheduleArticle({
        articleId: articleId as Id<"blogArticles">,
        publishAt: timestamp,
      })
      toast.success("Publication planifiée")
    } catch (err) {
      toast.error(
        convexErrorMessage(err, {}, "Erreur lors de la planification"),
      )
    }
  }

  // Unschedule
  const handleUnschedule = async () => {
    try {
      await unscheduleArticle({ articleId: articleId as Id<"blogArticles"> })
      toast.success("Planification annulée")
      setScheduleDate("")
    } catch (err) {
      toast.error(
        convexErrorMessage(err, {}, "Erreur lors de l'annulation"),
      )
    }
  }

  // Archive / Unarchive
  const handleArchive = async () => {
    try {
      await flushPendingSave()
      await archiveArticle({ articleId: articleId as Id<"blogArticles"> })
      toast.success("Article archive")
    } catch (err) {
      toast.error(
        convexErrorMessage(err, {}, "Erreur lors de l'archivage"),
      )
    }
  }

  const handleUnarchive = async () => {
    try {
      await unarchiveArticle({ articleId: articleId as Id<"blogArticles"> })
      toast.success("Article desarchive")
    } catch (err) {
      toast.error(
        convexErrorMessage(err, {}, "Erreur lors du desarchivage"),
      )
    }
  }

  // Delete
  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      await deleteArticle({ articleId: articleId as Id<"blogArticles"> })
      toast.success("Article supprimé")
      router.push("/dashboard/content/blog")
    } catch (err) {
      toast.error(
        convexErrorMessage(err, {}, "Erreur lors de la suppression"),
      )
    } finally {
      setIsDeleting(false)
    }
  }

  // Loading states
  if (!storeId) return null

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

  // Resolve media URLs for display
  const coverImageUrl =
    article.draftMedia?.coverImage?.sourceUrl ??
    article.draftMedia?.coverImage?.url ??
    null
  const ogImageUrl =
    article.draftMedia?.ogImage?.url ?? null

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-3">
        {/* Row 1: Back button + actions */}
        <div className="flex items-center justify-between">
          <Link href="/dashboard/content/blog">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>

          <div className="flex flex-wrap items-center gap-2">
          {/* Save status */}
          {saveStatus === "saving" && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Sauvegarde...
            </span>
          )}
          {saveStatus === "saved" && (
            <span className="flex items-center gap-1 text-xs text-success">
              <CheckCircle2 className="h-3 w-3" />
              Sauvegarde
            </span>
          )}
          {saveStatus === "error" && (
            <span className="flex items-center gap-1 text-xs text-destructive">
              <AlertTriangle className="h-3 w-3" />
              Erreur
            </span>
          )}

          {/* Status badges */}
          {article.status === "draft" && (
            <Badge variant="secondary" className="text-xs">
              Brouillon
            </Badge>
          )}
          {article.status === "scheduled" && (
            <Badge variant="outline" className="text-xs">
              <Clock className="mr-1 h-3 w-3" />
              Planifié
            </Badge>
          )}
          {article.status === "published" && (
            <Badge variant="default" className="text-xs">
              Publié
            </Badge>
          )}
          {article.status === "archived" && (
            <Badge variant="outline" className="text-xs">
              Archivé
            </Badge>
          )}
          {article.hasUnpublishedChanges && article.status === "published" && (
            <Badge variant="secondary" className="text-xs">
              Modifie
            </Badge>
          )}

          {/* Preview button */}
          <Link href={`/preview/blog/${articleId}`} target="_blank">
            <Button variant="outline" size="sm">
              <Eye className="mr-2 h-4 w-4" />
              Aperçu
            </Button>
          </Link>

          {/* Publication dropdown */}
          <div className="flex items-center">
            {/* Primary action */}
            {article.status === "archived" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={handleUnarchive}
                className="rounded-r-none border-r-0"
              >
                <ArchiveRestore className="mr-2 h-4 w-4" />
                Desarchiver
              </Button>
            ) : (
              <Button
                onClick={handlePublish}
                disabled={publishing || saveStatus === "saving"}
                size="sm"
                className="rounded-r-none border-r-0"
              >
                {publishing ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                {article.status === "published" ? "Republier" : "Publier"}
              </Button>
            )}

            {/* Dropdown chevron */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant={article.status === "archived" ? "outline" : "default"}
                  className="rounded-l-none px-2"
                  disabled={publishing}
                >
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {/* Publier maintenant */}
                {(article.status === "draft" || article.status === "scheduled") && (
                  <DropdownMenuItem onClick={handlePublish}>
                    <Upload className="mr-2 h-4 w-4" />
                    Publier maintenant
                  </DropdownMenuItem>
                )}

                {/* Planifier */}
                {article.status !== "archived" && article.status !== "published" && (
                  <DropdownMenuItem onClick={() => setScheduleDialogOpen(true)}>
                    <Clock className="mr-2 h-4 w-4" />
                    Planifier...
                  </DropdownMenuItem>
                )}

                {/* Annuler planification */}
                {article.status === "scheduled" && (
                  <DropdownMenuItem onClick={handleUnschedule}>
                    <X className="mr-2 h-4 w-4" />
                    Annuler la planification
                  </DropdownMenuItem>
                )}

                <DropdownMenuSeparator />

                {/* Archiver / Desarchiver */}
                {article.status !== "archived" ? (
                  <DropdownMenuItem onClick={handleArchive}>
                    <Archive className="mr-2 h-4 w-4" />
                    Archiver
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={handleUnarchive}>
                    <ArchiveRestore className="mr-2 h-4 w-4" />
                    Desarchiver
                  </DropdownMenuItem>
                )}

                <DropdownMenuSeparator />

                {/* Supprimer */}
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setDeleteDialogOpen(true)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Supprimer
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          </div>
        </div>

        {/* Row 2: Title + slug */}
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold">
            {localDraft.title || "Sans titre"}
          </h1>
          <p className="text-sm text-muted-foreground truncate">
            /{localDraft.slug || "..."}
          </p>
        </div>
      </div>

      {/* Editor Tabs */}
      <Tabs defaultValue="content">
        <TabsList>
          <TabsTrigger value="content">Contenu</TabsTrigger>
          <TabsTrigger value="media">Media</TabsTrigger>
          <TabsTrigger value="seo">SEO</TabsTrigger>
          <TabsTrigger value="tags">Catégories & Tags</TabsTrigger>
          <TabsTrigger value="publication">Publication</TabsTrigger>
        </TabsList>

        {/* Tab: Contenu */}
        <TabsContent value="content" className="space-y-4 mt-4">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="article-editor-title">
              Titre
            </label>
            <Input
              id="article-editor-title"
              value={localDraft.title}
              onChange={(e) => handleDraftChange("title", e.target.value)}
              placeholder="Titre de l'article"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="article-editor-slug">
              Slug
            </label>
            <Input
              id="article-editor-slug"
              value={localDraft.slug}
              onChange={(e) => handleSlugChange(e.target.value)}
              placeholder="url-de-l-article"
            />
            <p className="text-xs text-muted-foreground">
              URL de l&apos;article. Généré automatiquement depuis le titre.
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="article-editor-excerpt">
              Extrait
            </label>
            <Textarea
              id="article-editor-excerpt"
              value={localDraft.excerpt}
              onChange={(e) => handleDraftChange("excerpt", e.target.value)}
              placeholder="Résumé court de l'article (affiche dans les listes)"
              maxLength={300}
              rows={3}
            />
            <p className="text-xs text-muted-foreground">
              {localDraft.excerpt.length}/300 caracteres
            </p>
          </div>

          <div className="space-y-2">
            {/* Heads a rich text editor, which htmlFor cannot target. */}
            <p className="text-sm font-medium">Contenu</p>
            <BlogRichTextEditor
              value={localDraft.content}
              onChange={(html) => handleDraftChange("content", html)}
              placeholder="Redigez votre article..."
            />
          </div>
        </TabsContent>

        {/* Tab: Media */}
        <TabsContent value="media" className="space-y-6 mt-4">
          {/* Cover Image */}
          <div className="space-y-2">
            {/* Heads an upload block, not a control. */}
            <p className="text-sm font-medium">Image de couverture</p>
            {coverImageUrl ? (
              <div className="relative rounded-md border overflow-hidden max-w-md">
                <img
                  src={coverImageUrl}
                  alt={localDraft.coverImageAlt ?? ""}
                  className="w-full h-auto object-cover max-h-48"
                />
                <Button
                  variant="destructive"
                  size="sm"
                  className="absolute top-2 right-2"
                  onClick={() => handleMediaRemove("coverImageId")}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                onClick={() => setCoverPickerOpen(true)}
              >
                Choisir une image
              </Button>
            )}
          </div>

          {localDraft.coverImageId && (
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="article-editor-cover-alt">
                Texte alternatif (alt)
              </label>
              <Input
                id="article-editor-cover-alt"
                value={localDraft.coverImageAlt ?? ""}
                onChange={(e) =>
                  handleDraftChange("coverImageAlt", e.target.value)
                }
                placeholder="Description de l'image pour l'accessibilite"
              />
            </div>
          )}

          {/* OG Image */}
          <div className="space-y-2">
            {/* Heads an upload block, not a control. */}
            <p className="text-sm font-medium">
              Image Open Graph (partage reseaux sociaux)
            </p>
            {ogImageUrl ? (
              <div className="relative rounded-md border overflow-hidden max-w-md">
                <img
                  src={ogImageUrl}
                  alt="OG"
                  className="w-full h-auto object-cover max-h-48"
                />
                <Button
                  variant="destructive"
                  size="sm"
                  className="absolute top-2 right-2"
                  onClick={() => handleMediaRemove("ogImageId")}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                onClick={() => setOgPickerOpen(true)}
              >
                Choisir une image
              </Button>
            )}
          </div>
        </TabsContent>

        {/* Tab: SEO */}
        <TabsContent value="seo" className="space-y-4 mt-4">
          <p className="text-sm text-muted-foreground">
            Si vides, le titre et l&apos;extrait de l&apos;article seront utilises par defaut.
          </p>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="article-editor-meta-title">
              Meta titre
            </label>
            <Input
              id="article-editor-meta-title"
              value={localDraft.metaTitle ?? ""}
              onChange={(e) => handleDraftChange("metaTitle", e.target.value)}
              placeholder={localDraft.title || "Titre pour les moteurs de recherche"}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="article-editor-meta-description">
              Meta description
            </label>
            <Textarea
              id="article-editor-meta-description"
              value={localDraft.metaDescription ?? ""}
              onChange={(e) =>
                handleDraftChange("metaDescription", e.target.value)
              }
              placeholder={localDraft.excerpt ? localDraft.excerpt.slice(0, 160) : "Description pour les moteurs de recherche"}
              maxLength={160}
              rows={3}
            />
            <p className="text-xs text-muted-foreground">
              {(localDraft.metaDescription ?? "").length}/160 caracteres
            </p>
          </div>
        </TabsContent>

        {/* Tab: Categories & Tags */}
        <TabsContent value="tags" className="space-y-6 mt-4">
          {/* Category */}
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="article-editor-category">
              Catégorie
            </label>
            {categories && categories.length > 0 ? (
              <Select
                value={localCategoryId}
                onValueChange={handleCategoryChange}
              >
                <SelectTrigger id="article-editor-category">
                  <SelectValue placeholder="Choisir une catégorie" />
                </SelectTrigger>
                <SelectContent>
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  {categories.map((cat: any) => (
                    <SelectItem key={cat._id} value={cat._id}>
                      {cat.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-sm text-muted-foreground">
                Aucune catégorie disponible.
              </p>
            )}
          </div>

          {/* Tags */}
          <div className="space-y-2">
            {/* Heads the selected-tag chips and the picker below them. */}
            <p className="text-sm font-medium">Tags</p>

            {/* Selected tags */}
            <div className="flex flex-wrap gap-1.5">
              {localTagIds.map((tagId) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const tag = allTags?.find((t: any) => t._id === tagId)
                if (!tag) return null
                return (
                  <Badge key={tagId} variant="secondary" className="text-xs">
                    {tag.name}
                    <button
                      className="ml-1 inline-flex size-6 items-center justify-center hover:text-destructive"
                      onClick={() => handleTagToggle(tagId)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                )
              })}
            </div>

            {/* Available tags */}
            <div className="flex flex-wrap gap-1.5">
              {allTags
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ?.filter((t: any) => !localTagIds.includes(t._id))
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .map((tag: any) => (
                  <Badge
                    key={tag._id}
                    variant="outline"
                    className="text-xs hover:bg-muted"
                  >
                    {/* Two controls, because they do different things: the name
                        adds the tag to this article, the bin removes it from
                        the establishment. Only on the UNSELECTED chips — a tag
                        already on this article is removed from it first, with
                        the × above, so a single click cannot delete a tag the
                        author was using. */}
                    <button
                      type="button"
                      className="inline-flex cursor-pointer items-center"
                      onClick={() => handleTagToggle(tag._id)}
                    >
                      <Plus className="mr-1 h-2.5 w-2.5" aria-hidden="true" />
                      {tag.name}
                    </button>
                    <button
                      type="button"
                      aria-label={`Supprimer le tag ${tag.name}`}
                      className="ml-1 inline-flex size-6 items-center justify-center hover:text-destructive"
                      onClick={() => void handleDeleteTag(tag._id, tag.name)}
                    >
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </Badge>
                ))}
            </div>

            {/* Create new tag */}
            <div className="flex gap-2">
              <Input
                value={newTagInput}
                onChange={(e) => setNewTagInput(e.target.value)}
                placeholder="Nouveau tag..."
                className="max-w-xs"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    handleCreateTag()
                  }
                }}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={handleCreateTag}
                disabled={!newTagInput.trim()}
              >
                Ajouter
              </Button>
            </div>
          </div>
        </TabsContent>

        {/* Tab: Publication */}
        <TabsContent value="publication" className="space-y-6 mt-4">
          {/* Statut actuel */}
          <div className="rounded-lg border p-4">
            <p className="text-sm font-medium">Statut actuel</p>
            <p className="text-sm text-muted-foreground mt-1">
              {article.status === "draft" && "Brouillon — non publié"}
              {article.status === "scheduled" &&
                `Planifié pour le ${article.scheduledPublishAt ? formatDate(article.scheduledPublishAt) : "..."}`}
              {article.status === "published" &&
                `Publié le ${article.publishedAt ? formatDate(article.publishedAt) : "..."}`}
              {article.status === "archived" && "Archivé"}
            </p>
          </div>

          {/* Publier maintenant */}
          {(article.status === "draft" || article.status === "scheduled") && (
            <div className="rounded-lg border p-4 space-y-3">
              <div>
                <p className="text-sm font-medium flex items-center gap-2">
                  <Upload className="h-4 w-4" />
                  Publier maintenant
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  L&apos;article sera immediatement visible sur votre site.
                </p>
              </div>
              <Button onClick={handlePublish} disabled={publishing}>
                {publishing ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                Publier
              </Button>
            </div>
          )}

          {/* Schedule publication */}
          {article.status !== "archived" && article.status !== "published" && (
            <div className="rounded-lg border p-4 space-y-3">
              <div>
                <p className="text-sm font-medium flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  Planifier la publication
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Choisissez une date et heure pour publier automatiquement l&apos;article.
                </p>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="datetime-local"
                  value={scheduleDate}
                  onChange={(e) => setScheduleDate(e.target.value)}
                  className="rounded-md border px-3 py-2 text-sm bg-background"
                />
                <Button
                  variant="outline"
                  onClick={handleSchedule}
                  disabled={!scheduleDate}
                >
                  <Clock className="mr-2 h-4 w-4" />
                  Planifier
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Heure locale
              </p>
            </div>
          )}

          {/* Annuler planification */}
          {article.status === "scheduled" && (
            <div className="rounded-lg border border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950 p-4 space-y-3">
              <div>
                <p className="text-sm font-medium">Publication planifiée</p>
                <p className="text-xs text-muted-foreground mt-1">
                  L&apos;article sera publié automatiquement le{" "}
                  {article.scheduledPublishAt
                    ? formatDate(article.scheduledPublishAt)
                    : "..."}
                  .
                </p>
              </div>
              <Button variant="outline" onClick={handleUnschedule}>
                Annuler la planification
              </Button>
            </div>
          )}

          {/* Archiver / Desarchiver */}
          <div className="rounded-lg border p-4 space-y-3">
            <div>
              <p className="text-sm font-medium flex items-center gap-2">
                <Archive className="h-4 w-4" />
                Archivage
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {article.status === "archived"
                  ? "Cet article est archivé et n'est plus visible."
                  : "Archivez l'article pour le retirer de votre site sans le supprimer."}
              </p>
            </div>
            {article.status !== "archived" ? (
              <Button variant="outline" onClick={handleArchive}>
                <Archive className="mr-2 h-4 w-4" />
                Archiver
              </Button>
            ) : (
              <Button variant="outline" onClick={handleUnarchive}>
                <ArchiveRestore className="mr-2 h-4 w-4" />
                Desarchiver
              </Button>
            )}
          </div>

          {/* Zone danger — Supprimer */}
          <div className="rounded-lg border border-destructive/30 p-4 space-y-3">
            <div>
              <p className="text-sm font-medium text-destructive flex items-center gap-2">
                <Trash2 className="h-4 w-4" />
                Zone de danger
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                La suppression est irreversible. Toutes les donnees de l&apos;article seront perdues.
              </p>
            </div>
            <Button
              variant="destructive"
              onClick={() => setDeleteDialogOpen(true)}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Supprimer l&apos;article
            </Button>
          </div>
        </TabsContent>
      </Tabs>

      {/* Media Pickers */}
      <CmsMediaPicker
        open={coverPickerOpen}
        onOpenChange={setCoverPickerOpen}
        kindFilter="image"
        onSelect={(media) => {
          handleMediaSelect("coverImageId", media.mediaId)
          setCoverPickerOpen(false)
        }}
      />
      <CmsMediaPicker
        open={ogPickerOpen}
        onOpenChange={setOgPickerOpen}
        kindFilter="image"
        onSelect={(media) => {
          handleMediaSelect("ogImageId", media.mediaId)
          setOgPickerOpen(false)
        }}
      />

      {/* Schedule Dialog */}
      <Dialog open={scheduleDialogOpen} onOpenChange={setScheduleDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Planifier la publication</DialogTitle>
            <DialogDescription>
              Choisissez la date et l&apos;heure de publication automatique.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="article-editor-schedule">
                Date et heure
              </label>
              <input
                id="article-editor-schedule"
                type="datetime-local"
                value={scheduleDate}
                onChange={(e) => setScheduleDate(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm bg-background"
              />
              <p className="text-xs text-muted-foreground">Heure locale</p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setScheduleDialogOpen(false)}
            >
              Annuler
            </Button>
            <Button
              onClick={async () => {
                await handleSchedule()
                setScheduleDialogOpen(false)
              }}
              disabled={!scheduleDate}
            >
              <Clock className="mr-2 h-4 w-4" />
              Planifier
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <DeleteConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDelete}
        title="Supprimer l'article"
        description={`Etes-vous sur de vouloir supprimer "${localDraft.title}" ? Cette action est irréversible.`}
        isDeleting={isDeleting}
      />
    </div>
  )
}

/** Convert timestamp to datetime-local compatible string (local timezone) */
function timestampToDatetimeLocal(timestamp: number): string {
  const d = new Date(timestamp)
  const offset = d.getTimezoneOffset()
  const local = new Date(d.getTime() - offset * 60000)
  return local.toISOString().slice(0, 16)
}
