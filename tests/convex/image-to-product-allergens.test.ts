/**
 * What the AI extractor is allowed to write into `products.allergens`.
 *
 * `imageToProduct.analyze` is the only thing in production that fills that
 * field without a human typing the value. It used to ask GPT, in French, for
 * "les allergènes très probables" and store the prose that came back, so the
 * database filled up with wordings that resolve against nothing — which is how
 * an unrecognised value got in front of a diner in the first place.
 *
 * Two properties are held here:
 *
 *   1. The prompt offers the model the canonical vocabulary rather than free
 *      prose, and offers it to BOTH vision paths (single dish and menu photo).
 *   2. Whatever comes back is resolved through the one vocabulary before it is
 *      stored — and a value that still does not resolve is kept, not dropped.
 */

import { describe, expect, test } from "vitest"
import {
  ALLERGEN_KIND,
  KNOWN_ALLERGENS,
  resolveAllergens,
} from "@be-yours/core/allergens"
import { singleProductVisionSchema } from "@be-yours/convex-schema/validators"
import {
  MENU_SYSTEM_PROMPT,
  SINGLE_SYSTEM_PROMPT,
  normalizeExtractedAllergens,
} from "../../convex/imageToProduct"

const ALLERGEN_KEYS = KNOWN_ALLERGENS.filter((a) => ALLERGEN_KIND[a] === "allergen")
const DIET_KEYS = KNOWN_ALLERGENS.filter((a) => ALLERGEN_KIND[a] === "diet")

const PROMPTS: Array<[string, string]> = [
  ["single dish", SINGLE_SYSTEM_PROMPT],
  ["menu photo", MENU_SYSTEM_PROMPT],
]

describe("vision prompts", () => {
  test.each(PROMPTS)("%s prompt offers every canonical allergen", (_name, prompt) => {
    for (const key of ALLERGEN_KEYS) {
      expect(prompt).toContain(key)
    }
  })

  test.each(PROMPTS)("%s prompt offers the vocabulary as one list", (_name, prompt) => {
    // The list is built from KNOWN_ALLERGENS, so a name added to the
    // vocabulary reaches the model without anybody editing this prompt.
    expect(prompt).toContain(ALLERGEN_KEYS.join(", "))
  })

  test.each(PROMPTS)("%s prompt does not offer the dietary markers", (_name, prompt) => {
    // They are part of the vocabulary but they are not allergens, and an
    // allergen field is not where a diner should meet them.
    for (const key of DIET_KEYS) {
      expect(prompt).not.toContain(key)
    }
  })
})

describe("normalizeExtractedAllergens", () => {
  test("maps recognised spellings to canonical keys", () => {
    expect(
      normalizeExtractedAllergens([
        "Gluten de blé",
        "Œufs",
        "Fruits à coque",
        "MOUTARDE",
      ])
    ).toEqual(["gluten", "eggs", "nuts", "mustard"])
  })

  test("keeps the order the model answered in", () => {
    expect(normalizeExtractedAllergens(["Lait", "Blé"])).toEqual(["dairy", "gluten"])
  })

  test("collapses two spellings of one allergen", () => {
    expect(normalizeExtractedAllergens(["Lactose", "lait", "MILK"])).toEqual(["dairy"])
  })

  test("drops empty and whitespace-only answers", () => {
    expect(normalizeExtractedAllergens(["", "   ", "gluten"])).toEqual(["gluten"])
  })

  test("preserves a value the vocabulary does not recognise", () => {
    // It may name a real allergen this list has never heard of. Dropping it
    // would delete a declaration; canonicalising it would invent one.
    expect(normalizeExtractedAllergens(["gluten", "sarrasin"])).toEqual([
      "gluten",
      "sarrasin",
    ])
  })

  test("preserves a negated answer instead of inverting it", () => {
    // "gluten ✗" says the dish has none. Resolving it to `gluten` would
    // announce the exact opposite of what the model reported.
    expect(normalizeExtractedAllergens(["gluten ✗"])).toEqual(["gluten ✗"])
  })

  test("its output resolves cleanly against the vocabulary", () => {
    const stored = normalizeExtractedAllergens(["Céréales contenant du gluten", "sarrasin"])
    expect(resolveAllergens(stored)).toEqual([
      { raw: "gluten", allergen: "gluten", kind: "allergen", label: "Gluten" },
      { raw: "sarrasin", allergen: null, kind: "unverified", label: "sarrasin" },
    ])
  })

  test("does not weaken the vision schema, which still accepts free text", () => {
    // The stored column is free text and stays that way: the model is steered,
    // not constrained by the parser. The normalisation happens after the parse.
    const parsed = singleProductVisionSchema.parse({
      name: "Tarte au citron",
      description: "Tarte au citron meringuée, pâte sablée maison.",
      price: 6.5,
      ingredients: ["citron", "oeufs", "beurre"],
      allergens: ["Gluten de blé", "Œufs", "sarrasin"],
      detectedCategoryName: null,
      suggestedCategoryName: "Dessert",
      warnings: [],
    })

    expect(parsed.allergens).toEqual(["Gluten de blé", "Œufs", "sarrasin"])
    expect(normalizeExtractedAllergens(parsed.allergens)).toEqual([
      "gluten",
      "eggs",
      "sarrasin",
    ])
  })
})
