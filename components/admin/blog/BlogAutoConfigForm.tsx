"use client"

import { useState, useEffect, useRef } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useMutation, useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import { convexErrorMessage } from "@/lib/convex-error"
import type { Id } from "@/convex/_generated/dataModel"
import { toast } from "sonner"
import { Plus, X, Loader2, AlertTriangle } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Button,
  Badge,
  Input,
  Separator,
  Label,
  Switch,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@be-yours/ui"
// ─── Types ───────────────────────────────────────────────────────────────────────

interface AutoBlogAccess {
  allowed: boolean
  reason?: string
  entitlements: {
    autoBlog: {
      enabled: boolean
      plan?: string
      monthlyQuota: number
      maxTopics?: number
      allowMultiLanguage: boolean
      allowAutoPublish: boolean
    }
  } | null
  usage: { generatedCount: number; publishedCount: number } | null
  remainingQuota: number
}

// ─── Schema ──────────────────────────────────────────────────────────────────────

const formSchema = z.object({
  isEnabled: z.boolean(),
  themes: z.array(z.string()).min(1, "Au moins un sujet est requis"),
  frequency: z.enum(["weekly", "monthly"]),
  preferredWeekdays: z.array(z.number().min(0).max(6)).optional(),
  preferredMonthDays: z.array(z.number().min(1).max(28)).optional(),
  preferredHour: z.number().min(0).max(23),
  timezone: z.string(),
  tone: z.enum(["formel", "decontracte", "storytelling"]),
  primaryLocale: z.string().min(1),
  autoTranslate: z.boolean(),
  approvalMode: z.enum(["draft_review", "auto_publish"]),
  categoryId: z.string().optional(),
})

type FormData = z.infer<typeof formSchema>

// ─── Constants ───────────────────────────────────────────────────────────────────

const WEEKDAYS = [
  "Lundi",
  "Mardi",
  "Mercredi",
  "Jeudi",
  "Vendredi",
  "Samedi",
  "Dimanche",
]

const TONE_OPTIONS = [
  { value: "formel", label: "Formel" },
  { value: "decontracte", label: "Décontracté" },
  { value: "storytelling", label: "Storytelling" },
]

// ─── Component ───────────────────────────────────────────────────────────────────

interface BlogAutoConfigFormProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any | null
  accessStatus: AutoBlogAccess
  storeId: Id<"stores">
}

export function BlogAutoConfigForm({
  config,
  accessStatus,
  storeId,
}: BlogAutoConfigFormProps) {
  const upsert = useMutation(api.blogAutoConfig.upsert)
  const languages = useQuery(api.languages.list, storeId ? { storeId } : "skip")
  const categories = useQuery(
    api.blog.listCategories,
    storeId ? { storeId } : "skip"
  )

  const ab = accessStatus.entitlements?.autoBlog
  const allowAutoPublish = ab?.allowAutoPublish ?? false
  const allowMultiLanguage = ab?.allowMultiLanguage ?? false
  const maxTopics = ab?.maxTopics as number | undefined
  const planName = ab?.plan ?? "starter"

  const monthlyQuota = ab?.monthlyQuota ?? 0
  const maxWeekdays = Math.min(monthlyQuota, 7)
  const maxMonthDays = Math.min(monthlyQuota, 28)

  // ─── Build defaults (pure, no side effects) ────────────────────────────────
  function buildDefaults(): { defaults: FormData; wasCoerced: boolean } {
    if (!config) {
      return {
        wasCoerced: false,
        defaults: {
          isEnabled: false,
          themes: [],
          frequency: "weekly",
          preferredWeekdays: [1],
          preferredMonthDays: [1],
          preferredHour: 9,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          tone: "decontracte",
          primaryLocale: "fr",
          autoTranslate: false,
          approvalMode: "draft_review",
          categoryId: undefined,
        },
      }
    }

    let wasCoerced = false
    let themes = config.themes as string[]
    let approvalMode = config.approvalMode as "draft_review" | "auto_publish"
    let autoTranslate = config.autoTranslate as boolean

    // Backward compat: old single number → array
    let preferredWeekdays: number[] = Array.isArray(config.preferredWeekdays)
      ? (config.preferredWeekdays as number[])
      : config.preferredWeekday !== undefined
        ? [config.preferredWeekday as number]
        : [1]

    let preferredMonthDays: number[] = Array.isArray(config.preferredMonthDays)
      ? (config.preferredMonthDays as number[])
      : config.preferredMonthDay !== undefined
        ? [config.preferredMonthDay as number]
        : [1]

    if (maxTopics !== undefined && themes.length > maxTopics) {
      themes = themes.slice(0, maxTopics)
      wasCoerced = true
    }
    if (!allowAutoPublish && approvalMode === "auto_publish") {
      approvalMode = "draft_review"
      wasCoerced = true
    }
    if (!allowMultiLanguage && autoTranslate) {
      autoTranslate = false
      wasCoerced = true
    }

    // Coerce days on downgrade
    if (preferredWeekdays.length > maxWeekdays && maxWeekdays > 0) {
      preferredWeekdays = preferredWeekdays.slice(0, maxWeekdays)
      wasCoerced = true
    }
    if (preferredMonthDays.length > maxMonthDays && maxMonthDays > 0) {
      preferredMonthDays = preferredMonthDays.slice(0, maxMonthDays)
      wasCoerced = true
    }

    return {
      wasCoerced,
      defaults: {
        isEnabled: config.isEnabled,
        themes,
        frequency: config.frequency,
        preferredWeekdays,
        preferredMonthDays,
        preferredHour: config.preferredHour,
        timezone: config.timezone,
        tone: config.tone,
        primaryLocale: config.primaryLocale,
        autoTranslate,
        approvalMode,
        categoryId: config.categoryId ?? undefined,
      },
    }
  }

  // Compute once, no state setter during render
  const { defaults: initialDefaults, wasCoerced: initialCoerced } = buildDefaults()
  const [coerced, setCoerced] = useState(initialCoerced)

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: initialDefaults,
  })

  const frequency = watch("frequency")
  const themes = watch("themes")
  const isEnabled = watch("isEnabled")

  // ─── Reset primaryLocale when languages load and no config ────────────────────
  const languagesLoadedRef = useRef(false)
  useEffect(() => {
    if (languages && !languagesLoadedRef.current && !config) {
      languagesLoadedRef.current = true
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const defaultLang = languages.find((l: any) => l.isDefault)
      if (defaultLang) {
        setValue("primaryLocale", defaultLang.code)
      }
    }
  }, [languages, config, setValue])

  // ─── Theme input ──────────────────────────────────────────────────────────────
  const [themeInput, setThemeInput] = useState("")

  const addTheme = () => {
    const trimmed = themeInput.trim()
    if (!trimmed) return
    if (themes.includes(trimmed)) {
      toast.error("Ce sujet existe déjà")
      return
    }
    setValue("themes", [...themes, trimmed], { shouldDirty: true })
    setThemeInput("")
  }

  const removeTheme = (index: number) => {
    setValue(
      "themes",
      themes.filter((_, i) => i !== index),
      { shouldDirty: true }
    )
  }

  const canAddTheme = maxTopics === undefined || themes.length < maxTopics

  // ─── Submit ───────────────────────────────────────────────────────────────────
  const onSubmit = async (data: FormData) => {
    try {
      await upsert({
        storeId,
        isEnabled: data.isEnabled,
        themes: data.themes,
        frequency: data.frequency,
        preferredWeekdays:
          data.frequency === "weekly" ? data.preferredWeekdays : undefined,
        preferredMonthDays:
          data.frequency === "monthly" ? data.preferredMonthDays : undefined,
        preferredHour: data.preferredHour,
        timezone: data.timezone,
        tone: data.tone,
        primaryLocale: data.primaryLocale,
        autoTranslate: data.autoTranslate,
        approvalMode: data.approvalMode,
        categoryId: data.categoryId
          ? (data.categoryId as Id<"blogCategories">)
          : undefined,
      })
      toast.success("Configuration enregistrée")
      setCoerced(false)
    } catch (err) {
      toast.error(
        convexErrorMessage(err, {}, "Erreur lors de l'enregistrement")
      )
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {/* Downgrade warning banner */}
      {coerced && (
        <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4">
          <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-medium text-warning">
              Certains réglages ont été ajustés
            </p>
            <p className="text-warning mt-0.5">
              Suite au changement de plan, certaines valeurs ont été
              automatiquement corrigées. Enregistrez pour appliquer.
            </p>
          </div>
        </div>
      )}

      {/* Section 1 — Activation */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Activation</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="isEnabled" className="text-sm font-medium">
                Activer l&apos;Auto Blog
              </Label>
              <p className="text-sm text-muted-foreground mt-0.5">
                Active la génération automatique d&apos;articles.
              </p>
            </div>
            <Switch
              id="isEnabled"
              checked={isEnabled}
              onCheckedChange={(checked) =>
                setValue("isEnabled", checked, { shouldDirty: true })
              }
            />
          </div>
        </CardContent>
      </Card>

      {/* Section 2 — Sujets */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Sujets</CardTitle>
          <CardDescription>
            Les thématiques pour la génération d&apos;articles.
            {maxTopics !== undefined && (
              <span className="ml-1">
                ({themes.length}/{maxTopics} sur votre plan{" "}
                {planName.charAt(0).toUpperCase() + planName.slice(1)})
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder="Ex: recettes de saison, nouveautés..."
              value={themeInput}
              onChange={(e) => setThemeInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  addTheme()
                }
              }}
              disabled={!canAddTheme}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={addTheme}
              disabled={!canAddTheme || !themeInput.trim()}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>

          {themes.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {themes.map((theme, idx) => (
                <Badge
                  key={idx}
                  variant="secondary"
                  className="gap-1 pr-1"
                >
                  {theme}
                  <button
                    type="button"
                    onClick={() => removeTheme(idx)}
                    className="ml-1 inline-flex size-6 items-center justify-center rounded-full hover:bg-muted"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}

          {errors.themes && (
            <p className="text-sm text-destructive">{errors.themes.message}</p>
          )}
        </CardContent>
      </Card>

      {/* Section 3 — Planification */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Planification</CardTitle>
          <CardDescription>
            Quand les articles doivent être générés.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Fréquence</Label>
            <Select
              value={frequency}
              onValueChange={(val) =>
                setValue("frequency", val as "weekly" | "monthly", {
                  shouldDirty: true,
                })
              }
            >
              <SelectTrigger className="sm:w-[240px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="weekly">Hebdomadaire</SelectItem>
                <SelectItem value="monthly">Mensuel</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {frequency === "weekly" && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Jours de publication</Label>
                <span className="text-xs text-muted-foreground">
                  {(watch("preferredWeekdays") ?? []).length}/{maxWeekdays} jour(s)
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {WEEKDAYS.map((day, idx) => {
                  const selected = (watch("preferredWeekdays") ?? []).includes(idx)
                  const atMax = (watch("preferredWeekdays") ?? []).length >= maxWeekdays
                  return (
                    <Button
                      key={idx}
                      type="button"
                      size="sm"
                      variant={selected ? "default" : "outline"}
                      disabled={!selected && atMax}
                      onClick={() => {
                        const current = watch("preferredWeekdays") ?? []
                        if (selected) {
                          if (current.length > 1) {
                            setValue(
                              "preferredWeekdays",
                              current.filter((d) => d !== idx).sort((a, b) => a - b),
                              { shouldDirty: true }
                            )
                          }
                        } else if (!atMax) {
                          setValue(
                            "preferredWeekdays",
                            [...current, idx].sort((a, b) => a - b),
                            { shouldDirty: true }
                          )
                        }
                      }}
                      className="min-w-[56px]"
                    >
                      {day.slice(0, 3)}
                    </Button>
                  )
                })}
              </div>
            </div>
          )}

          {frequency === "monthly" && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Jours du mois</Label>
                <span className="text-xs text-muted-foreground">
                  {(watch("preferredMonthDays") ?? []).length}/{maxMonthDays} jour(s)
                </span>
              </div>
              <div className="grid grid-cols-7 gap-1.5">
                {Array.from({ length: 28 }, (_, i) => i + 1).map((day) => {
                  const selected = (watch("preferredMonthDays") ?? []).includes(day)
                  const atMax = (watch("preferredMonthDays") ?? []).length >= maxMonthDays
                  return (
                    <Button
                      key={day}
                      type="button"
                      size="sm"
                      variant={selected ? "default" : "outline"}
                      disabled={!selected && atMax}
                      onClick={() => {
                        const current = watch("preferredMonthDays") ?? []
                        if (selected) {
                          if (current.length > 1) {
                            setValue(
                              "preferredMonthDays",
                              current.filter((d) => d !== day).sort((a, b) => a - b),
                              { shouldDirty: true }
                            )
                          }
                        } else if (!atMax) {
                          setValue(
                            "preferredMonthDays",
                            [...current, day].sort((a, b) => a - b),
                            { shouldDirty: true }
                          )
                        }
                      }}
                      className="h-9 w-full px-0"
                    >
                      {day}
                    </Button>
                  )
                })}
              </div>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Heure préférée</Label>
              <Select
                value={String(watch("preferredHour"))}
                onValueChange={(val) =>
                  setValue("preferredHour", Number(val), { shouldDirty: true })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 24 }, (_, i) => i).map((h) => (
                    <SelectItem key={h} value={String(h)}>
                      {String(h).padStart(2, "0")}:00
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Fuseau horaire</Label>
              <Input
                {...register("timezone")}
                readOnly
                className="bg-muted cursor-default"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Section 4 — Style & Langue */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Style & Langue</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Ton</Label>
              <Select
                value={watch("tone")}
                onValueChange={(val) =>
                  setValue(
                    "tone",
                    val as "formel" | "decontracte" | "storytelling",
                    { shouldDirty: true }
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TONE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Langue principale</Label>
              <Select
                value={watch("primaryLocale")}
                onValueChange={(val) =>
                  setValue("primaryLocale", val, { shouldDirty: true })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {languages ? (
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    languages.map((lang: any) => (
                      <SelectItem key={lang.code} value={lang.code}>
                        {lang.name}
                      </SelectItem>
                    ))
                  ) : (
                    <SelectItem value="fr">Français</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <Label
                htmlFor="autoTranslate"
                className="text-sm font-medium"
              >
                Traduction automatique
              </Label>
              {!allowMultiLanguage ? (
                <p className="text-sm text-muted-foreground mt-0.5">
                  Disponible avec le plan Enterprise.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground mt-0.5">
                  Traduit automatiquement les articles dans les langues actives.
                </p>
              )}
            </div>
            <Switch
              id="autoTranslate"
              checked={watch("autoTranslate")}
              onCheckedChange={(checked) =>
                setValue("autoTranslate", checked, { shouldDirty: true })
              }
              disabled={!allowMultiLanguage}
            />
          </div>
        </CardContent>
      </Card>

      {/* Section 5 — Publication */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Publication</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Mode de publication</Label>
            <Select
              value={watch("approvalMode")}
              onValueChange={(val) =>
                setValue(
                  "approvalMode",
                  val as "draft_review" | "auto_publish",
                  { shouldDirty: true }
                )
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="draft_review">
                  Brouillon pour relecture
                </SelectItem>
                <SelectItem
                  value="auto_publish"
                  disabled={!allowAutoPublish}
                >
                  Publication automatique
                  {!allowAutoPublish && " (Pro / Enterprise)"}
                </SelectItem>
              </SelectContent>
            </Select>
            {!allowAutoPublish && (
              <p className="text-sm text-muted-foreground">
                La publication automatique est disponible avec les plans Pro et
                Enterprise.
              </p>
            )}
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>Catégorie par défaut</Label>
            <Select
              value={watch("categoryId") ?? "__none__"}
              onValueChange={(val) =>
                setValue("categoryId", val === "__none__" ? undefined : val, {
                  shouldDirty: true,
                })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Aucune catégorie" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Aucune catégorie</SelectItem>
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {categories?.map((cat: any) => (
                  <SelectItem key={cat._id} value={cat._id}>
                    {cat.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Section 6 — Actions */}
      <div className="sticky bottom-0 z-10 -mx-4 border-t bg-background px-4 py-4 sm:-mx-6 sm:px-6">
        <Button
          type="submit"
          disabled={isSubmitting || (!isDirty && !coerced)}
        >
          {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Enregistrer
        </Button>
      </div>
    </form>
  )
}
