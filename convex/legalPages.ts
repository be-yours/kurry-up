import { query } from './_generated/server'
import * as defs from '@be-yours/convex-functions/legalPages'

/**
 * The data behind the storefront's mentions légales, CGV and politique de
 * confidentialité, and the list of statements the owner has not entered yet.
 * See `legalPages.ts` in the engine: nothing in the answer is invented, and
 * nothing beyond a named allow-list leaves the server.
 */
// @public-by-design: a legal notice is public by definition and must render
// before any sign-in. The answer is the establishment's published identity,
// its retention windows and the processors it uses — credentials, markups and
// the PayPal payee are never in it.
export const getPublic = query({
  args: defs.getPublic.args,
  handler: async (ctx) => defs.getPublic.handler(ctx),
})
