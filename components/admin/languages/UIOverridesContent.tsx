"use client"

import { useState, useMemo } from "react"
import { useQuery, useMutation } from "convex/react"
import { api } from "@/convex/_generated/api"
import { useAdminStoreId } from "@/lib/admin/hooks"
import { toast } from "sonner"
import { SearchIcon, Globe2Icon, SaveIcon } from "lucide-react"
import {
  Button,
  Input,
  Label,
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Badge,
} from "@be-yours/ui"
import { LoadingState } from "@/components/admin/LoadingState"
import { EmptyState } from "@/components/admin/EmptyState"
import { REFERENCE_KEYS } from "@/lib/i18n/index"

interface LanguageDoc {
  code: string
  name: string
  nativeName: string
  flagEmoji?: string
  isDefault: boolean
  isActive: boolean
}

/**
 * Admin UI Overrides — allows overriding static JSON translations via Convex.
 * Groups overrides by language in an accordion. Supports search filtering.
 */
export function UIOverridesContent() {
  const storeId = useAdminStoreId()
  const [search, setSearch] = useState("")
  const [editedValues, setEditedValues] = useState<
    Record<string, Record<string, string>>
  >({})
  const [saving, setSaving] = useState(false)

  const languages = useQuery(
    api.languages.list,
    storeId ? { storeId } : "skip"
  )

  const overrides = useQuery(
    api.translations.getUIOverrides,
    storeId ? { storeId } : "skip"
  )

  const upsertTranslation = useMutation(api.translations.upsert)

  const activeLanguages = useMemo(
    () => ((languages ?? []) as LanguageDoc[]).filter((l) => l.isActive && !l.isDefault),
    [languages]
  )

  const filteredKeys = useMemo(() => {
    if (!search.trim()) return REFERENCE_KEYS
    const term = search.toLowerCase()
    return REFERENCE_KEYS.filter((key) => key.toLowerCase().includes(term))
  }, [search])

  const handleValueChange = (langCode: string, key: string, value: string) => {
    setEditedValues((prev) => ({
      ...prev,
      [langCode]: {
        ...(prev[langCode] ?? {}),
        [key]: value,
      },
    }))
  }

  const getDisplayValue = (langCode: string, key: string): string => {
    // Check local edits first
    if (editedValues[langCode]?.[key] !== undefined) {
      return editedValues[langCode][key]!
    }
    // Then Convex overrides
    return overrides?.[langCode]?.[key] ?? ""
  }

  const hasUnsavedChanges = Object.keys(editedValues).some(
    (lang) => Object.keys(editedValues[lang]!).length > 0
  )

  const handleSave = async () => {
    if (!storeId) return
    setSaving(true)

    try {
      const promises: Promise<unknown>[] = []

      for (const [langCode, keys] of Object.entries(editedValues)) {
        for (const [key, value] of Object.entries(keys)) {
          if (value.trim() === "") continue // Skip empty values
          promises.push(
            upsertTranslation({
              storeId,
              entityType: "ui",
              entityId: "static",
              field: key,
              languageCode: langCode,
              value,
              isAutoTranslated: false,
            })
          )
        }
      }

      await Promise.all(promises)
      setEditedValues({})
      toast.success("Traductions sauvegardées")
    } catch (error) {
      toast.error("Échec de la sauvegarde")
      console.error(error)
    } finally {
      setSaving(false)
    }
  }

  if (!storeId) {
    return (
      <EmptyState
        icon={Globe2Icon}
        title="Aucun établissement sélectionné"
        description="Veuillez sélectionner un établissement"
      />
    )
  }

  if (languages === undefined || overrides === undefined) {
    return <LoadingState />
  }

  if (activeLanguages.length === 0) {
    return (
      <EmptyState
        icon={Globe2Icon}
        title="Aucune langue secondaire"
        description="Ajoutez une langue dans l'onglet 'Langues' pour pouvoir personnaliser les traductions de l'interface"
      />
    )
  }

  const overrideCount = Object.values(overrides).reduce(
    (total: number, langOverrides) => total + Object.keys(langOverrides).length,
    0
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative w-72">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Rechercher une clé..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
              data-testid="ui-override-search"
            />
          </div>
          <Badge variant="secondary">
            {filteredKeys.length} / {REFERENCE_KEYS.length} clés
          </Badge>
          {overrideCount > 0 && (
            <Badge variant="outline">{overrideCount} overrides</Badge>
          )}
        </div>
        {hasUnsavedChanges && (
          <Button onClick={handleSave} disabled={saving}>
            <SaveIcon className="mr-2 h-4 w-4" />
            {saving ? "Sauvegarde..." : "Sauvegarder"}
          </Button>
        )}
      </div>

      <Accordion type="multiple" defaultValue={[activeLanguages[0]?.code ?? ""]}>
        {activeLanguages.map((lang) => (
          <AccordionItem key={lang.code} value={lang.code}>
            <AccordionTrigger className="text-base">
              <div className="flex items-center gap-2">
                {lang.flagEmoji && <span>{lang.flagEmoji}</span>}
                <span>{lang.nativeName}</span>
                <span className="text-xs text-muted-foreground">({lang.code})</span>
                {overrides[lang.code] && Object.keys(overrides[lang.code]!).length > 0 && (
                  <Badge variant="secondary" className="ml-2">
                    {Object.keys(overrides[lang.code]!).length} overrides
                  </Badge>
                )}
              </div>
            </AccordionTrigger>
            <AccordionContent>
              <div className="space-y-3 pt-2">
                {filteredKeys.map((key) => (
                  <div key={key} className="grid grid-cols-[200px_1fr] gap-3 items-center">
                    <Label className="text-xs font-mono text-muted-foreground truncate" title={key}>
                      {key}
                    </Label>
                    <Input
                      placeholder={`Traduction ${lang.code}...`}
                      value={getDisplayValue(lang.code, key)}
                      onChange={(e) => handleValueChange(lang.code, key, e.target.value)}
                      className="text-sm"
                    />
                  </div>
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  )
}
