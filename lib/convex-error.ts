/**
 * Reading the reason out of a `ConvexError`.
 *
 * Convex redacts the message of a plainly thrown `Error` in production — the
 * client receives "Server Error" — so every refusal the UI has to tell apart is
 * thrown as `ConvexError({ code, message })`, whose `data` survives. This is
 * the reader for the other end.
 *
 * It accepts `data` as an object OR as a JSON string. The browser client hands
 * back an object; `convex-test` hands back the serialized form. A screen that
 * silently degrades to a generic message under one of the two is a defect that
 * only shows up on the side nobody exercised.
 *
 * It lives here rather than in `@be-yours/core` on purpose: the mirror
 * pins `beyours-boilerplate` to the last PUBLISHED core, so a client site would
 * fail to build on a core export that has not shipped yet.
 */

/** The shape every ConvexError in this app carries. */
export interface ConvexErrorPayload {
  code: string
  message?: string
}

/** Read `{ code, message }` off a thrown value, whichever form `data` took. */
export function convexErrorPayload(error: unknown): ConvexErrorPayload | null {
  const raw = (error as { data?: unknown } | null | undefined)?.data
  if (raw == null) return null

  let data: unknown = raw
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw)
    } catch {
      return null
    }
  }

  if (typeof data !== "object" || data === null) return null
  const code = (data as { code?: unknown }).code
  if (typeof code !== "string") return null

  const message = (data as { message?: unknown }).message
  return { code, message: typeof message === "string" ? message : undefined }
}

/** Just the code, for a caller that only needs to switch on it. */
export function convexErrorCode(error: unknown): string | null {
  return convexErrorPayload(error)?.code ?? null
}

/**
 * Turn a thrown value into something worth showing a restaurant owner.
 *
 * `messages` maps the codes this screen knows about. An unrecognised code still
 * falls back to the server's own message — deliberate, not an accident: a
 * refusal added later reads correctly here before anyone updates the map. Only
 * a value that is not a `ConvexError` reaches `fallback`, and by then it has
 * been redacted and there is genuinely nothing left to say.
 */
export function convexErrorMessage(
  error: unknown,
  messages: Record<string, string>,
  fallback: string
): string {
  const payload = convexErrorPayload(error)
  if (!payload) return fallback
  return messages[payload.code] ?? payload.message ?? fallback
}
