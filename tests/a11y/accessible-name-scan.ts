/**
 * Every icon-only control the markup renders, checked for a name to announce.
 *
 * WHAT WCAG ASKS. 4.1.2 Name, Role, Value (Level A): every user interface
 * component exposes a name. 2.4.4 Link Purpose (In Context) (Level A) adds the
 * same for a link. A control labelled with a word satisfies both by having the
 * word; a control labelled with a 16px icon satisfies neither, because an
 * `<svg>` contributes nothing to the accessible name. A screen reader then
 * announces "button", or "link", and stops.
 *
 * WHAT FOUND IT. Not an audit — a Playwright failure. `order-detail.spec.ts`
 * matched the order screen's back button with
 * `getByRole("link", { name: /retour|orders/i })`, the branch never matched
 * anything on any run, and the `.or()` fallback beside it hid that for as long
 * as the file existed. Asked what it had resolved, Playwright answered
 * `getByRole('link').filter({ hasText: /^$/ })` — an empty name, in as many
 * words. Sweeping `packages/admin` afterwards found 15 of 28 icon-only
 * controls with no name at all: eight row menus, two back buttons, two device
 * toggles, two destructive actions and a favourite.
 *
 * WHY A SWEEP AND NOT A CHECKLIST, the same argument `target-size.ts` makes
 * next door and for the same reason: every one of those fifteen was written by
 * somebody with no reason to stop and think about it. `<Button size="icon">`
 * around a `<MoreHorizontal />` is an ordinary line of markup. A list of
 * known-bad controls is out of date on the next row menu; an instrument that
 * reads the markup catches that one on the pull request that writes it.
 *
 * WHAT COUNTS AS A NAME, in the order a browser resolves it:
 *
 *   - `aria-label`, or `aria-labelledby`
 *   - `title` — weaker, announced inconsistently, but it is a name
 *   - visible text, including a visually-hidden `sr-only` span, which is the
 *     house pattern in `Sidebar.tsx` and the one to prefer: it survives
 *     translation and shows up in a page's own text
 *
 * A control with text is not icon-only and never reaches this scan.
 *
 * WHAT IT DOES NOT CLAIM. It reads the markup, so a name arriving through a
 * spread (`{...props}`), a wrapper component's own default, or a runtime
 * expression is invisible to it and reported as missing. That direction is the
 * safe one — a false finding is answered by writing the label explicitly,
 * which is better markup anyway. The reverse, a name it cannot see being
 * assumed present, would make the guard useless. `ariaHidden` is honoured
 * because a control hidden from assistive technology has no name to give.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, relative } from "node:path"
import ts from "typescript"

/** An icon-only control that announces nothing. */
export interface UnnamedControl {
  /** Path relative to the app root, so a finding is clickable. */
  file: string
  line: number
  /** `Button`, `button`, `a`, … — what the element is. */
  tag: string
  /** A slice of the markup, so the reader recognises the control. */
  excerpt: string
}

export interface AccessibleNameOptions {
  /** The app whose source is swept. */
  appDir: string
  /** Directories under it, as `target-size.ts` takes them. */
  dirs: string[]
}

/**
 * The elements that carry a role and therefore owe a name.
 *
 * `a` is here for the defect that started this: a link with an icon and no
 * text is 2.4.4, not 4.1.2, but it fails for the same reason and is fixed the
 * same way.
 */
const INTERACTIVE = new Set(["button", "Button", "a", "Link", "IconButton"])

/** Attributes that give an element its name, however weakly. */
const NAMING = new Set(["aria-label", "aria-labelledby", "title"])

/**
 * Does this expression provably render nothing?
 *
 * `{""}`, `{null}`, `{undefined}` and an empty template are all written by
 * somebody who meant "no value here", and React renders none of them. Reading
 * only the empty STRING left `aria-label={undefined}` counting as a name and
 * `<span className="sr-only">{null}</span>` counting as a label — the same
 * hole as `aria-label=""`, one syntax along.
 *
 * Anything else — an identifier, a call, a template with a substitution — is
 * NOT provably empty and is treated as content. Guessing the other way would
 * report every dynamic label in the product.
 */
function staticallyEmpty(expression: ts.Expression): boolean {
  if (expression.kind === ts.SyntaxKind.NullKeyword) return true
  if (ts.isIdentifier(expression) && expression.text === "undefined") return true
  if (ts.isStringLiteral(expression)) return expression.text.trim() === ""
  if (ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text.trim() === ""
  return false
}

function attribute(element: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | null {
  for (const property of element.attributes.properties) {
    if (!ts.isJsxAttribute(property)) continue
    if (property.name.getText() === name) return property
  }
  return null
}

/** Is this element hidden from assistive technology outright? */
function ariaHidden(element: ts.JsxOpeningLikeElement): boolean {
  const hidden = attribute(element, "aria-hidden")
  if (!hidden) return false
  const value = hidden.initializer
  if (!value) return true
  if (ts.isStringLiteral(value)) return value.text !== "false"
  if (ts.isJsxExpression(value) && value.expression) {
    const inner = value.expression
    if (inner.kind === ts.SyntaxKind.TrueKeyword) return true
    if (inner.kind === ts.SyntaxKind.FalseKeyword) return false
    // `aria-hidden={"true"}` is the string form written as an expression, and
    // reading only the keyword form reported a control that is hidden.
    if (ts.isStringLiteral(inner)) return inner.text !== "false"
    if (ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text !== "false"
    // A dynamic value — `aria-hidden={busy}` — is not knowable here. Treated
    // as NOT hidden, so the control is still examined: reporting a control
    // that turns out to be hidden is answered by a label nobody hears, which
    // is cheap; staying silent about one that is visible is not.
    return false
  }
  return false
}

/**
 * Is this element, or anything it sits inside, hidden from assistive
 * technology?
 *
 * `aria-hidden` is INHERITED: a control inside `<div aria-hidden="true">` is
 * removed from the accessibility tree along with the div, name or no name.
 * Reading only the control's own attribute reported those — noise in a ledger
 * whose whole value is that every line in it is real.
 *
 * (Such a control is a separate defect: a focusable element inside an
 * `aria-hidden` subtree is reachable by keyboard and invisible to a screen
 * reader. That is WCAG 4.1.2 as well, and a different guard's job — naming it
 * would not fix it.)
 */
function hiddenFromAssistiveTech(node: ts.Node): boolean {
  let current: ts.Node | undefined = node
  while (current) {
    if (ts.isJsxSelfClosingElement(current) && ariaHidden(current)) return true
    if (ts.isJsxElement(current) && ariaHidden(current.openingElement)) return true
    current = current.parent
  }
  return false
}

/**
 * Does this element carry a NON-EMPTY `aria-label`, `aria-labelledby` or
 * `title`?
 *
 * `aria-label=""` is not a name. The attribute is present, a browser resolves
 * it to nothing, and a screen reader announces the role alone — which is the
 * whole defect this file exists to find. Counting the attribute rather than
 * its value made the guard blind to the one way somebody "fixes" a finding
 * without fixing anything.
 *
 * An expression — `aria-label={label}`, a template literal — is accepted: its
 * value is not knowable here, and assuming the worst would report every
 * dynamic label in the product.
 */
function named(element: ts.JsxOpeningLikeElement): boolean {
  for (const property of element.attributes.properties) {
    if (ts.isJsxSpreadAttribute(property)) continue
    if (!ts.isJsxAttribute(property)) continue
    if (!NAMING.has(property.name.getText())) continue

    const value = property.initializer
    // `aria-label` with no value at all is `true`, which names nothing.
    if (!value) continue
    if (ts.isStringLiteral(value)) {
      if (value.text.trim() === "") continue
      return true
    }
    if (ts.isJsxExpression(value)) {
      const inner = value.expression
      if (!inner) continue
      if (staticallyEmpty(inner)) continue
      return true
    }
    return true
  }
  return false
}

/**
 * Does this element contain text of its own — literal, or an expression that
 * is not purely JSX?
 *
 * Used to tell `<span className="sr-only">Fermer</span>` from
 * `<span className="sr-only" />`.
 */
function hasOwnText(node: ts.JsxElement): boolean {
  for (const child of node.children) {
    if (ts.isJsxText(child) && child.text.trim() !== "") return true
    if (ts.isJsxExpression(child)) {
      const inner = child.expression
      if (!inner) continue
      if (staticallyEmpty(inner)) continue
      if (jsxOnly(inner)) continue
      return true
    }
  }
  return false
}

/**
 * Does the subtree hold a visually-hidden label?
 *
 * `<span className="sr-only">Toggle Sidebar</span>` is a name: present in the
 * accessibility tree, absent from the page. It is the pattern `packages/ui`
 * already uses and the one worth preferring over `aria-label`.
 */
function hasVisuallyHiddenText(node: ts.Node): boolean {
  let found = false
  const visit = (child: ts.Node): void => {
    if (found) return
    if (ts.isJsxElement(child)) {
      const classes = attribute(child.openingElement, "className")
      const value = classes?.initializer
      const text =
        value && ts.isStringLiteral(value)
          ? value.text
          : value && ts.isJsxExpression(value) && value.expression
            ? value.expression.getText()
            : ""
      // The CLASS is not the name — what is inside it is. An empty
      // `<span className="sr-only" />` announces exactly as much as no span at
      // all, and accepting it would let a finding be closed by adding markup
      // that says nothing.
      if (/\bsr-only\b/.test(text) && hasOwnText(child)) {
        found = true
        return
      }
    }
    ts.forEachChild(child, visit)
  }
  ts.forEachChild(node, visit)
  return found
}

/** Is `asChild` present AND not explicitly `{false}`? */
function asChildEnabled(element: ts.JsxOpeningLikeElement): boolean {
  const slot = attribute(element, "asChild")
  if (!slot) return false
  const value = slot.initializer
  // Bare `asChild` is `true`.
  if (!value) return true
  if (ts.isJsxExpression(value) && value.expression) {
    return value.expression.kind !== ts.SyntaxKind.FalseKeyword
  }
  return true
}

/**
 * Does a wrapping `asChild` element supply this control's name?
 *
 * Radix's `Slot` merges the wrapper's props onto its single child, so
 * `<Button asChild aria-label="Retour"><Link …><ArrowLeft/></Link></Button>`
 * renders ONE `<a>` carrying the label. Read naively the inner `Link` looks
 * unnamed, and reporting it would push the label onto the child — markup that
 * is no better and no worse, chosen by the scanner rather than the author.
 *
 * THE IMMEDIATE PARENT, AND ONLY IT. `Slot` merges onto the one child it is
 * given; it does not reach a grandchild. Walking the whole ancestor chain —
 * which this did — meant a named `asChild` wrapper silenced every control
 * nested anywhere beneath it:
 *
 *     <Button asChild aria-label="Retour">
 *       <Link href="/x">
 *         <span><button><X/></button></span>   ← NOT named, but was skipped
 *       </Link>
 *     </Button>
 *
 * A named `<div>` around a button names nothing either, for the same reason:
 * the attribute has to be on the slot.
 */
function namedByAsChildParent(node: ts.Node): boolean {
  const parent = node.parent
  if (!parent || !ts.isJsxElement(parent)) return false

  const element = parent.openingElement
  // `asChild={false}` renders the wrapper itself, so it merges nothing and
  // names nothing. Reading the attribute's presence rather than its value
  // would let a named `<Button asChild={false}>` silence a genuinely unnamed
  // child.
  return asChildEnabled(element) && named(element)
}

/**
 * An element with no text of its own — the same question `target-size.ts`
 * asks, and deliberately the same answer.
 *
 * Kept as its own copy rather than exported from there because the two guards
 * must be able to disagree later without one silently changing the other's
 * scope: this one wants `<a>` and that one does not.
 */
function isIconOnly(node: ts.JsxElement): boolean {
  let sawElement = false
  let sawText = false

  const walk = (parent: ts.JsxElement | ts.JsxFragment): void => {
    for (const child of parent.children) {
      if (sawText) return
      if (ts.isJsxText(child)) {
        if (child.text.trim() !== "") sawText = true
        continue
      }
      if (ts.isJsxExpression(child)) {
        const inner = child.expression
        if (!inner) continue
        // `{null}` renders nothing, so it is not text — and reading it as text
        // made the whole control "not icon-only", which skipped it from the
        // scan entirely rather than merely mis-naming it.
        if (staticallyEmpty(inner)) continue
        if (jsxOnly(inner)) {
          sawElement = true
          continue
        }
        sawText = true
        continue
      }
      if (ts.isJsxElement(child)) {
        sawElement = true
        walk(child)
        continue
      }
      if (ts.isJsxFragment(child)) {
        walk(child)
        continue
      }
      if (ts.isJsxSelfClosingElement(child)) sawElement = true
    }
  }

  walk(node)
  return sawElement && !sawText
}

/**
 * Does this expression evaluate to JSX and nothing else?
 *
 * `{loading && <Loader2/>}` is an icon written as a condition, and it is the
 * commonest spelling in this codebase — a spinner beside a label, a check
 * beside a selected row. Treating `&&` as text made every control using it
 * "not icon-only", so the scan skipped it entirely: a button with a
 * conditional icon and nothing else was never examined at all.
 */
function jsxOnly(node: ts.Expression): boolean {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
    return true
  }
  if (ts.isConditionalExpression(node)) {
    return jsxOnly(node.whenTrue) && jsxOnly(node.whenFalse)
  }
  if (ts.isBinaryExpression(node)) {
    // `cond && <Icon/>` and `a ?? <Icon/>`: the JSX is what can render.
    const operator = node.operatorToken.kind
    if (
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return jsxOnly(node.right)
    }
    return false
  }
  if (ts.isParenthesizedExpression(node)) return jsxOnly(node.expression)
  return false
}

/** Every `.tsx` under `root`, tests and generated trees excluded. */
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
      if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) {
        if (entry === "__tests__" || entry === "tests" || entry === "e2e") continue
        walk(path)
      } else if (
        extname(entry) === ".tsx" &&
        // `.test.` was the only one excluded, and `.spec.`/`.stories.` are the
        // same kind of file. None exists in the swept regions today; the
        // exclusion is here so the first one added does not land in the ledger.
        ![".test.", ".spec.", ".stories."].some((mark) => entry.includes(mark))
      ) {
        out.push(path)
      }
    }
  }
  walk(root)
  return out
}

/**
 * Every icon-only control, named or not.
 *
 * WHY THIS IS EXPORTED. A scanner that resolves nothing reports nothing, and
 * "no findings" then reads exactly like "no failures" — the trap
 * `contrast.test.ts` was written to close and `target-size.ts` answers by
 * raising its floor past every real control. There is no floor to raise here,
 * so the liveness check needs the other half of the question: how many
 * controls did the walk actually see? A count that falls to nothing means the
 * scan stopped reading the markup.
 */
export function scanIconOnlyControls(options: AccessibleNameOptions): UnnamedControl[] {
  return collect(options, { onlyUnnamed: false })
}

/** Every icon-only control that announces nothing. */
export function scanAccessibleNames(options: AccessibleNameOptions): UnnamedControl[] {
  return collect(options, { onlyUnnamed: true })
}

function collect(
  options: AccessibleNameOptions,
  { onlyUnnamed }: { onlyUnnamed: boolean }
): UnnamedControl[] {
  const findings: UnnamedControl[] = []
  const seen = new Set<string>()

  for (const dir of options.dirs) {
    for (const file of sources(join(options.appDir, dir))) {
      if (seen.has(file)) continue
      seen.add(file)

      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      )

      /*
       * ONE PATH FOR BOTH SPELLINGS. `<Button>…</Button>` is a `JsxElement`
       * and `<Link href=… />` is a `JsxSelfClosingElement` — different node
       * kinds for the same question. They were handled by two branches, and
       * the second one drifted immediately: it ignored `onlyUnnamed`, so
       * `scanIconOnlyControls` under-counted, and it skipped
       * `namedByAsChildParent`, so a self-closing child of a named `asChild`
       * wrapper was reported although the slot names it.
       *
       * Asked once, the two cannot disagree. The only genuine difference is
       * that a self-closing element has no children: nothing to read for text,
       * so it is icon-only by construction and `hasVisuallyHiddenText` has
       * nothing to look at.
       */
      const visit = (node: ts.Node): void => {
        const selfClosing = ts.isJsxSelfClosingElement(node)
        const opening = selfClosing
          ? node
          : ts.isJsxElement(node)
            ? node.openingElement
            : null

        if (opening) {
          const tag = opening.tagName.getText()
          const element = ts.isJsxElement(node) ? node : null

          const iconOnly = element ? isIconOnly(element) : true
          const unnamed =
            !named(opening) &&
            !(element ? hasVisuallyHiddenText(element) : false) &&
            !namedByAsChildParent(node)

          if (
            INTERACTIVE.has(tag) &&
            !hiddenFromAssistiveTech(node) &&
            iconOnly &&
            (unnamed || !onlyUnnamed)
          ) {
            const { line } = source.getLineAndCharacterOfPosition(opening.getStart(source))
            findings.push({
              file: relative(options.appDir, file),
              line: line + 1,
              tag,
              excerpt: opening.getText(source).replace(/\s+/g, " ").slice(0, 100),
            })
          }
        }
        ts.forEachChild(node, visit)
      }

      visit(source)
    }
  }

  return findings
}

/** One line per finding, for an assertion somebody has to act on. */
export function formatUnnamed(controls: UnnamedControl[]): string {
  if (controls.length === 0) {
    return "Every icon-only control has an accessible name."
  }
  return [
    `${controls.length} icon-only control(s) announce nothing (WCAG 4.1.2, 2.4.4):`,
    ...controls.map((c) => `  ${c.file}:${c.line}  <${c.tag}>  ${c.excerpt}`),
    "",
    'Give each one an aria-label, or a visually-hidden <span className="sr-only">.',
  ].join("\n")
}
