/**
 * Reading a refusal out of a ConvexError.
 *
 * The reason this exists at all: Convex redacts the message of a plainly thrown
 * `Error` in production, so the UI receives "Server Error" for a wrong token, a
 * missing configuration and an already-taken seat alike. `data` survives, and
 * these tests pin the two forms it arrives in — an object from the browser
 * client, a JSON string from `convex-test`. A reader that handles only one of
 * them degrades to a generic message on exactly the side nobody exercised.
 */

import { describe, expect, it } from "vitest"
import {
  convexErrorCode,
  convexErrorMessage,
  convexErrorPayload,
} from "../lib/convex-error"

const MESSAGES = {
  bootstrap_token_invalid: "Jeton d'amorçage invalide.",
  invitation_expired: "Cette invitation a expiré.",
}
const FALLBACK = "Une erreur est survenue."

describe("convexErrorPayload", () => {
  it("reads an object payload, as the browser client delivers it", () => {
    const error = { data: { code: "invitation_expired", message: "Expirée." } }

    expect(convexErrorPayload(error)).toEqual({
      code: "invitation_expired",
      message: "Expirée.",
    })
  })

  it("reads a serialized payload, as convex-test delivers it", () => {
    const error = {
      data: JSON.stringify({ code: "invitation_expired", message: "Expirée." }),
    }

    expect(convexErrorPayload(error)).toEqual({
      code: "invitation_expired",
      message: "Expirée.",
    })
  })

  it.each([
    ["a plain Error", new Error("Server Error")],
    ["null", null],
    ["undefined", undefined],
    ["data that is not JSON", { data: "Server Error" }],
    ["data without a code", { data: { message: "no code here" } }],
    ["a non-string code", { data: { code: 42 } }],
  ])("returns null for %s", (_label, error) => {
    expect(convexErrorPayload(error)).toBeNull()
  })

  it("tolerates a payload whose message is missing", () => {
    expect(convexErrorPayload({ data: { code: "not_found" } })).toEqual({
      code: "not_found",
      message: undefined,
    })
  })
})

describe("convexErrorCode", () => {
  it("returns the code", () => {
    expect(convexErrorCode({ data: { code: "not_found" } })).toBe("not_found")
  })

  it("returns null when there is none", () => {
    expect(convexErrorCode(new Error("boom"))).toBeNull()
  })
})

describe("convexErrorMessage", () => {
  it("prefers the screen's own copy for a known code", () => {
    const error = { data: { code: "bootstrap_token_invalid", message: "brut" } }

    expect(convexErrorMessage(error, MESSAGES, FALLBACK)).toBe(
      "Jeton d'amorçage invalide."
    )
  })

  it("falls back to the server's message for a code this build does not know", () => {
    // A refusal added on the backend reads correctly here before anyone
    // updates the map — which is the point of carrying a message at all.
    const error = { data: { code: "brand_new_reason", message: "Raison inédite." } }

    expect(convexErrorMessage(error, MESSAGES, FALLBACK)).toBe("Raison inédite.")
  })

  it("uses the fallback only when nothing survived the redaction", () => {
    expect(convexErrorMessage(new Error("Server Error"), MESSAGES, FALLBACK)).toBe(
      FALLBACK
    )
  })

  it("uses the fallback for an unknown code with no message", () => {
    expect(
      convexErrorMessage({ data: { code: "mystery" } }, MESSAGES, FALLBACK)
    ).toBe(FALLBACK)
  })
})
