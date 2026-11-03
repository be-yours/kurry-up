"use client"

import { useState, useCallback, useRef } from "react"
import { convexErrorMessage } from "@/lib/convex-error"
import { uploadWithProgress } from "@/lib/cms/upload-with-progress"
import { useQuery, useMutation, useAction } from "convex/react"
import { api } from "@/convex/_generated/api"
import { useAdminStoreId } from "@/lib/admin/hooks"
import { toast } from "sonner"
import imageCompression from "browser-image-compression"
import {
  Upload,
  Search,
  Image as ImageIcon,
  Video,
  FileText,
  Loader2,
  Check,
  X,
  Play,
} from "lucide-react"
import {
  Button,
  Input,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@be-yours/ui"
import { validateMediaUpload } from "@be-yours/cms"
import type { MediaKind } from "@be-yours/cms"
import type { Id } from "@/convex/_generated/dataModel"

interface MediaItem {
  _id: Id<"cmsMedia">
  kind: "image" | "video" | "file"
  status: string
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
}

interface CmsMediaPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (media: { mediaId: string; url: string; filename: string }) => void
  kindFilter?: MediaKind
}

const ICON_BY_KIND = {
  image: ImageIcon,
  video: Video,
  file: FileText,
}

export function CmsMediaPicker({
  open,
  onOpenChange,
  onSelect,
  kindFilter,
}: CmsMediaPickerProps) {
  const storeId = useAdminStoreId()
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadFileName, setUploadFileName] = useState("")
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const mediaList = useQuery(
    api.cmsMedia.listMedia,
    storeId && open
      ? {
          storeId,
          ...(kindFilter && { kind: kindFilter }),
          ...(search && { search }),
        }
      : "skip",
  )
  const createMedia = useMutation(api.cmsMedia.createMedia)
  const getPresignedUrlForMedia = useAction(api.storageUpload.getPresignedUrlForMedia)
  const confirmUpload = useAction(api.cmsMediaConfirmUpload.confirmUpload)
  const uploadSvgAction = useAction(api.cmsSvgUpload.uploadSvg)

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

      if (kindFilter && validation.kind !== kindFilter) {
        toast.error(
          `Ce type de fichier n'est pas accepté ici. Attendu : ${kindFilter}`,
        )
        return
      }

      setUploading(true)
      setUploadProgress(0)
      setUploadFileName(file.name)
      const abort = new AbortController()
      abortRef.current = abort

      try {
        const isSvg = file.type === "image/svg+xml"
        const isProcessableImage = validation.kind === "image" && !isSvg

        let mediaId: Id<"cmsMedia">

        if (isSvg) {
          mediaId = await createMedia({
            storeId,
            kind: "image",
            filename: file.name,
            mimeType: file.type,
            size: file.size,
            uploadedBy: "admin",
          })
          const svgContent = await file.text()
          await uploadSvgAction({ storeId, mediaId, svgContent, filename: file.name })
        } else if (isProcessableImage) {
          const compressed = await imageCompression(file, {
            maxWidthOrHeight: 2048,
            useWebWorker: true,
          })
          mediaId = await createMedia({
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
          mediaId = await createMedia({
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

        onSelect({ mediaId: mediaId as string, url: "", filename: file.name })
        onOpenChange(false)
        toast.success("Fichier uploadé et sélectionné")
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
    [storeId, kindFilter, createMedia, getPresignedUrlForMedia, confirmUpload, uploadSvgAction, onSelect, onOpenChange],
  )

  const handleConfirm = useCallback(() => {
    if (!selected || !mediaList) return
    const media = mediaList.find((m: MediaItem) => m._id === selected)
    if (media) {
      onSelect({
        mediaId: media._id as string,
        url: media.sourceUrl ?? media.url ?? "",
        filename: media.filename,
      })
      onOpenChange(false)
    }
  }, [selected, mediaList, onSelect, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[calc(100dvh-2rem)] sm:max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Choisir un média</DialogTitle>
        </DialogHeader>

        {/* Controls */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Rechercher..."
              value={search}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="mr-2 h-3.5 w-3.5" />
            )}
            Uploader
          </Button>
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) handleUpload(file)
              e.target.value = ""
            }}
          />
        </div>

        {/* Upload progress */}
        {uploading && (
          <div className="rounded-lg border bg-muted/20 p-3 space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2 min-w-0">
                <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                <span className="truncate text-xs">{uploadFileName}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground tabular-nums">
                  {uploadProgress}%
                </span>
                <button
                  type="button"
                  onClick={handleCancelUpload}
                  className="inline-flex size-6 items-center justify-center text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300 ease-out"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          </div>
        )}

        {/* Grid */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {mediaList === undefined ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : mediaList.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
              <ImageIcon className="h-8 w-8 mb-2" />
              <p className="text-sm">Aucun média trouvé</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 py-2">
              {mediaList
                .filter((m: MediaItem) => m.status === "ready")
                .map((item: MediaItem) => {
                  const Icon = ICON_BY_KIND[item.kind]
                  const isSelected = selected === item._id
                  return (
                    <div
                      key={item._id}
                      onClick={() => setSelected(item._id)}
                      className={`relative rounded-md border overflow-hidden cursor-pointer transition-all hover:ring-2 hover:ring-primary/50 ${
                        isSelected ? "ring-2 ring-primary" : ""
                      }`}
                    >
                      <div className="aspect-square bg-muted/30 flex items-center justify-center relative">
                        {item.kind === "image" ? (
                          <img
                            src={item.variants?.thumb?.url ?? item.sourceUrl ?? item.url}
                            alt={item.filename}
                            className="w-full h-full object-cover"
                          />
                        ) : item.kind === "video" && (item.sourceUrl ?? item.url) ? (
                          <>
                            <video
                              src={`${item.sourceUrl ?? item.url}#t=0.1`}
                              preload="metadata"
                              muted
                              playsInline
                              className="w-full h-full object-cover"
                            />
                            <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                              <div className="rounded-full bg-white/90 p-1">
                                <Play className="h-3 w-3 fill-current" />
                              </div>
                            </div>
                          </>
                        ) : item.mimeType === "application/pdf" ? (
                          <div className="flex flex-col items-center justify-center gap-0.5">
                            <FileText className="h-6 w-6 text-red-500" />
                            <span className="text-[9px] font-bold text-destructive uppercase">PDF</span>
                          </div>
                        ) : (
                          <Icon className="h-6 w-6 text-muted-foreground" />
                        )}
                      </div>
                      {isSelected && (
                        <div className="absolute top-1 right-1 rounded-full bg-primary p-0.5">
                          <Check className="h-3 w-3 text-primary-foreground" />
                        </div>
                      )}
                      <p className="px-1.5 py-1 text-[10px] truncate">
                        {item.filename}
                      </p>
                    </div>
                  )
                })}
            </div>
          )}
        </div>

        <DialogFooter className="flex-col-reverse sm:flex-row gap-2">
          <Button variant="outline" className="w-full sm:w-auto" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button className="w-full sm:w-auto" onClick={handleConfirm} disabled={!selected}>
            Sélectionner
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
