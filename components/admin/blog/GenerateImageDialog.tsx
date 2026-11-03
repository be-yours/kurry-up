"use client"

import { useState, useCallback } from "react"
import { useAction, useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import { convexErrorMessage } from "@/lib/convex-error"
import { useAdminStoreId } from "@/lib/admin/hooks"
import { toast } from "sonner"
import { Sparkles, Loader2, ImageIcon } from "lucide-react"
import {
  Button,
  Badge,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  Textarea,
} from "@be-yours/ui"

interface GenerateImageDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onInsert: (image: { url: string; alt: string }) => void
  defaultPrompt?: string
}

export function GenerateImageDialog({
  open,
  onOpenChange,
  onInsert,
  defaultPrompt = "Photo professionnelle : [sujet]. Style editorial, lumiere naturelle, haute qualité.",
}: GenerateImageDialogProps) {
  const storeId = useAdminStoreId()
  const [prompt, setPrompt] = useState(defaultPrompt)
  const [generating, setGenerating] = useState(false)
  const [generatedImage, setGeneratedImage] = useState<{
    url: string
    alt: string
  } | null>(null)

  const generateImage = useAction(api.blogImageGenerate.generateImage)
  const imageAccess = useQuery(api.blogAutoConfig.getImageAccessStatus)

  const isQuotaReached = imageAccess && !imageAccess.allowed
  const remainingQuota = imageAccess?.remainingImageQuota ?? 0

  const handleGenerate = useCallback(async () => {
    if (!storeId || !prompt.trim()) return

    setGenerating(true)
    setGeneratedImage(null)
    try {
      const result = await generateImage({
        storeId,
        prompt: prompt.trim(),
      })
      setGeneratedImage({ url: result.url, alt: result.alt })
    } catch (err) {
      toast.error(
        convexErrorMessage(err, {}, "Erreur lors de la génération")
      )
    } finally {
      setGenerating(false)
    }
  }, [storeId, prompt, generateImage])

  const handleInsert = useCallback(() => {
    if (!generatedImage) return
    onInsert(generatedImage)
    onOpenChange(false)
    // Reset state for next open
    setGeneratedImage(null)
    setPrompt(defaultPrompt)
  }, [generatedImage, onInsert, onOpenChange, defaultPrompt])

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) {
        // Reset state on close
        setGeneratedImage(null)
        setGenerating(false)
      }
      onOpenChange(isOpen)
    },
    [onOpenChange]
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            Générer une image avec l&apos;IA
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Quota badge */}
          {imageAccess && (
            <div className="flex items-center gap-2">
              <Badge variant={isQuotaReached ? "destructive" : "secondary"}>
                {isQuotaReached
                  ? "Quota atteint"
                  : `${remainingQuota} image${remainingQuota > 1 ? "s" : ""} restante${remainingQuota > 1 ? "s" : ""}`}
              </Badge>
              {isQuotaReached && (
                <span className="text-xs text-muted-foreground">
                  {imageAccess.reason}
                </span>
              )}
            </div>
          )}

          {/* Prompt input */}
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="generate-image-prompt">
              Prompt
            </label>
            <Textarea
              id="generate-image-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Décrivez l'image souhaitée..."
              rows={4}
              disabled={generating}
            />
            <p className="text-xs text-muted-foreground">
              Décrivez l&apos;image que vous souhaitez générer. Soyez précis pour de meilleurs résultats.
            </p>
          </div>

          {/* Generate button */}
          <Button
            onClick={handleGenerate}
            disabled={generating || !prompt.trim() || isQuotaReached}
            className="w-full"
          >
            {generating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Génération en cours...
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                Générer
              </>
            )}
          </Button>

          {/* Preview */}
          {generatedImage && (
            <div className="space-y-2">
              {/* Heads an image, not a control. */}
              <p className="text-sm font-medium">Aperçu</p>
              <div className="relative rounded-lg border overflow-hidden bg-muted">
                <img
                  src={generatedImage.url}
                  alt={generatedImage.alt}
                  className="w-full h-auto max-h-64 object-contain"
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={handleInsert} disabled={!generatedImage}>
            <ImageIcon className="mr-2 h-4 w-4" />
            Inserer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
