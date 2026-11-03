/// <reference types="vite/client" />

/**
 * An invoice can be read back (#622).
 *
 * `grep "^export const" convex/invoices.ts` returned exactly one line —
 * `issueForOrder` — with no list query, no per-order read, no PDF, no HTML, no
 * email, no download. `documentsForOrder` existed in the engine, its docblock
 * saying *"the answer differs between the storefront and the admin"*, with
 * **zero production callers**.
 *
 * `CLAUDE.md` calls the invoice "a numbered fiscal document in an unbroken
 * series (art. 242 nonies A CGI)", and the numbering genuinely is gapless. An
 * unbroken series nobody can read is not a fiscal document; it is a database
 * row. That is why the feature ledger moved PAY8 from "ships" to "partial".
 */

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const CONVEX = join(process.cwd(), "convex")

const code = (file: string): string =>
  readFileSync(join(CONVEX, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")

describe("the invoice module", () => {
  const body = code("invoices.ts")

  it("exports more than a way to issue one", () => {
    const exports = [...body.matchAll(/^export const (\w+)/gm)].map((m) => m[1])
    expect(exports).toContain("issueForOrder")
    expect(exports).toContain("listForOrder")
    expect(exports).toContain("listForStore")
    expect(exports).toContain("renderById")
  })

  it("gives `documentsForOrder` the production caller it never had", () => {
    expect(body).toMatch(/documentsForOrder\(ctx, args\.orderId\)/)
  })

  it("gates every read on payments:read, not payments:write", () => {
    // Reading a receipt is not issuing one, and a manager who can see the
    // turnover can see what was invoiced.
    for (const name of ["listForOrder", "listForStore", "renderById"]) {
      const at = body.indexOf(`export const ${name}`)
      const block = body.slice(at, body.indexOf("handler", at))
      expect(block, name).toMatch(/permission: "payments:read"/)
    }
  })

  it("scopes a read by id to the establishment that issued it", () => {
    // An invoice id is an opaque string a caller could hold from another
    // establishment, so the wrapper resolves the store from the document.
    const at = body.indexOf("export const renderById")
    const block = body.slice(at, body.indexOf("handler:", at))
    expect(block).toMatch(/storeIdFrom/)
    expect(block).toMatch(/invoice\.storeId/)
  })

  it("renders from the stored row and nothing else", () => {
    /*
     * An invoice is frozen at issue (art. 242 nonies A CGI). A renderer that
     * consulted a live setting would restate a document already given to a
     * customer — which is exactly what `globalSettings` would do if it were
     * read here.
     */
    const at = body.indexOf("export const renderById")
    const block = body.slice(at)
    expect(block).not.toMatch(/globalSettings/)
    expect(block).toMatch(/renderInvoiceHtml\(/)
  })
})

/*
 * NOT ASSERTED HERE: that `invoicesForStore` is bounded.
 *
 * It is an engine fact, and this file ships inside a client clone that has no
 * `packages/` — `shipped-tests-stay-in-the-app.test.ts` exists because a test
 * reaching above the app root fails LOUDLY in the mirror (ENOENT, the sync
 * refused) or QUIETLY (an `existsSync` guard returning an empty list, and a
 * number that is wrong). The assertion lives in
 * `packages/convex-functions/src/__tests__/invoiceHtml.test.ts`, beside the
 * code it is about.
 */
