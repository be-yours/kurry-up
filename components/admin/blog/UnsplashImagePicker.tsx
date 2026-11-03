"use client"

import { useState, useCallback } from "react"
import { useAction } from "convex/react"
import { api } from "@/convex/_generated/api"
import { convexErrorMessage } from "@/lib/convex-error"
import { toast } from "sonner"
import { Search, Loader2 } from "lucide-react"
import {
  Button,
  Input,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@be-yours/ui"

export interface UnsplashPhoto {
  id: string
  url: string
  thumbUrl: string
  alt: string
  photographerName: string
  photographerUrl: string
  downloadLocation: string
}

interface UnsplashImagePickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (photo: UnsplashPhoto) => void
  initialQuery?: string
}

export function UnsplashImagePicker({
  open,
  onOpenChange,
  onSelect,
  initialQuery = "",
}: UnsplashImagePickerProps) {
  const [query, setQuery] = useState(initialQuery)
  const [results, setResults] = useState<UnsplashPhoto[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)

  const searchPhotos = useAction(api.unsplashSearch.searchPhotos)
  const triggerDownload = useAction(api.unsplashSearch.triggerDownload)

  const handleSearch = useCallback(async () => {
    const trimmed = query.trim()
    if (!trimmed) return

    setLoading(true)
    setSearched(true)
    try {
      const data = await searchPhotos({ query: trimmed })
      setResults(data.results)
    } catch (err) {
      toast.error(
        convexErrorMessage(err, {}, "Erreur lors de la recherche")
      )
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [query, searchPhotos])

  const handleSelect = useCallback(
    async (photo: UnsplashPhoto) => {
      // Trigger Unsplash download tracking
      triggerDownload({ downloadLocation: photo.downloadLocation }).catch(() => {})
      onSelect(photo)
      onOpenChange(false)
    },
    [onSelect, onOpenChange, triggerDownload]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[calc(100dvh-2rem)] sm:max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Rechercher sur Unsplash</DialogTitle>
        </DialogHeader>

        <div className="flex gap-2">
          <Input
            placeholder="Rechercher des photos..."
            value={query}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.key === "Enter") handleSearch()
            }}
            className="flex-1"
          />
          <Button onClick={handleSearch} disabled={loading || !query.trim()}>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
          </Button>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {!loading && searched && results.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">
            Aucun resultat pour &quot;{query}&quot;
          </p>
        )}

        {!loading && results.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {results.map((photo) => (
              <button
                key={photo.id}
                type="button"
                onClick={() => handleSelect(photo)}
                className="group relative rounded-lg overflow-hidden border hover:ring-2 hover:ring-primary transition-all text-left"
              >
                <div className="aspect-[16/10]">
                  <img
                    src={photo.thumbUrl}
                    alt={photo.alt}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                </div>
                <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5">
                  <p className="text-[10px] text-white/90 truncate">
                    {photo.photographerName}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}

        <p className="text-[10px] text-muted-foreground text-center">
          Photos fournies par{" "}
          <a
            href="https://unsplash.com/?utm_source=beindigital&utm_medium=referral"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Unsplash
          </a>
        </p>
      </DialogContent>
    </Dialog>
  )
}
