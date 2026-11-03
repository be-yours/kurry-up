/**
 * App-local instantiation of the engine's authorisation seam.
 *
 * The policy itself lives in `@be-yours/convex-functions/storeFunctions`
 * so that every app — including `apps/themes`, the template cloned for each
 * client — applies the same rules. All this file does is bind it to this app's
 * generated `query` / `mutation` builders and re-export the result, so existing
 * imports of `./lib/storeFunctions` keep working unchanged.
 */

import { mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { createStoreFunctions } from "@be-yours/convex-functions/storeFunctions";

export const {
  storeQuery,
  storeMutation,
  authedQuery,
  authedMutation,
  storeIdFromDocument,
  storeIdFromField,
} = createStoreFunctions<QueryCtx, MutationCtx>({ query, mutation });
