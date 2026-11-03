"use client"

import { useState, useCallback, useRef, useMemo } from "react"
import { useQuery, useMutation, useAction } from "convex/react"
import { api } from "@/convex/_generated/api"
import { convexErrorMessage } from "@/lib/convex-error"
import { useAdminStoreId } from "@/lib/admin/hooks"
import { toast } from "sonner"
import imageCompression from "browser-image-compression"
import {
  Upload,
  Search,
  Trash2,
  Image as ImageIcon,
  Video,
  FileText,
  Loader2,
  X,
  AlertCircle,
  Grid3X3,
  Info,
  Play,
  Copy,
  CheckCheck,
} from "lucide-react"
import {
  Button,
  Input,
  Badge,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@be-yours/ui"
import { LoadingState } from "@/components/admin/LoadingState"
import { EmptyState } from "@/components/admin/EmptyState"
import { DeleteConfirmDialog } from "@/components/admin/DeleteConfirmDialog"
import { validateMediaUpload, getMediaKind } from "@be-yours/cms"
import { uploadWithProgress } from "@/lib/cms/upload-with-progress"
import type { Id } from "@/convex/_generated/dataModel"

type KindFilter = "all" | "image" | "video" | "file"
type FolderFilter = "all" | "products" | "blogs" | "blog-auto" | "storefront" | "cms" | "email" | "avatars"

const FOLDER_LABELS: Record<FolderFilter, string> = {
  all: "Tous les dossiers",
  products: "Produits",
  blogs: "Blog",
  "blog-auto": "Blog IA",
  storefront: "Vitrine",
  cms: "CMS",
  email: "Email",
  avatars: "Avatars",
}

interface MediaItem {
  _id: Id<"cmsMedia">
  kind: "image" | "video" | "file"
  status: "processing" | "ready" | "failed"
  filename: string
  mimeType: string
  size: number
  url?: string
  sourceUrl?: string
  thumbnailUrl?: string
  variants?: {
    thumb?: { url: string; width: number; height: number }
    card?: { url: string; width: number; height: number }
  }
  width?: number
  height?: number
  usageCount: number
  uploadedAt: number
  errorCode?: string
  errorMessage?: string
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

const ICON_BY_KIND = {
  image: ImageIcon,
  video: Video,
  file: FileText,
}

const MEDIA_PAGE_SIZE = 24

function getPageNumbers(current: number, total: number): (number | "ellipsis")[] {
  if (total <= 5) {
    return Array.from({ length: total }, (_, i) => i + 1)
  }
  const pages: (number | "ellipsis")[] = [1]
  if (current > 3) pages.push("ellipsis")
  const start = Math.max(2, current - 1)
  const end = Math.min(total - 1, current + 1)
  for (let i = start; i <= end; i++) pages.push(i)
  if (current < total - 2) pages.push("ellipsis")
  pages.push(total)
  return pages
}

export function CmsMediaLibrary() {
  const storeId = useAdminStoreId()
  const [kindFilter, setKindFilter] = useState<KindFilter>("all")
  const [folderFilter, setFolderFilter] = useState<FolderFilter>("all")
  const [search, setSearch] = useState("")
  const [currentPage, setCurrentPage] = useState(1)
  const [selectedMedia, setSelectedMedia] = useState<MediaItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<MediaItem | null>(null)
  const [copied, setCopied] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadFileName, setUploadFileName] = useState("")
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const mediaList = useQuery(
    api.cmsMedia.listMedia,
    storeId
      ? {
          storeId,
          ...(kindFilter !== "all" && { kind: kindFilter }),
          ...(folderFilter !== "all" && { folder: folderFilter }),
          ...(search && { search }),
        }
      : "skip",
  )
  const createMedia = useMutation(api.cmsMedia.createMedia)
  const deleteMedia = useMutation(api.cmsMedia.deleteMedia)
  const getPresignedUrlForMedia = useAction(api.storageUpload.getPresignedUrlForMedia)
  const confirmUpload = useAction(api.cmsMediaConfirmUpload.confirmUpload)
  const uploadSvg = useAction(api.cmsSvgUpload.uploadSvg)

  const totalItems = mediaList?.length ?? 0
  const totalPages = Math.max(1, Math.ceil(totalItems / MEDIA_PAGE_SIZE))
  const safePage = Math.min(currentPage, totalPages)

  const paginatedMedia = useMemo(() => {
    if (!mediaList) return []
    const start = (safePage - 1) * MEDIA_PAGE_SIZE
    return mediaList.slice(start, start + MEDIA_PAGE_SIZE)
  }, [mediaList, safePage])

  const handleCancelUpload = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const handleUpload = useCallback(
    async (file: File) => {
      if (!storeId) return

      const validation = validateMediaUpload(file.name, file.type, file.size)
      if (!validation.valid) {
        toast.error(validation.error?.message ?? "Fichier invalide")
        return
      }

      setUploading(true)
      setUploadProgress(0)
      setUploadFileName(file.name)
      const abort = new AbortController()
      abortRef.current = abort

      try {
        const isSvg = file.type === "image/svg+xml"
        const isProcessableImage =
          validation.kind === "image" && !isSvg

        if (isSvg) {
          const mediaId = await createMedia({
            storeId,
            kind: "image",
            filename: file.name,
            mimeType: file.type,
            size: file.size,
            uploadedBy: "admin",
          })
          const svgContent = await file.text()
          await uploadSvg({ storeId, mediaId, svgContent, filename: file.name })
        } else if (isProcessableImage) {
          setUploadProgress(0)
          const compressed = await imageCompression(file, {
            maxWidthOrHeight: 2048,
            useWebWorker: true,
          })
          const mediaId = await createMedia({
            storeId,
            kind: validation.kind!,
            filename: file.name,
            mimeType: compressed.type,
            size: compressed.size,
            uploadedBy: "admin",
          })
          const { uploadUrl } = await getPresignedUrlForMedia({ mediaId })
          await uploadWithProgress({
            url: uploadUrl,
            body: compressed,
            contentType: compressed.type,
            signal: abort.signal,
            onProgress: (e) => setUploadProgress(e.percent),
          })
          await confirmUpload({ mediaId })
        } else {
          const mediaId = await createMedia({
            storeId,
            kind: validation.kind!,
            filename: file.name,
            mimeType: file.type,
            size: file.size,
            uploadedBy: "admin",
          })
          const { uploadUrl } = await getPresignedUrlForMedia({ mediaId })
          await uploadWithProgress({
            url: uploadUrl,
            body: file,
            contentType: file.type,
            signal: abort.signal,
            onProgress: (e) => setUploadProgress(e.percent),
          })
          await confirmUpload({ mediaId })
        }

        toast.success(`"${file.name}" uploadé avec succès`)
      } catch (err) {
        if (err instanceof Error && err.message === "Upload annulé") {
          toast.info("Upload annulé")
        } else {
          toast.error(
            convexErrorMessage(err, {}, "Erreur lors de l'upload"),
          )
        }
      } finally {
        setUploading(false)
        setUploadProgress(0)
        setUploadFileName("")
        abortRef.current = null
      }
    },
    [storeId, createMedia, getPresignedUrlForMedia, confirmUpload, uploadSvg],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const file = e.dataTransfer.files[0]
      if (file) handleUpload(file)
    },
    [handleUpload],
  )

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) handleUpload(file)
      e.target.value = ""
    },
    [handleUpload],
  )

  const handleDelete = useCallback(async () => {
    if (!storeId || !deleteTarget) return
    try {
      await deleteMedia({ storeId, mediaId: deleteTarget._id })
      // "retiré de la médiathèque", not "supprimé": that is the whole of what
      // this page can know. `deleteMedia` schedules the S3 purge and answers
      // before it runs, so the outcome never reaches the browser.
      toast.success(`"${deleteTarget.filename}" retiré de la médiathèque`)
      setDeleteTarget(null)
      if (selectedMedia?._id === deleteTarget._id) setSelectedMedia(null)
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Impossible de supprimer ce média",
      )
    }
  }, [storeId, deleteTarget, deleteMedia, selectedMedia])

  if (!storeId) return null

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Médiathèque</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Gérez vos images, vidéos et fichiers.
          </p>
        </div>
        <Button className="w-full sm:w-auto shrink-0" onClick={() => inputRef.current?.click()} disabled={uploading}>
          {uploading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Upload className="mr-2 h-4 w-4" />
          )}
          Uploader
        </Button>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative flex-1 sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Rechercher par nom..."
            value={search}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setSearch(e.target.value); setCurrentPage(1) }}
            className="pl-9"
          />
        </div>
        <Select
          value={kindFilter}
          onValueChange={(v: string) => { setKindFilter(v as KindFilter); setCurrentPage(1) }}
        >
          <SelectTrigger className="w-full sm:w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tous les types</SelectItem>
            <SelectItem value="image">Images</SelectItem>
            <SelectItem value="video">Vidéos</SelectItem>
            <SelectItem value="file">Fichiers</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={folderFilter}
          onValueChange={(v: string) => { setFolderFilter(v as FolderFilter); setCurrentPage(1) }}
        >
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.entries(FOLDER_LABELS) as [FolderFilter, string][]).map(([value, label]) => (
              <SelectItem key={value} value={value}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Upload progress */}
      {uploading && (
        <div className="rounded-lg border bg-muted/20 p-4 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2 min-w-0">
              <Loader2 className="h-4 w-4 animate-spin shrink-0" />
              <span className="truncate">{uploadFileName}</span>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-muted-foreground tabular-nums">
                {uploadProgress}%
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={handleCancelUpload}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300 ease-out"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* Drop Zone + Grid */}
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        className="min-h-[300px]"
      >
        {mediaList === undefined ? (
          <LoadingState variant="cards" />
        ) : mediaList.length === 0 ? (
          <EmptyState
            icon={Grid3X3}
            title="Aucun média"
            description="Uploadez votre premier fichier en cliquant sur le bouton ci-dessus ou en déposant un fichier ici."
          />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {paginatedMedia.map((item: MediaItem) => {
              const Icon = ICON_BY_KIND[item.kind]
              const isSelected = selectedMedia?._id === item._id
              return (
                <div
                  key={item._id}
                  onClick={() => setSelectedMedia(item)}
                  className={`group relative rounded-lg border overflow-hidden cursor-pointer transition-all hover:ring-2 hover:ring-primary/50 ${
                    isSelected ? "ring-2 ring-primary" : ""
                  }`}
                >
                  {/* Thumbnail */}
                  <div className="aspect-square bg-muted/30 flex items-center justify-center">
                    {item.kind === "image" && item.status === "ready" ? (
                      <img
                        src={item.variants?.thumb?.url ?? item.sourceUrl ?? item.url}
                        alt={item.filename}
                        className="w-full h-full object-cover"
                      />
                    ) : item.kind === "video" && item.status === "ready" && (item.sourceUrl ?? item.url) ? (
                      <>
                        <video
                          src={`${item.sourceUrl ?? item.url}#t=0.1`}
                          preload="metadata"
                          muted
                          playsInline
                          className="w-full h-full object-cover"
                        />
                        <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                          <div className="rounded-full bg-white/90 p-1.5">
                            <Play className="h-4 w-4 fill-current" />
                          </div>
                        </div>
                      </>
                    ) : item.mimeType === "application/pdf" && item.status === "ready" ? (
                      <div className="flex flex-col items-center justify-center gap-1">
                        <FileText className="h-8 w-8 text-red-500" />
                        <span className="text-[10px] font-bold text-destructive uppercase">PDF</span>
                      </div>
                    ) : (
                      <Icon className="h-8 w-8 text-muted-foreground" />
                    )}
                    {item.status === "processing" && (
                      <div className="absolute inset-0 bg-background/60 flex items-center justify-center">
                        <Loader2 className="h-5 w-5 animate-spin" />
                      </div>
                    )}
                    {item.status === "failed" && (
                      <div className="absolute inset-0 bg-destructive/10 flex items-center justify-center">
                        <AlertCircle className="h-5 w-5 text-destructive" />
                      </div>
                    )}
                  </div>
                  {/* Info */}
                  <div className="p-2">
                    <p className="text-xs font-medium truncate">
                      {item.filename}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {formatFileSize(item.size)}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Pagination */}
      {mediaList && mediaList.length > MEDIA_PAGE_SIZE && (
        <div className="flex items-center justify-between py-4">
          <p className="text-sm text-muted-foreground">
            {(safePage - 1) * MEDIA_PAGE_SIZE + 1}-{Math.min(safePage * MEDIA_PAGE_SIZE, totalItems)} sur {totalItems} média{totalItems > 1 ? "s" : ""}
          </p>
          <Pagination className="mx-0 w-auto justify-end">
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  onClick={() => setCurrentPage(safePage - 1)}
                  disabled={safePage <= 1}
                  aria-disabled={safePage <= 1}
                />
              </PaginationItem>
              {getPageNumbers(safePage, totalPages).map((page, idx) =>
                page === "ellipsis" ? (
                  <PaginationItem key={`ellipsis-${idx}`}>
                    <PaginationEllipsis />
                  </PaginationItem>
                ) : (
                  <PaginationItem key={page}>
                    <PaginationLink
                      isActive={page === safePage}
                      onClick={() => setCurrentPage(page)}
                    >
                      {page}
                    </PaginationLink>
                  </PaginationItem>
                ),
              )}
              <PaginationItem>
                <PaginationNext
                  onClick={() => setCurrentPage(safePage + 1)}
                  disabled={safePage >= totalPages}
                  aria-disabled={safePage >= totalPages}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      )}

      {/* Detail Panel */}
      {selectedMedia && (
        <Dialog
          open={!!selectedMedia}
          onOpenChange={() => { setSelectedMedia(null); setCopied(false) }}
        >
          <DialogContent className="sm:max-w-3xl max-h-[calc(100dvh-2rem)] sm:max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="truncate pr-8">
                {selectedMedia.filename}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {/* Preview */}
              {selectedMedia.kind === "image" &&
              selectedMedia.status === "ready" ? (
                <div className="rounded-lg border overflow-hidden bg-muted/20">
                  <img
                    src={selectedMedia.sourceUrl ?? selectedMedia.url}
                    alt={selectedMedia.filename}
                    className="w-full max-h-48 sm:max-h-64 object-contain"
                  />
                </div>
              ) : selectedMedia.kind === "video" &&
                selectedMedia.status === "ready" &&
                (selectedMedia.sourceUrl ?? selectedMedia.url) ? (
                <div className="rounded-lg border overflow-hidden bg-black">
                  <video
                    controls
                    preload="metadata"
                    src={selectedMedia.sourceUrl ?? selectedMedia.url}
                    className="w-full max-h-64"
                  />
                </div>
              ) : selectedMedia.mimeType === "application/pdf" &&
                selectedMedia.status === "ready" &&
                (selectedMedia.sourceUrl ?? selectedMedia.url) ? (
                <div className="rounded-lg border overflow-hidden">
                  <iframe
                    src={selectedMedia.sourceUrl ?? selectedMedia.url}
                    className="w-full h-64"
                    title={selectedMedia.filename}
                  />
                </div>
              ) : (
                <div className="rounded-lg border bg-muted/20 flex items-center justify-center h-32">
                  {(() => {
                    const Icon = ICON_BY_KIND[selectedMedia.kind]
                    return <Icon className="h-12 w-12 text-muted-foreground" />
                  })()}
                </div>
              )}

              {/* Metadata */}
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Type</span>
                  <p>{selectedMedia.mimeType}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Taille</span>
                  <p>{formatFileSize(selectedMedia.size)}</p>
                </div>
                {selectedMedia.width && selectedMedia.height && (
                  <div>
                    <span className="text-muted-foreground">Dimensions</span>
                    <p>
                      {selectedMedia.width} x {selectedMedia.height}
                    </p>
                  </div>
                )}
                <div>
                  <span className="text-muted-foreground">Uploadé le</span>
                  <p>{formatDate(selectedMedia.uploadedAt)}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Statut</span>
                  <div className="flex items-center gap-1.5">
                    <Badge
                      variant={
                        selectedMedia.status === "ready"
                          ? "default"
                          : selectedMedia.status === "processing"
                            ? "secondary"
                            : "destructive"
                      }
                    >
                      {selectedMedia.status === "ready"
                        ? "Prêt"
                        : selectedMedia.status === "processing"
                          ? "En cours..."
                          : "Erreur"}
                    </Badge>
                    {selectedMedia.status === "failed" && selectedMedia.errorMessage && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <AlertCircle className="h-3.5 w-3.5 text-destructive cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">
                          <p className="text-xs">{selectedMedia.errorMessage}</p>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </div>
                <div>
                  <span className="text-muted-foreground">Utilisations</span>
                  <p>{selectedMedia.usageCount}</p>
                </div>
              </div>

              {/* URL */}
              {(selectedMedia.sourceUrl ?? selectedMedia.url) && (
                <div>
                  <span className="text-sm text-muted-foreground">URL</span>
                  <div className="flex gap-1.5 mt-1">
                    <Input
                      readOnly
                      value={selectedMedia.sourceUrl ?? selectedMedia.url ?? ""}
                      className="text-xs flex-1"
                      onClick={(e: React.MouseEvent<HTMLInputElement>) => (e.target as HTMLInputElement).select()}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      className="shrink-0 h-10 w-10"
                      onClick={() => {
                        const url = selectedMedia.sourceUrl ?? selectedMedia.url ?? ""
                        navigator.clipboard.writeText(url)
                        setCopied(true)
                        toast.success("URL copiée")
                        setTimeout(() => setCopied(false), 2000)
                      }}
                    >
                      {copied ? (
                        <CheckCheck className="h-3.5 w-3.5 text-success" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </div>
            <DialogFooter className="sm:justify-start">
              <Button
                variant="destructive"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => {
                  setDeleteTarget(selectedMedia)
                  setSelectedMedia(null)
                }}
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                Supprimer
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/*
        Delete confirm. The description says what this dialog can actually
        know, and no more.

        It is pre-hoc — shown before the delete is attempted — and the S3 purge
        is scheduled after the mutation returns (`convex/cmsMedia.ts`), so the
        browser never sees the outcome even in principle. That outcome turns on
        an IAM policy this page cannot read: on a deployment provisioned before
        `s3:DeleteObjectVersion`, `purgeS3Objects` writes a delete marker, the
        object is hidden and every byte of it stays in the bucket until the
        lifecycle rules collect it. « Définitivement supprimé » was therefore
        false on that path, and stated as a fact. What is true on both paths is
        that the file leaves the library and stops being served, and that the
        storage side finishes within the 30-day NoncurrentVersionExpiration
        window `setup-aws.sh` installs.
      */}
      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Supprimer ce média ?"
        description={`Le fichier "${deleteTarget?.filename}" sera retiré de la médiathèque et ne sera plus affiché sur le site. Son effacement complet du stockage peut prendre jusqu'à 30 jours. Cette action est irréversible.`}
      />
    </div>
  )
}
