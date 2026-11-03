/// <reference types="vite/client" />

/**
 * Two email controls that were collected, stored and ignored by the sender
 * (#628).
 *
 * THE PER-STEP SEGMENT. `automation-form-dialog.tsx:413` offers « Segment
 * (optionnel) » on each step and `emailMarketing.ts:517` stores it; `runStep`
 * used `step.templateId` alone and `segmentId` appeared nowhere in the file. So
 * an owner picked « Clients VIP » for step 2 and the step mailed every active
 * subscriber. `emailSegments.ts:250` compounded it by refusing to delete a
 * segment on behalf of that dead reference.
 *
 * THE PRODUCT BLOCK. Every caller of `renderTemplateToEmailHtml` passed no
 * product data, and the renderer returns `""` without it — so a « plats de la
 * semaine » campaign went out with the section missing.
 *
 * Source-level: driving these needs a provider, an SES identity and a
 * subscriber list, and what broke is which arguments a send site passes.
 */

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const CONVEX = join(process.cwd(), "convex")

const read = (file: string): string => readFileSync(join(CONVEX, file), "utf8")

/** Comments removed: each fix is explained in one that quotes the defect. */
const code = (file: string): string =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")

describe("the per-step segment", () => {
  const body = code("emailAutomationActions.ts")

  it("is read at all, which it was not", () => {
    expect(body).toMatch(/step\.segmentId/)
  })

  it("filters the subscriber through the segment's own rules", () => {
    // The same helper a campaign uses, so a segment cannot mean two things.
    expect(body).toMatch(/buildSegmentFilter\(segment\.rules, segment\.ruleOperator\)/)
    expect(body).toMatch(/if \(!matches\(subscriber\)\) return/)
  })

  it("skips rather than sending when the segment has been deleted", () => {
    /*
     * A campaign in the same position stops the whole send rather than falling
     * back to the full list — marketing mail cannot be recalled
     * (`emailCampaignActions.ts:195`). One step for one subscriber is the same
     * judgement at a smaller scale: the audience the owner chose no longer
     * exists, so there is no send to fall back to.
     */
    const guard = body.slice(body.indexOf("if (step.segmentId)"))
    expect(guard).toMatch(/if \(!segment\)/)
    /* The refusal has to `return` BEFORE the filter is built — anything else
       falls through to matching against a segment that is not there. Bounded
       by `buildSegmentFilter` rather than by a brace, because the message
       inside the block contains braces of its own. */
    const refusal = guard.slice(
      guard.indexOf("if (!segment)"),
      guard.indexOf("buildSegmentFilter"),
    )
    expect(refusal).toMatch(/return/)
  })

  it("does not mark the step sent when it skips", () => {
    // A subscriber who does not match today must not be carried past the step.
    // `return` before the send is what leaves the run where it was.
    const at = body.indexOf("if (step.segmentId)")
    const send = body.indexOf("sendEmail(")
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(send)
  })
})

describe("the « Produit » block", () => {
  it("is resolved at the automation send", () => {
    const body = code("emailAutomationActions.ts")
    expect(body).toMatch(/productIdsInBlocks\(template\.blocks\)/)
    expect(body).toMatch(/productsForBlocksInternal/)
  })

  it("is resolved at both campaign sends, including the test send", () => {
    // The test send is how an owner checks a campaign before it goes out, so a
    // preview that silently drops the block is the one place the defect would
    // still be invisible.
    const body = code("emailCampaignActions.ts")
    expect(body.match(/productsForBlocksInternal/g)?.length).toBe(2)
  })

  it("is resolved once per campaign, not once per subscriber", () => {
    // The dishes are the same for everyone on the list; resolving inside the
    // loop would be one query per recipient.
    const body = code("emailCampaignActions.ts")
    const resolve = body.indexOf("productIdsInBlocks")
    const loopSend = body.indexOf("const html = renderTemplateToEmailHtml(template.blocks, branding, productData")
    expect(resolve).toBeGreaterThan(-1)
    expect(resolve).toBeLessThan(loopSend)
  })

  it("does not pass undefined any more", () => {
    // Anti-vacuity: the literal `undefined` at these call sites is the defect.
    for (const file of ["emailCampaignActions.ts", "emailAutomationActions.ts"]) {
      expect(code(file)).not.toMatch(/renderTemplateToEmailHtml\([^)]*,\s*undefined,/)
    }
  })
})

describe("the inbox preview line", () => {
  it("reaches the renderer from every send site", () => {
    expect(code("emailAutomationActions.ts")).toMatch(/previewText: template\.previewText/)
    const campaigns = code("emailCampaignActions.ts")
    expect(campaigns.match(/previewText: campaign\.previewText \?\? template\.previewText/g)?.length).toBe(2)
  })
})
