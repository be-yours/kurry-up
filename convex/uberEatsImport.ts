"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { generateSlug } from "@be-yours/convex-functions"
import { getPackageEnv, isSandbox } from "@be-yours/core/env";

type CategoryRecord = {
  _id: Id<"categories">
  storeId: string
  name: string
  slug: string
  sortOrder: number
  isActive: boolean
}

type MappingRecord = {
  _id: string
  externalId: string
  internalProductId: string
  platform: "uberEats" | "deliveroo"
}

/**
 * Import products from Uber Eats into the internal catalog.
 *
 * Flow:
 * 1. Auth check
 * 2. Get store integration (platformStoreId)
 * 3. Get credentials from process.env
 * 4. Call uberEats.pullMenu()
 * 5. Load existing categories + existing mappings for dedup
 * 6. For each PulledCategory: match by name or create
 * 7. For each PulledItem: skip if already mapped, else create product + mapping
 */
// @guarded-inline: checks products:write on the storeId it is given
export const importFromStore = action({
  args: { storeId: v.id("stores") },
  handler: async (ctx, args) => {
    // 1. Auth check
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { success: false, error: "Unauthorized", imported: 0, skipped: 0, categoriesCreated: 0 };
    }

    // Being logged in was the whole check: any customer account of any
    // restaurant reached this. The storeId is an argument, so it has to be
    // matched against what the caller may actually do there.
    await ctx.runQuery(internal.authHelpers.checkStorePermission, {
      storeId: args.storeId,
      permission: "products:write",
    });

    // 2. Get store integration
    const integration = await ctx.runQuery(
      api.storeIntegrations.getByStorePlatform,
      { storeId: args.storeId, platform: "uberEats" }
    ) as { platformStoreId: string; enabled: boolean } | null;

    if (!integration) {
      return { success: false, error: "No Uber Eats integration configured", imported: 0, skipped: 0, categoriesCreated: 0 };
    }

    if (!integration.enabled) {
      return { success: false, error: "Uber Eats integration is disabled", imported: 0, skipped: 0, categoriesCreated: 0 };
    }

    // 3. Get credentials
    const pkg = getPackageEnv();
    const clientId = pkg.UBER_EATS_CLIENT_ID;
    const clientSecret = pkg.UBER_EATS_CLIENT_SECRET;
    const sandboxMode = isSandbox("uberEats");

    if (!clientId || !clientSecret) {
      return { success: false, error: "Uber Eats API credentials not configured", imported: 0, skipped: 0, categoriesCreated: 0 };
    }

    const credentials = { clientId, clientSecret, sandboxMode };

    try {
      // 4. Pull menu from Uber Eats
      const { uberEats } = await import("@be-yours/integrations");
      const { categories: pulledCategories } = await uberEats.pullMenu(
        credentials,
        integration.platformStoreId
      );

      // 5. Load existing categories and mappings
      const existingCategories = await ctx.runQuery(api.categories.listAll, {
        storeId: args.storeId,
      }) as CategoryRecord[];

      const existingMappings = await ctx.runQuery(
        internal.externalProductMappings.internalListByStorePlatform,
        { storeId: args.storeId, platform: "uberEats" }
      ) as MappingRecord[];

      // 6. Build set of already-imported external IDs
      const importedExternalIds = new Set(
        existingMappings.map((m) => m.externalId)
      );

      // Build category name -> id map (case-insensitive)
      const categoryNameMap = new Map<string, Id<"categories">>();
      for (const cat of existingCategories) {
        categoryNameMap.set(cat.name.toLowerCase().trim(), cat._id);
      }

      let imported = 0;
      let skipped = 0;
      let categoriesCreated = 0;
      let productSortOrder = 0;

      // 7. Process each category
      for (let catIdx = 0; catIdx < pulledCategories.length; catIdx++) {
        const pulledCat = pulledCategories[catIdx]!;
        let categoryId: Id<"categories">;

        // Match existing category by name (case-insensitive)
        const existingCatId = categoryNameMap.get(
          pulledCat.name.toLowerCase().trim()
        );

        if (existingCatId) {
          categoryId = existingCatId;
        } else {
          // Create new category
          const catSlug = generateSlug(pulledCat.name);
          categoryId = await ctx.runMutation(api.categories.create, {
            storeId: args.storeId,
            name: pulledCat.name,
            slug: catSlug,
            sortOrder: existingCategories.length + catIdx,
            isActive: true,
          });
          categoryNameMap.set(pulledCat.name.toLowerCase().trim(), categoryId);
          categoriesCreated++;
        }

        // 8. Process each item
        for (const pulledItem of pulledCat.items) {
          // Skip if already imported (dedup by externalId)
          if (importedExternalIds.has(pulledItem.externalId)) {
            skipped++;
            continue;
          }

          // Generate unique slug
          const baseSlug = generateSlug(pulledItem.name);
          const slug = `${baseSlug}-${pulledItem.externalId.substring(0, 8)}`;

          // Convert modifier groups to options
          const options = pulledItem.modifierGroups.map((mg) => ({
            id: mg.externalId,
            name: mg.name,
            required: false,
            choices: mg.modifiers.map((mod) => ({
              id: mod.externalId,
              name: mod.name,
              priceModifier: mod.price,
              externalIds: { uberEatsId: mod.externalId },
            })),
            externalIds: { uberEatsId: mg.externalId },
          }));

          // Create product (price stays in cents, same as DB format)
          const productId = await ctx.runMutation(api.products.create, {
            storeId: args.storeId,
            categoryId,
            name: pulledItem.name,
            slug,
            description: pulledItem.description,
            price: pulledItem.price,
            taxRate: 0,
            images: pulledItem.imageUrl ? [pulledItem.imageUrl] : [],
            options,
            isActive: true,
            isFeatured: false,
            sortOrder: productSortOrder++,
            source: "uber_eats",
            externalIds: { uberEatsId: pulledItem.externalId },
          });

          // Create external mapping
          await ctx.runMutation(internal.externalProductMappings.internalUpsert, {
            storeId: args.storeId,
            platform: "uberEats",
            internalProductId: productId,
            externalId: pulledItem.externalId,
            externalName: pulledItem.name,
            externalPrice: pulledItem.price,
          });

          importedExternalIds.add(pulledItem.externalId);
          imported++;
        }
      }

      console.log(
        `Uber Eats import for store ${args.storeId}: ${imported} imported, ${skipped} skipped, ${categoriesCreated} categories created`
      );

      return { success: true, imported, skipped, categoriesCreated };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Uber Eats import failed for store ${args.storeId}:`, errorMessage);
      return { success: false, error: errorMessage, imported: 0, skipped: 0, categoriesCreated: 0 };
    }
  },
});
