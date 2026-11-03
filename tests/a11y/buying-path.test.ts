/**
 * Every control a diner has to operate to place an order.
 *
 * WHAT THIS HOLDS SHUT — claims 4, 5 and 6 of #429, all measured on the bench
 * rather than argued about, and all still open when the audit re-ran them:
 *
 *   - `storefront-product-card.tsx` opened a dish from a `<div onClick>`.
 *     Measured live: `tabIndex: -1`, `role: null`. A keyboard user could not
 *     open a dish, and on this storefront that means they could not choose a
 *     REQUIRED option — so they could not order half the menu.
 *     `StoreSelectorContent.tsx` had the same shape on the screen where you
 *     pick a restaurant, which is the step before that.
 *   - 13 icon-only controls carried no accessible name, out of 162 examined:
 *     ten of them on a five-dish menu, two per dish. A fifty-dish carte is a
 *     hundred buttons that reach a screen reader as "button" and nothing else.
 *   - 17 of 35 `<Label>`s on the buying path had no `htmlFor`, and 20 of 38
 *     fields no `id` — including all five delivery-address fields at checkout.
 *
 * WHY A SOURCE SWEEP. The same reason `contrast.test.ts` gives: a browser
 * measures the pages a test mounts, and these failures were on the pages no
 * test mounts. It is a coarser instrument than an axe run — it cannot resolve a
 * name that comes from a rendered variable — so it is deliberately narrow about
 * what it calls a failure, and every rule below states what it does not catch.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, extname } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

/** The trees a diner passes through between arriving and paying. */
const REGIONS = ["app/(storefront)", "components/storefront", "app/(auth)"]

function sources(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry.startsWith(".")) continue
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (extname(entry) === ".tsx" && !entry.includes(".test.")) out.push(path)
    }
  }
  walk(root)
  return out
}

const FILES = REGIONS.flatMap((dir) => sources(dir))

function parsed(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
}

type Element = ts.JsxOpeningElement | ts.JsxSelfClosingElement

/** Every JSX element in the buying path, with the file and line it sits on. */
function elements(): Array<{
  file: string
  line: number
  tag: string
  attrs: string[]
  element: Element
  node: ts.Node
  source: ts.SourceFile
}> {
  const found: ReturnType<typeof elements> = []
  for (const file of FILES) {
    const source = parsed(file)
    const visit = (node: ts.Node): void => {
      const element: Element | null = ts.isJsxElement(node)
        ? node.openingElement
        : ts.isJsxSelfClosingElement(node)
          ? node
          : null
      if (element) {
        found.push({
          file,
          line: source.getLineAndCharacterOfPosition(element.getStart()).line + 1,
          tag: element.tagName.getText(source),
          attrs: element.attributes.properties
            .filter(ts.isJsxAttribute)
            .map((attribute) => attribute.name.getText(source)),
          element,
          node,
          source,
        })
      }
      node.forEachChild(visit)
    }
    visit(source)
  }
  return found
}

const ELEMENTS = elements()

describe("the buying path", () => {
  it("is actually being read", () => {
    // A sweep that resolves nothing reports no failures, which is the same
    // green as a sound product.
    expect(FILES.length).toBeGreaterThan(30)
    expect(ELEMENTS.length).toBeGreaterThan(1000)
  })

  it("has no click handler on an element a keyboard cannot reach", () => {
    /**
     * `onClick` on a `<div>` or a `<span>` is a control a mouse can use and a
     * keyboard cannot. It is reachable only if it ALSO carries `tabIndex` and a
     * key handler — which is what a real `<button>` gives for free.
     *
     * `<Card onClick>` counts: it renders a `<div>`. The dish card could not be
     * repaired this way because it already contains two buttons and a button
     * inside a button is not representable, so there the dish's NAME became the
     * control instead; the store card, which contains nothing, simply became
     * one.
     */
    const unreachable: string[] = []
    for (const { file, line, tag, attrs } of ELEMENTS) {
      if (!attrs.includes("onClick")) continue
      // Real controls, and anything already given a keyboard route.
      if (/^(button|a|Button|Link|input|select|textarea|label)$/.test(tag)) continue
      if (attrs.includes("onKeyDown") || attrs.includes("onKeyPress") || attrs.includes("onKeyUp")) continue
      // Radix primitives render their own button and manage their own keys.
      if (/Trigger|Item|Close|Dialog|Sheet|Popover|Tooltip|Dropdown|Accordion|Tabs/.test(tag)) continue
      if (!/^(div|span|li|tr|td|section|article|Card)$/.test(tag)) continue
      unreachable.push(`${file}:${line} — <${tag} onClick> with no keyboard route`)
    }
    expect(unreachable).toEqual([
      // The dish card's container click, which is a POINTER CONVENIENCE that
      // duplicates a control already inside it. The card holds three real
      // controls — the dish's name, the favourite toggle and add-to-basket —
      // and a keyboard user reaches the dish through the first of them. Giving
      // the container `role="button" tabIndex={0}` as well would nest a button
      // inside a button, which no browser and no screen reader can represent,
      // and would put a fourth stop in the tab order that does the same thing
      // as the first.
      //
      // Listed rather than pattern-matched: the next `<div onClick>` has to be
      // argued for here, in writing, next to this one.
      "components/storefront/storefront-product-card.tsx:60 — <div onClick> with no keyboard route",
    ])
  })

  it("gives every icon-only control a name", () => {
    /**
     * A `<button>` whose only child is an icon reaches a screen reader as
     * "button". `aria-label`, `aria-labelledby` or `title` is what makes it
     * "Ajouter Margherita au panier".
     *
     * WHAT THIS DOES NOT CATCH, stated rather than implied: a name that comes
     * from a rendered variable. A button whose child is `{label}` is counted as
     * named here, because this cannot know what `label` holds. The rule is
     * narrow on purpose — a guard that guessed would be argued with and then
     * disabled.
     */
    const ICON = /^[A-Z]\w*$/
    const unnamed: string[] = []
    for (const entry of ELEMENTS) {
      const { file, line, tag, attrs, node, source } = entry
      if (tag !== "button" && tag !== "Button") continue
      if (attrs.some((a) => /^(aria-label|aria-labelledby|title)$/.test(a))) continue
      if (!ts.isJsxElement(node)) {
        // A self-closing button has no children at all, so it has no name.
        unnamed.push(`${file}:${line} — <${tag} /> with no accessible name`)
        continue
      }
      // Any text, or any expression that is not purely an icon element, names it.
      let named = false
      const walk = (child: ts.Node): void => {
        if (named) return
        if (ts.isJsxText(child) && child.getText(source).trim()) named = true
        else if (ts.isJsxExpression(child) && child.expression) named = true
        else if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
          const childTag = (ts.isJsxElement(child) ? child.openingElement : child).tagName.getText(source)
          // A nested element that is not a bare icon component may render words.
          if (!ICON.test(childTag)) named = true
          else child.forEachChild(walk)
        } else {
          child.forEachChild(walk)
        }
      }
      node.children.forEach(walk)
      if (!named) unnamed.push(`${file}:${line} — <${tag}> with only an icon and no accessible name`)
    }
    expect(unnamed).toEqual([])
  })

  it("associates every label with the field it names", () => {
    /**
     * A `<Label>` with no `htmlFor` is a caption, not a label: clicking it
     * focuses nothing, and a screen reader announces the field as unnamed.
     *
     * Three shapes are legitimately exempt and are exempted by rule rather than
     * by a list of files:
     *   - a label carrying `id`, which something else points at with
     *     `aria-labelledby` (the option groups on a dish page do this, because
     *     they name a radiogroup rather than one input);
     *   - a `<label>` that WRAPS its own control, which associates implicitly;
     *   - a label for a GROUP of fields rather than one ("Téléphones" above a
     *     list of phone rows), which has no single field to point at.
     */
    const orphans: string[] = []
    for (const { file, line, tag, attrs, node, source } of ELEMENTS) {
      if (tag !== "Label" && tag !== "label") continue
      if (attrs.includes("htmlFor") || attrs.includes("for") || attrs.includes("id")) continue
      // Wrapping its own control?
      let wraps = false
      if (ts.isJsxElement(node)) {
        const walk = (child: ts.Node): void => {
          const el = ts.isJsxElement(child)
            ? child.openingElement
            : ts.isJsxSelfClosingElement(child)
              ? child
              : null
          if (el && /^(input|Input|textarea|Textarea|select|Select|Switch|Checkbox|RadioGroupItem)$/.test(el.tagName.getText(source))) {
            wraps = true
          }
          child.forEachChild(walk)
        }
        node.children.forEach(walk)
      }
      if (wraps) continue
      orphans.push(`${file}:${line} — <${tag}> names nothing`)
    }
    // The one group label the rule above cannot express: "Téléphones" heads a
    // LIST of phone rows, each of which carries its own `aria-label`. Listed
    // rather than pattern-matched, so a second one has to be argued for.
    expect(orphans).toEqual([
      "app/(storefront)/account/page.tsx:576 — <Label> names nothing",
    ])
  })

  it("gives every text field a name that is not just a placeholder", () => {
    /**
     * A placeholder is not an accessible name. It vanishes on the first
     * keystroke, several screen readers do not announce it, and WCAG 4.1.2 is
     * explicit that it does not satisfy the requirement.
     *
     * A field is named by an `id` a label points at, an `aria-label`, or an
     * `aria-labelledby`. A field with none of those and only a `placeholder` is
     * the failure. A field with none of those and no placeholder either is also
     * a failure, and a louder one.
     */
    const unnamed: string[] = []
    for (const { file, line, tag, attrs } of ELEMENTS) {
      if (!/^(Input|Textarea|input|textarea)$/.test(tag)) continue
      if (attrs.some((a) => /^(id|aria-label|aria-labelledby)$/.test(a))) continue
      // A hidden file input is operated through a named button, never directly.
      unnamed.push(`${file}:${line} — <${tag}> has no name, only a placeholder`)
    }
    expect(unnamed).toEqual([
      // The avatar picker: `className="hidden"`, opened by the named button
      // beside it. It is never reached on its own.
      "app/(storefront)/account/page.tsx:522 — <input> has no name, only a placeholder",
      /* A radio inside a `<label>` that wraps it — associated implicitly, which
         is the one correct way to do it without an id.

         The line moved from 332 when the photo gallery landed (#626), and that
         is the cost of pinning a LINE: every edit above one of these entries
         fails this case for a reason that has nothing to do with
         accessibility. Kept as a line rather than a file because two unnamed
         inputs in one file must not silently become one entry — the pin is
         what makes a second one visible. */
      "components/storefront/product-detail-client.tsx:377 — <input> has no name, only a placeholder",
    ])
  })
})
