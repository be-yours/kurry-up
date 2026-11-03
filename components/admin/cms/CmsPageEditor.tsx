"use client"

import { convexErrorMessage } from "@/lib/convex-error"
import "@/lib/cms/init"
import { useState, useCallback, useRef, useEffect } from "react"
import { useQuery, useMutation } from "convex/react"
import { api } from "@/convex/_generated/api"
import { useAdminStoreId } from "@/lib/admin/hooks"
import { toast } from "sonner"
import {
  ArrowLeft,
  Globe,
  Eye,
  Upload,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Languages,
} from "lucide-react"
import { Button, Badge } from "@be-yours/ui"
import { LoadingState } from "@/components/admin/LoadingState"
import { CmsBlockAccordion } from "./CmsBlockAccordion"
import { CmsTranslationDrawer } from "./CmsTranslationDrawer"
import { TrendingProductsPicker } from "./TrendingProductsPicker"
import {
  getPageDefinition,
  getBlockDefinition,
  getFieldDefinition,
} from "@be-yours/cms"
import type { CmsFieldValue, CmsBlockValues } from "@be-yours/cms"
import type { Id } from "@/convex/_generated/dataModel"
import Link from "next/link"

interface CmsPageEditorProps {
  pageSlug: string
}

type SaveStatus = "idle" | "saving" | "saved" | "error"

const DEBOUNCE_MS = 1500

export function CmsPageEditor({ pageSlug }: CmsPageEditorProps) {
  const storeId = useAdminStoreId()
  const pageDef = getPageDefinition(pageSlug)

  // Convex queries/mutations
  const adminBlocks = useQuery(
    api.cms.getAdminPageBlocks,
    storeId ? { storeId, pageSlug } : "skip",
  )
  const saveDraft = useMutation(api.cms.saveDraftBlock)
  const resetField = useMutation(api.cms.resetField)
  const resetBlock = useMutation(api.cms.resetBlock)
  const resetPage = useMutation(api.cms.resetPage)
  const publishPage = useMutation(api.cms.publishPage)
  const translateAll = useMutation(api.cms.translateAllPageFields)

  // Local state for autosave
  const [localValues, setLocalValues] = useState<
    Record<string, CmsBlockValues>
  >({})
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle")
  const [publishing, setPublishing] = useState(false)
  const [translatingAll, setTranslatingAll] = useState(false)

  // Per-block debounce timers (prevents cross-block cancellation)
  const debounceMapRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  // Tracks latest unsaved values per block (for flush on publish/unmount)
  const pendingBlockRef = useRef(new Map<string, CmsBlockValues>())

  // Translation drawer state
  const [translationDrawer, setTranslationDrawer] = useState<{
    open: boolean
    blockKey: string
    fieldKey: string
  }>({ open: false, blockKey: "", fieldKey: "" })

  // Initialize local values from server data (draft > published fallback)
  useEffect(() => {
    if (!adminBlocks) return
    setLocalValues((prev) => {
      if (Object.keys(prev).length > 0) return prev
      const initial: Record<string, CmsBlockValues> = {}
      for (const block of adminBlocks.blocks) {
        const values =
          block.draftBlock?.values ?? block.publishedBlock?.values
        if (values) {
          initial[block.blockKey] = values
        }
      }
      return initial
    })
  }, [adminBlocks])

  // Persist a single block (used by debounce and flush)
  const persistBlock = useCallback(
    async (blockKey: string, values: CmsBlockValues) => {
      if (!storeId) return
      setSaveStatus("saving")
      try {
        await saveDraft({ storeId, pageSlug, blockKey, values })
        pendingBlockRef.current.delete(blockKey)
        setSaveStatus("saved")
        setTimeout(() => setSaveStatus("idle"), 2000)
      } catch (err) {
        setSaveStatus("error")
        toast.error(
          convexErrorMessage(err, {}, "Erreur de sauvegarde"),
        )
      }
    },
    [storeId, pageSlug, saveDraft],
  )

  // Flush all pending blocks immediately (before publish/unmount)
  const flushPendingBlocks = useCallback(async () => {
    const map = debounceMapRef.current
    const pending = pendingBlockRef.current

    // Cancel all debounce timers
    for (const timer of map.values()) clearTimeout(timer)
    map.clear()

    // Persist all pending blocks in parallel
    const entries = Array.from(pending.entries())
    if (entries.length === 0) return
    await Promise.all(
      entries.map(([blockKey, values]) => persistBlock(blockKey, values)),
    )
  }, [persistBlock])

  // Flush on unmount (fire-and-forget)
  useEffect(() => {
    return () => {
      const map = debounceMapRef.current
      const pending = pendingBlockRef.current
      for (const timer of map.values()) clearTimeout(timer)
      map.clear()
      // Fire-and-forget: can't await in cleanup
      for (const [blockKey, values] of pending.entries()) {
        if (storeId) {
          saveDraft({ storeId, pageSlug, blockKey, values }).catch(() => {})
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Autosave handler (per-block debounce)
  const scheduleAutosave = useCallback(
    (blockKey: string, values: CmsBlockValues) => {
      if (!storeId) return

      // Track pending values
      pendingBlockRef.current.set(blockKey, values)

      // Clear only this block's timer
      const map = debounceMapRef.current
      if (map.has(blockKey)) clearTimeout(map.get(blockKey)!)

      map.set(
        blockKey,
        setTimeout(async () => {
          map.delete(blockKey)
          await persistBlock(blockKey, values)
        }, DEBOUNCE_MS),
      )
    },
    [storeId, persistBlock],
  )

  const handleFieldChange = useCallback(
    (blockKey: string, fieldKey: string, value: CmsFieldValue) => {
      setLocalValues((prev) => {
        const blockValues = { ...prev[blockKey], [fieldKey]: value }
        scheduleAutosave(blockKey, blockValues)
        return { ...prev, [blockKey]: blockValues }
      })
    },
    [scheduleAutosave],
  )

  const handleFieldReset = useCallback(
    async (blockKey: string, fieldKey: string) => {
      if (!storeId) return
      try {
        await resetField({
          storeId,
          pageSlug,
          blockKey,
          fieldKey,
        })
        // Update local state
        setLocalValues((prev) => {
          const blockValues = { ...prev[blockKey] }
          const fieldDef = getFieldDefinition(pageSlug, blockKey, fieldKey)
          blockValues[fieldKey] = {
            type: (fieldDef?.type ?? "text") as CmsFieldValue["type"],
            isCleared: true,
          }
          return { ...prev, [blockKey]: blockValues }
        })
        toast.success("Champ réinitialisé")
      } catch (err) {
        toast.error("Erreur lors de la réinitialisation")
      }
    },
    [storeId, pageSlug, resetField],
  )

  const handleBlockReset = useCallback(
    async (blockKey: string) => {
      if (!storeId) return
      try {
        await resetBlock({ storeId, pageSlug, blockKey })
        setLocalValues((prev) => {
          const next = { ...prev }
          delete next[blockKey]
          return next
        })
        toast.success("Bloc réinitialisé")
      } catch (err) {
        toast.error("Erreur lors de la réinitialisation du bloc")
      }
    },
    [storeId, pageSlug, resetBlock],
  )

  const handlePublish = useCallback(async () => {
    if (!storeId) return

    setPublishing(true)
    try {
      // Flush all pending blocks before publishing
      await flushPendingBlocks()
      await publishPage({ storeId, pageSlug })
      toast.success("Page publiée avec succès")
      // Clear local state to reload from server
      setLocalValues({})
    } catch (err) {
      toast.error(
        convexErrorMessage(err, {}, "Erreur lors de la publication"),
      )
    } finally {
      setPublishing(false)
    }
  }, [storeId, pageSlug, publishPage, flushPendingBlocks])

  const handleOpenTranslations = useCallback(
    (blockKey: string, fieldKey: string) => {
      setTranslationDrawer({ open: true, blockKey, fieldKey })
    },
    [],
  )

  const handleTranslateAll = useCallback(async () => {
    if (!storeId) return
    /* NOT ON A PAGE NOTHING READS (#630). « Traduire tout » spends OpenAI
       credit per field, and 96 of the registry's 197 fields have no reader —
       so an owner translating the « Commande » group into three languages paid
       for strings that reach nobody. The button is not drawn for such a page;
       this is the backstop, because the handler is what costs the money. */
    if (pageDef?.rendered !== true) {
      toast.error(
        "Cette page n'est pas encore affichée sur le site : la traduction serait sans effet.",
      )
      return
    }
    setTranslatingAll(true)
    try {
      await translateAll({ storeId, pageSlug })
      toast.success("Traduction lancée pour tous les champs")
    } catch (err) {
      toast.error(
        convexErrorMessage(err, {}, "Erreur lors du lancement de la traduction"),
      )
    } finally {
      setTranslatingAll(false)
    }
  }, [storeId, pageSlug, translateAll, pageDef])

  if (!pageDef) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        Page &quot;{pageSlug}&quot; non trouvée dans le registre CMS.
      </div>
    )
  }

  if (!storeId) return null

  if (adminBlocks === undefined) {
    return <LoadingState variant="form" />
  }

  const pageMeta = adminBlocks.pageMeta

  // Check if any block has a pending auto-translation
  const isTranslating = adminBlocks.blocks.some(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (b: any) => b.draftBlock?.isTranslating,
  )

  // Translation drawer data
  const drawerBlockData = adminBlocks.blocks.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (b: any) => b.blockKey === translationDrawer.blockKey,
  )
  const drawerFieldDef = translationDrawer.blockKey
    ? getFieldDefinition(
        pageSlug,
        translationDrawer.blockKey,
        translationDrawer.fieldKey,
      )
    : null
  const drawerSourceValue =
    drawerBlockData?.draftBlock?.values[translationDrawer.fieldKey]
      ?.textValue ??
    drawerBlockData?.publishedBlock?.values[translationDrawer.fieldKey]
      ?.textValue ??
    ""
  const drawerTranslations =
    drawerBlockData?.draftBlock?.translationsByField[
      translationDrawer.fieldKey
    ] ??
    drawerBlockData?.publishedBlock?.translationsByField[
      translationDrawer.fieldKey
    ] ??
    {}

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/dashboard/content/pages">
            <Button variant="ghost" size="sm" className="shrink-0">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold truncate">{pageDef.label}</h1>
            {pageDef.description && (
              <p className="text-sm text-muted-foreground truncate">
                {pageDef.description}
              </p>
            )}
            {/* THE PAGE SAYS WHEN NOTHING READS IT (#630). The registry
                declares 20 pages and six are read; whole groups are inert —
                Commande 0/8 blocks, Compte 0/8, Authentification 0/5. The seed
                fills them with realistic values, so the editor showed saved,
                plausible text for controls that reach nothing, autosaved it and
                published it with a green badge. `PageDefinition.rendered` is
                declared in the registry and `cms-registry-readers.test.ts`
                fails when it disagrees with the call sites. */}
            {pageDef.rendered !== true && (
              <Badge variant="outline" className="mt-1 text-[10px]">
                Non utilisé
              </Badge>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Save status */}
          {saveStatus === "saving" && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Sauvegarde...
            </span>
          )}
          {saveStatus === "saved" && (
            <span
              data-save-status="saved"
              className="flex items-center gap-1 text-xs text-success"
            >
              <CheckCircle2 className="h-3 w-3" />
              Sauvegardé
            </span>
          )}
          {saveStatus === "error" && (
            <span className="flex items-center gap-1 text-xs text-destructive">
              <AlertTriangle className="h-3 w-3" />
              Erreur
            </span>
          )}

          {/* Status badges */}
          {pageMeta?.hasPublished && (
            <Badge variant="default" className="text-xs">
              <Globe className="mr-1 h-3 w-3" />
              Publié
            </Badge>
          )}
          {pageMeta?.hasUnpublishedChanges && (
            <Badge variant="secondary" className="text-xs">
              Brouillon
            </Badge>
          )}

          {/* Translate all */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleTranslateAll}
            disabled={
              translatingAll || saveStatus === "saving" || pageDef.rendered !== true
            }
            title={
              pageDef.rendered !== true
                ? "Cette page n'est pas encore affichée sur le site : la traduction serait sans effet."
                : isTranslating
                  ? "Relancer la traduction"
                  : "Traduire tous les champs de texte"
            }
          >
            {translatingAll || isTranslating ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Languages className="mr-2 h-3.5 w-3.5" />
            )}
            {isTranslating ? "Retraduire" : "Traduire tout"}
          </Button>

          {/* NO « Aperçu » WITHOUT A ROUTE (#630). `PreviewClient` fell back
              to `/${pageSlug}` and only `homepage` declares a route, so eight
              pages previewed into a 404 — and this button was the one place an
              owner could have discovered any of this unaided. It misled
              instead. */}
          {pageDef.route ? (
            <a
              href={`/preview/${pageSlug}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button variant="outline" size="sm">
                <Eye className="mr-2 h-3.5 w-3.5" />
                Aperçu
              </Button>
            </a>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled
              title="Cette page n'a pas d'adresse publique : il n'y a rien à prévisualiser."
            >
              <Eye className="mr-2 h-3.5 w-3.5" />
              Aperçu
            </Button>
          )}

          {/* Publish */}
          <Button
            onClick={handlePublish}
            disabled={publishing || saveStatus === "saving"}
          >
            {publishing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            Publier
          </Button>
        </div>
      </div>

      {/* Block Accordions */}
      <div className="space-y-4">
        {pageDef.blocks.map((blockDef) => {
          const serverBlock = adminBlocks.blocks.find(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (b: any) => b.blockKey === blockDef.key,
          )
          const draftValues =
            localValues[blockDef.key] ??
            serverBlock?.draftBlock?.values ??
            serverBlock?.publishedBlock?.values ??
            {}
          const publishedValues =
            serverBlock?.publishedBlock?.values ?? undefined
          const resolvedMedia =
            serverBlock?.draftBlock?.resolvedMedia ??
            serverBlock?.publishedBlock?.resolvedMedia ??
            {}
          const translationsByField =
            serverBlock?.draftBlock?.translationsByField ??
            serverBlock?.publishedBlock?.translationsByField ??
            {}

          return (
            <div key={blockDef.key} className="space-y-4">
              <CmsBlockAccordion
                blockDef={blockDef}
                draftValues={draftValues}
                publishedValues={publishedValues}
                resolvedMedia={resolvedMedia}
                translationsByField={translationsByField}
                onFieldChange={handleFieldChange}
                onFieldReset={handleFieldReset}
                onBlockReset={handleBlockReset}
                onOpenTranslations={handleOpenTranslations}
              />
              {/* Trending products picker — injected for homepage trendingMeals block */}
              {pageSlug === "homepage" && blockDef.key === "trendingMeals" && (
                <TrendingProductsPicker />
              )}
            </div>
          )
        })}
      </div>

      {/* Translation Drawer */}
      {drawerFieldDef && (
        <CmsTranslationDrawer
          open={translationDrawer.open}
          onOpenChange={(open) =>
            setTranslationDrawer((prev) => ({ ...prev, open }))
          }
          fieldKey={translationDrawer.fieldKey}
          fieldDef={drawerFieldDef}
          sourceValue={drawerSourceValue}
          translations={drawerTranslations}
        />
      )}
    </div>
  )
}
