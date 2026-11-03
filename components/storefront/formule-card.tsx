"use client"

/**
 * A *formule* on the carte, and the dialog that composes one (#352).
 *
 * WHAT WAS MISSING. `api.menus` had zero call sites in either app's `app/` or
 * `components/`. The admin could build formules — a 473-line tab over a 761-line
 * section builder — the guided tour promised them on first login, and the seven
 * customer-facing strings were already translated into French, English and
 * Spanish. `menu.addComboToCart` (« Ajouter la formule au panier ») was
 * referenced nowhere. Someone translated the button before anyone built it.
 *
 * NO PRICE ARITHMETIC HAPPENS HERE. The diner pays the formule's fixed price
 * whatever they choose; the à-la-carte price of each dish is shown so a
 * « supplément » is visible where one exists, and it is never summed. How the
 * bundle price is split across the dishes — which decides the VAT owed on a
 * mixed-rate formule — is `allocateBundlePrice`, server-side, and a second
 * implementation here would be a second answer.
 */

import { useMemo, useState } from "react"
import Image from "next/image"
import { Check, UtensilsCrossed } from "lucide-react"
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@be-yours/ui"
import { formatPrice, useCartStore, useTranslation } from "@be-yours/restaurant"
import type { CartMenuChoice } from "@be-yours/restaurant"
import { recordSignal } from "@be-yours/restaurant"

/** One dish a section offers, as `menus.listActive` resolves it. */
export interface FormuleChoice {
  productId: string
  name: string
  description?: string
  imageUrl?: string
  /** À la carte, for information. The diner pays the formule's price. */
  price: number
  allergens: string[]
  /** False when the dish is switched off or out of stock right now. */
  isAvailable: boolean
}

export interface FormuleSection {
  sectionId: string
  label: string
  type: "fixed" | "pick_products" | "pick_category"
  required: boolean
  minChoices: number
  maxChoices: number
  allowDuplicates: boolean
  choices: FormuleChoice[]
}

export interface Formule {
  _id: string
  name: string
  description?: string
  /** In cents, for the whole bundle. */
  price: number
  imageUrl?: string
  sections: FormuleSection[]
}

/** How many dishes a section needs, on the same rule the server applies. */
function bounds(section: FormuleSection): { min: number; max: number } {
  if (section.type === "fixed") return { min: 1, max: 1 }
  const max = Math.max(1, Math.floor(section.maxChoices) || 1)
  const min = section.required
    ? Math.min(Math.max(1, Math.floor(section.minChoices) || 1), max)
    : Math.min(Math.max(0, Math.floor(section.minChoices) || 0), max)
  return { min, max }
}

export function FormuleCard({ formule }: { formule: Formule }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const rows = formule.sections.length

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group flex w-full flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {formule.imageUrl ? (
          <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted">
            <Image
              src={formule.imageUrl}
              alt={formule.name}
              fill
              className="object-cover transition-transform group-hover:scale-105"
              sizes="(max-width: 768px) 100vw, 33vw"
            />
          </div>
        ) : (
          // No placeholder photograph. An image the establishment did not choose
          // is a claim about food it does not serve.
          <div className="flex aspect-[4/3] w-full items-center justify-center bg-muted">
            <UtensilsCrossed className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
          </div>
        )}

        <div className="flex flex-1 flex-col gap-2 p-4">
          <Badge variant="secondary" className="w-fit">
            {t("menu.combo")}
          </Badge>
          <h3 className="font-semibold leading-tight">{formule.name}</h3>
          {formule.description && (
            <p className="line-clamp-2 text-sm text-muted-foreground">
              {formule.description}
            </p>
          )}
          <div className="mt-auto flex items-baseline justify-between gap-2 pt-2">
            <span className="text-lg font-bold">{formatPrice(formule.price)}</span>
            <span className="text-xs text-muted-foreground">
              {rows} {rows > 1 ? "étapes" : "étape"}
            </span>
          </div>
        </div>
      </button>

      {/* Mounted only while open: a lunch carte of eight formules would
          otherwise hold eight composers' worth of state for nothing. */}
      {open && (
        <FormuleComposer
          formule={formule}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </>
  )
}

function FormuleComposer({
  formule,
  open,
  onOpenChange,
}: {
  formule: Formule
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const addItem = useCartStore((state) => state.addItem)

  /**
   * What has been chosen, per section.
   *
   * A LIST PER SECTION, not one value: a section may accept two desserts, and
   * `allowDuplicates` decides whether they may be the same one. Seeded with the
   * fixed rows, which are not a choice — the dish IS the section — so the
   * « Ajouter » button is enabled for a formule that is all fixed rows.
   */
  const [picked, setPicked] = useState<Record<string, string[]>>(() => {
    const seed: Record<string, string[]> = {}
    for (const section of formule.sections) {
      if (section.type === "fixed" && section.choices[0]) {
        seed[section.sectionId] = [section.choices[0].productId]
      }
    }
    return seed
  })

  const toggle = (section: FormuleSection, productId: string) => {
    const { max } = bounds(section)
    setPicked((current) => {
      const chosen = current[section.sectionId] ?? []

      if (chosen.includes(productId) && !section.allowDuplicates) {
        return { ...current, [section.sectionId]: chosen.filter((id) => id !== productId) }
      }

      // At the ceiling, a new pick REPLACES the oldest rather than being
      // ignored. A single-choice row where clicking the other dish does nothing
      // reads as a broken button; the diner's intent is unambiguous.
      const next = chosen.length >= max ? [...chosen.slice(1), productId] : [...chosen, productId]
      return { ...current, [section.sectionId]: next }
    })
  }

  /** The first section that is not yet satisfied, or null. */
  const missing = useMemo(() => {
    for (const section of formule.sections) {
      const { min } = bounds(section)
      if ((picked[section.sectionId] ?? []).length < min) return section
    }
    return null
  }, [formule.sections, picked])

  const choices: CartMenuChoice[] = useMemo(() => {
    const built: CartMenuChoice[] = []
    for (const section of formule.sections) {
      // Counted rather than repeated: two of the same dessert is one choice at
      // quantity 2, which is the shape the server's validator takes.
      const counts = new Map<string, number>()
      for (const productId of picked[section.sectionId] ?? []) {
        counts.set(productId, (counts.get(productId) ?? 0) + 1)
      }
      for (const [productId, quantity] of counts) {
        const choice = section.choices.find((c) => c.productId === productId)
        built.push({
          sectionId: section.sectionId,
          sectionLabel: section.label,
          productId,
          productName: choice?.name ?? "",
          quantity,
        })
      }
    }
    return built
  }, [formule.sections, picked])

  const add = () => {
    if (missing) return
    /* Counted here and at the two other doors into the cart — a dish page, a
       formule and the favourites grid. The cart store itself is in
       `@be-yours/restaurant`, which cannot reach the storefront's collector,
       so the emit lives at each call site and `audience-signal-sites.test.ts`
       is what stops a fourth door being added without one. */
    recordSignal("add_to_cart")
    addItem({
      // No `productId`: a formule has no single dish behind it, and the cart
      // type made the field optional for exactly this line.
      menu: { menuId: formule._id, choices },
      name: formule.name,
      price: formule.price,
      quantity: 1,
      options: [],
      ...(formule.imageUrl ? { imageUrl: formule.imageUrl } : {}),
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{formule.name}</DialogTitle>
          <DialogDescription>
            {formule.description ?? t("menu.selectOption")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {formule.sections.map((section) => {
            const { min, max } = bounds(section)
            const chosen = picked[section.sectionId] ?? []

            return (
              <fieldset key={section.sectionId} className="space-y-2">
                <legend className="flex w-full items-baseline justify-between gap-2 text-sm font-semibold">
                  <span>{section.label}</span>
                  {/* The legend sits on the dialog's own ground, which is
                      painted by `@be-yours/ui` in another file — so the
                      sweep cannot measure an ink chosen against it. The
                      inherited foreground is the one the dialog was designed
                      with. */}
                  <span className="text-xs font-normal">
                    {section.type === "fixed"
                      ? t("menu.included")
                      : max > 1
                        ? `${t("menu.pickFrom")} — ${chosen.length}/${max}`
                        : min > 0
                          ? t("menu.selectOption")
                          : `${t("menu.selectOption")} (optionnel)`}
                  </span>
                </legend>

                <ul className="space-y-1">
                  {section.choices.map((choice) => {
                    const count = chosen.filter((id) => id === choice.productId).length
                    const isFixed = section.type === "fixed"

                    return (
                      <li key={choice.productId}>
                        <button
                          type="button"
                          // A fixed row is information, not a control. Disabling
                          // it says so to a reader as well as to a mouse.
                          disabled={isFixed || !choice.isAvailable}
                          aria-pressed={count > 0}
                          onClick={() => toggle(section, choice.productId)}
                          /* ONE opaque surface, and selection expressed
                             without a second ink/surface pair.

                             Three spellings were refused before this one, each
                             by `tests/a11y/contrast.test.ts`, and the reasons are
                             worth keeping:

                             `bg-primary/5` — an alpha over a ground painted by a
                             shell in another file. `components/storefront` is
                             declared with a scope and NO surface for exactly that
                             reason, so such a pair is not measurable even in
                             principle; it is how the header over the hero
                             photograph ended up on that file's inventory of the
                             unreadable.

                             Then `bg-accent text-accent-foreground` when picked
                             against `bg-card text-card-foreground` otherwise. Two
                             colour ternaries on one element give the sweep four
                             ink/surface combinations, two of which this component
                             never renders — and those cross pairs measured
                             2.33:1 and 2.91:1, below the 4.5 floor, as findings
                             nobody could act on.

                             So: one ground, one ink, both designed together. The
                             pick is shown by the ring, the check glyph and
                             `aria-pressed`, none of which is a colour contrast
                             question. */
                          className={`flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 text-left text-sm transition-shadow disabled:cursor-default ${
                            count > 0 ? "ring-2 ring-primary" : ""
                          } ${!choice.isAvailable ? "opacity-50" : ""}`}
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium">
                              {choice.name}
                              {count > 1 && ` × ${count}`}
                            </span>
                            {!choice.isAvailable && (
                              /* No `text-muted-foreground` HERE. The row paints
                                 its own opaque ground — `--accent` when picked,
                                 `--card` otherwise — and mid-grey ink on
                                 `--accent` measures 2.4:1, below the AA floor of
                                 4.5. Inheriting the row's own foreground keeps
                                 every pair a designed one; the size carries the
                                 hierarchy instead of the colour. */
                              <span className="block text-xs">Épuisé</span>
                            )}
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            {/* The à-la-carte price, for information. The
                                formule's price does not change with the pick. */}
                            {/* Same reason as « Épuisé » above: the ink is the
                                row's, the size is the hierarchy. */}
                            <span className="text-xs tabular-nums">
                              {formatPrice(choice.price)}
                            </span>
                            {count > 0 && (
                              // `currentColor`, not `text-primary`: the glyph is
                              // part of the row's own text, and an ink chosen
                              // independently of the row's ground is one more pair
                              // to get wrong.
                              <Check className="h-4 w-4" aria-hidden="true" />
                            )}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </fieldset>
            )
          })}
        </div>

        <div className="sticky bottom-0 space-y-2 border-t border-border bg-background pt-4">
          {missing && (
            // Named rather than a disabled button with no explanation: the row
            // that is missing is the one the diner has to scroll back to.
            <p className="text-sm text-muted-foreground">
              Choisissez un plat pour « {missing.label} ».
            </p>
          )}
          <Button onClick={add} disabled={missing !== null} className="w-full">
            {t("menu.addComboToCart")} — {formatPrice(formule.price)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
