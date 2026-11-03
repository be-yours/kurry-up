"use client"

import { useState, useCallback } from "react"
import { useAction } from "convex/react"
import { api } from "@/convex/_generated/api"
import { RotateCcw, Languages, Upload, X, Link as LinkIcon, Sparkles, Loader2 } from "lucide-react"
import {
  Button,
  Input,
  Label,
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@be-yours/ui"
import { toast } from "sonner"
import { CmsRichTextEditor } from "./CmsRichTextEditor"
import { CmsMediaPicker } from "./CmsMediaPicker"
import type { FieldDefinition, CmsFieldValue } from "@be-yours/cms"
import type { MediaKind } from "@be-yours/cms"

interface MediaPreview {
  url: string
  filename: string
  mimeType?: string
}

interface CmsFieldRendererProps {
  fieldKey: string
  fieldDef: FieldDefinition
  value: CmsFieldValue | undefined
  publishedValue?: CmsFieldValue | undefined
  resolvedMedia?: {
    url: string
    thumbnailUrl?: string
    filename: string
    mimeType: string
  }
  onChange: (fieldKey: string, value: CmsFieldValue) => void
  onReset: (fieldKey: string) => void
  onOpenTranslations?: (fieldKey: string) => void
  translationCount?: number
  disabled?: boolean
}

/**
 * Which provider an embed URL belongs to, decided on its HOST.
 *
 * This asked `url.includes("youtube.com")`, and a substring test does not know
 * where a URL's authority ends: `https://evil.example/?ref=youtube.com` answered
 * yes, and so did `https://youtube.com.evil.example/`. The needle may sit in the
 * path, the query or the fragment, and arbitrary hosts may come before or after
 * it. This answer picks the embed a storefront will render, so it has to be
 * asked of the parsed host and of nothing else.
 *
 * `endsWith("." + domain)` rather than `includes`, so `www.youtube.com` and
 * `player.vimeo.com` still resolve while `youtube.com.evil.example` does not.
 *
 * A URL typed without a scheme is retried as https, because that is what an
 * author pastes and what the substring form used to accept — dropping it would
 * be a silent behaviour change dressed up as a security fix.
 */
function detectEmbedProvider(url: string): "youtube" | "vimeo" | undefined {
  const trimmed = url.trim()
  if (!trimmed) return undefined

  let host: string
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    host = new URL(absolute).hostname.toLowerCase()
  } catch {
    return undefined
  }

  const servedBy = (domain: string) => host === domain || host.endsWith(`.${domain}`)

  if (servedBy("youtube.com") || servedBy("youtube-nocookie.com") || servedBy("youtu.be")) {
    return "youtube"
  }
  if (servedBy("vimeo.com")) return "vimeo"

  return undefined
}

export function CmsFieldRenderer({
  fieldKey,
  fieldDef,
  value,
  publishedValue,
  resolvedMedia,
  onChange,
  onReset,
  onOpenTranslations,
  translationCount = 0,
  disabled,
}: CmsFieldRendererProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [localMediaPreview, setLocalMediaPreview] = useState<MediaPreview | null>(null)
  const [generatingAlt, setGeneratingAlt] = useState(false)
  const generateAltText = useAction(api.cmsAltText.generateAltText)

  const isModified =
    value &&
    !value.isCleared &&
    publishedValue &&
    JSON.stringify(value) !== JSON.stringify(publishedValue)

  const handleTextChange = useCallback(
    (text: string) => {
      onChange(fieldKey, {
        type: fieldDef.type as CmsFieldValue["type"],
        textValue: text,
      })
    },
    [fieldKey, fieldDef.type, onChange],
  )

  const handleMediaSelect = useCallback(
    (media: { mediaId: string; url: string; filename: string }) => {
      // Store local preview for immediate display
      setLocalMediaPreview({ url: media.url, filename: media.filename })
      onChange(fieldKey, {
        type: fieldDef.type as CmsFieldValue["type"],
        mediaId: media.mediaId,
      })
    },
    [fieldKey, fieldDef.type, onChange],
  )

  const handleMediaClear = useCallback(() => {
    setLocalMediaPreview(null)
    onChange(fieldKey, {
      type: fieldDef.type as CmsFieldValue["type"],
      isCleared: true,
    })
  }, [fieldKey, fieldDef.type, onChange])

  const handleEmbedUrlChange = useCallback(
    (url: string) => {
      onChange(fieldKey, {
        type: "video",
        embedUrl: url,
        embedProvider: detectEmbedProvider(url),
      })
    },
    [fieldKey, onChange],
  )

  const handleSelectChange = useCallback(
    (selectedValue: string) => {
      onChange(fieldKey, {
        type: "select",
        textValue: selectedValue,
      })
    },
    [fieldKey, onChange],
  )

  const isCleared = value?.isCleared === true
  const currentText = value?.textValue ?? ""

  // Use server-resolved media first, fallback to local preview after upload
  // Filter out entries with empty url to avoid browser re-fetching the page
  const rawMedia = resolvedMedia ?? (value?.mediaId && localMediaPreview ? localMediaPreview : null)
  const displayMedia = rawMedia?.url ? rawMedia : null

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Label className="text-sm font-medium">{fieldDef.label}</Label>
          {fieldDef.required && !fieldDef.hasCodeFallback && (
            <Badge variant="outline" className="text-[10px]">
              Requis
            </Badge>
          )}
          {isModified && (
            <Badge variant="secondary" className="text-[10px]">
              Modifié
            </Badge>
          )}
          {isCleared && (
            <Badge variant="outline" className="text-[10px] text-warning">
              Réinitialisé
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1 self-end sm:self-auto">
          {fieldDef.translatable !== false &&
            (fieldDef.type === "text" || fieldDef.type === "richtext") && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => onOpenTranslations?.(fieldKey)}
              >
                <Languages className="mr-1 h-3 w-3" />
                {translationCount > 0 ? `${translationCount}` : "Traduire"}
              </Button>
            )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => onReset(fieldKey)}
            disabled={disabled || (!value && !isCleared)}
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            Réinitialiser
          </Button>
        </div>
      </div>

      {/* Published reference (if different) */}
      {publishedValue &&
        publishedValue.textValue &&
        isModified &&
        (fieldDef.type === "text" || fieldDef.type === "richtext") && (
          <p className="text-xs text-muted-foreground italic border-l-2 pl-2">
            Publié : {publishedValue.textValue.slice(0, 80)}
            {(publishedValue.textValue?.length ?? 0) > 80 ? "..." : ""}
          </p>
        )}

      {/* Field input by type */}
      {isCleared && fieldDef.type !== "image" && fieldDef.type !== "file" && fieldDef.type !== "video" ? (
        <div className="rounded-md border border-dashed p-3 text-center text-sm text-muted-foreground">
          Ce champ utilisera la valeur par défaut du code.
        </div>
      ) : fieldDef.type === "text" ? (
        <Input
          value={currentText}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleTextChange(e.target.value)}
          maxLength={fieldDef.maxLength}
          placeholder={
            fieldDef.hasCodeFallback
              ? "Laisser vide pour utiliser la valeur par défaut"
              : undefined
          }
          disabled={disabled}
        />
      ) : fieldDef.type === "richtext" ? (
        <CmsRichTextEditor
          value={currentText}
          onChange={handleTextChange}
          maxLength={fieldDef.maxLength}
          disabled={disabled}
        />
      ) : fieldDef.type === "image" || fieldDef.type === "file" ? (
        <div className="space-y-2">
          {displayMedia ? (
            <div className="relative group rounded-md border overflow-hidden">
              {fieldDef.type === "image" ? (
                <img
                  src={displayMedia.url}
                  alt={displayMedia.filename}
                  className="w-full max-h-48 object-contain bg-muted/30"
                />
              ) : (
                <div className="p-3 flex items-center gap-2 bg-muted/20">
                  <span className="text-sm">{displayMedia.filename}</span>
                  {displayMedia.mimeType && (
                    <span className="text-xs text-muted-foreground">
                      ({displayMedia.mimeType})
                    </span>
                  )}
                </div>
              )}
              <button
                type="button"
                onClick={handleMediaClear}
                className="absolute top-1.5 right-1.5 inline-flex size-6 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => setPickerOpen(true)}
              disabled={disabled}
            >
              <Upload className="mr-2 h-4 w-4" />
              {fieldDef.type === "image"
                ? "Choisir une image"
                : "Choisir un fichier"}
            </Button>
          )}
          {fieldDef.type === "image" && value?.mediaId && (
            <div className="flex items-center gap-1.5">
              <Input
                value={value.altText ?? ""}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  onChange(fieldKey, { ...value, altText: e.target.value })
                }
                placeholder="Texte alternatif (alt)"
                className="text-xs flex-1"
                disabled={disabled}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-9 w-9 shrink-0"
                disabled={disabled || generatingAlt || !displayMedia?.url}
                onClick={async () => {
                  if (!displayMedia?.url) return
                  setGeneratingAlt(true)
                  try {
                    const { altText } = await generateAltText({ imageUrl: displayMedia.url })
                    if (altText) {
                      onChange(fieldKey, { ...value, altText })
                    }
                  } catch {
                    toast.error("Impossible de générer le texte alternatif")
                  } finally {
                    setGeneratingAlt(false)
                  }
                }}
              >
                {generatingAlt ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          )}
          <CmsMediaPicker
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onSelect={handleMediaSelect}
            kindFilter={fieldDef.type as MediaKind}
          />
        </div>
      ) : fieldDef.type === "select" ? (
        <Select
          value={currentText || undefined}
          onValueChange={handleSelectChange}
          disabled={disabled}
        >
          <SelectTrigger className="w-full">
            <SelectValue
              placeholder={
                fieldDef.hasCodeFallback
                  ? "Valeur par défaut (code)"
                  : "Sélectionner..."
              }
            />
          </SelectTrigger>
          <SelectContent>
            {fieldDef.options?.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : fieldDef.type === "video" ? (
        <div className="space-y-2">
          {displayMedia ? (
            <div className="relative group rounded-md border overflow-hidden bg-muted/20 p-3">
              <p className="text-sm">{displayMedia.filename}</p>
              <button
                type="button"
                onClick={handleMediaClear}
                className="absolute top-1.5 right-1.5 inline-flex size-6 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPickerOpen(true)}
                  disabled={disabled}
                >
                  <Upload className="mr-1 h-3.5 w-3.5" />
                  Upload
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <LinkIcon className="h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={value?.embedUrl ?? ""}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleEmbedUrlChange(e.target.value)}
                  placeholder="URL YouTube ou Vimeo"
                  className="text-xs"
                  disabled={disabled}
                />
              </div>
            </>
          )}
          <CmsMediaPicker
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onSelect={handleMediaSelect}
            kindFilter="video"
          />
        </div>
      ) : null}

      {/* Max length indicator for text */}
      {(fieldDef.type === "text") &&
        fieldDef.maxLength &&
        currentText.length > 0 && (
          <p className="text-[10px] text-muted-foreground text-right">
            {currentText.length}/{fieldDef.maxLength}
          </p>
        )}
    </div>
  )
}
