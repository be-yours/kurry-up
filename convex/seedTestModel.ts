// The CMS registry has to be set before any block is saved: the draft and publish
// helpers below validate values against it. Same initialisation as `cmsSeedData.ts`.
import { setCmsRegistry } from '@be-yours/cms'
import { appCmsConfig } from '../cms'
setCmsRegistry(appCmsConfig)

import { internalMutation, type MutationCtx } from './_generated/server'
import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import { allocateOrderNumber } from '@be-yours/convex-functions/numbering'
import { computeOrderTotals } from '@be-yours/convex-functions/orderTotals'
import { saveDraftBlockCore } from '@be-yours/convex-functions/cms'
import { publishPageCore } from '@be-yours/convex-functions/cmsPublish'
import { TEST_MODEL_ACCOUNTS, TEST_MODEL_STORE_SLUGS } from './lib/testModelRoster'

/**
 * The shared test model: three restaurants, a team, diners, a populated kitchen,
 * promotions and a game. Run by `scripts/test-model.mts` (`pnpm test-model`).
 *
 * Internal, so no browser can reach it, AND refused unless the deployment says
 * it is a test one. `TEST_MODEL_ENABLED=true` is set by hand, once, on the
 * deployment that is meant to be wiped and shared (`npx convex env set`). A
 * client deployment never sets it, so the seed that ships to every client clone
 * does nothing there and says why.
 *
 * Idempotent throughout: a second run finds what the first wrote (by slug, by
 * coupon code, by idempotency key) and adds nothing.
 *
 * WHAT IS DELIBERATELY NOT HERE. No Stripe, PayPal or SES secret: those are
 * `npx convex env set` values the team keeps in its vault. This file only
 * chooses WHICH providers the restaurants offer, through `globalSettings`.
 */

type StoreSlug = (typeof TEST_MODEL_STORE_SLUGS)[number]

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day,
  open: '00:00',
  close: '23:59',
  isClosed: false,
}))

/** Realistic week with a closed Monday: exercises « fermé aujourd'hui ». */
const REAL_HOURS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day,
  open: '11:30',
  close: '22:30',
  isClosed: day === 1,
}))

interface SeedProduct {
  slug: string
  name: string
  category: string
  price: number
  description: string
  featured?: boolean
  /** Stock tracked at this quantity; 0 makes the product un-orderable. */
  stock?: number
  withSizeOption?: boolean
}

interface SeedStore {
  slug: StoreSlug
  name: string
  description: string
  address: {
    street: string
    city: string
    postalCode: string
    country: string
    latitude: number
    longitude: number
  }
  phone: string
  hours: typeof ALL_DAY
  categories: { slug: string; name: string }[]
  products: SeedProduct[]
}

const STORES: SeedStore[] = [
  {
    slug: 'bella-napoli-test',
    name: 'Bella Napoli (test)',
    description: 'Pizzeria napolitaine. Ouverte 24h/24 dans le modèle de test.',
    address: {
      street: '12 rue de la Paix',
      city: 'Paris',
      postalCode: '75002',
      country: 'FR',
      latitude: 48.8698,
      longitude: 2.3312,
    },
    phone: '01 42 00 00 01',
    hours: ALL_DAY,
    categories: [
      { slug: 'pizzas', name: 'Pizzas' },
      { slug: 'entrees', name: 'Entrées' },
      { slug: 'desserts', name: 'Desserts' },
    ],
    products: [
      {
        slug: 'margherita',
        name: 'Pizza Margherita',
        category: 'pizzas',
        price: 1100,
        description: 'Tomate, mozzarella, basilic.',
        featured: true,
        withSizeOption: true,
      },
      {
        slug: 'reine',
        name: 'Pizza Reine',
        category: 'pizzas',
        price: 1350,
        description: 'Jambon, champignons, mozzarella.',
        withSizeOption: true,
      },
      {
        slug: 'diavola',
        name: 'Pizza Diavola',
        category: 'pizzas',
        price: 1400,
        description: 'Salami piquant, mozzarella.',
      },
      {
        slug: 'burrata',
        name: 'Burrata et tomates',
        category: 'entrees',
        price: 950,
        description: 'Burrata des Pouilles.',
        stock: 12,
      },
      {
        slug: 'tiramisu',
        name: 'Tiramisu maison',
        category: 'desserts',
        price: 650,
        description: 'Recette de la nonna.',
      },
      {
        slug: 'panna-cotta',
        name: 'Panna cotta (épuisée)',
        category: 'desserts',
        price: 600,
        description: 'Stock à zéro : doit être refusée à la commande.',
        stock: 0,
      },
    ],
  },
  {
    slug: 'burger-lab-test',
    name: 'Burger Lab (test)',
    description: 'Burgers et frites. Ouvert 24h/24 dans le modèle de test.',
    address: {
      street: '5 place Bellecour',
      city: 'Lyon',
      postalCode: '69002',
      country: 'FR',
      latitude: 45.7578,
      longitude: 4.832,
    },
    phone: '04 72 00 00 02',
    hours: ALL_DAY,
    categories: [
      { slug: 'burgers', name: 'Burgers' },
      { slug: 'accompagnements', name: 'Accompagnements' },
      { slug: 'boissons', name: 'Boissons' },
    ],
    products: [
      {
        slug: 'classic',
        name: 'Classic Burger',
        category: 'burgers',
        price: 1250,
        description: 'Boeuf, cheddar, salade, tomate.',
        featured: true,
      },
      {
        slug: 'double-cheese',
        name: 'Double Cheese',
        category: 'burgers',
        price: 1550,
        description: 'Deux steaks, double cheddar.',
      },
      {
        slug: 'veggie',
        name: 'Veggie Burger',
        category: 'burgers',
        price: 1300,
        description: 'Galette de légumes.',
      },
      {
        slug: 'frites',
        name: 'Frites maison',
        category: 'accompagnements',
        price: 350,
        description: 'Coupées à la main.',
        withSizeOption: true,
      },
      {
        slug: 'cola',
        name: 'Cola 33cl',
        category: 'boissons',
        price: 300,
        description: 'Bouteille verre.',
        stock: 40,
      },
      {
        slug: 'milkshake',
        name: 'Milkshake vanille',
        category: 'boissons',
        price: 550,
        description: 'Glace artisanale.',
      },
    ],
  },
  {
    slug: 'sakura-sushi-test',
    name: 'Sakura Sushi (test)',
    description: 'Sushi et poke bowls. Horaires réels, fermé le lundi.',
    address: {
      street: '21 rue Sainte-Catherine',
      city: 'Bordeaux',
      postalCode: '33000',
      country: 'FR',
      latitude: 44.8378,
      longitude: -0.5792,
    },
    phone: '05 56 00 00 03',
    hours: REAL_HOURS,
    categories: [
      { slug: 'sushis', name: 'Sushis' },
      { slug: 'bowls', name: 'Poke bowls' },
      { slug: 'desserts', name: 'Desserts' },
    ],
    products: [
      {
        slug: 'plateau-12',
        name: 'Plateau 12 pièces',
        category: 'sushis',
        price: 1690,
        description: 'Assortiment du chef.',
        featured: true,
      },
      {
        slug: 'maki-saumon',
        name: 'Maki saumon (8)',
        category: 'sushis',
        price: 790,
        description: 'Saumon frais.',
      },
      {
        slug: 'poke-saumon',
        name: 'Poke bowl saumon',
        category: 'bowls',
        price: 1450,
        description: 'Riz vinaigré, edamame, avocat.',
      },
      {
        slug: 'poke-poulet',
        name: 'Poke bowl poulet',
        category: 'bowls',
        price: 1350,
        description: 'Poulet teriyaki.',
      },
      {
        slug: 'mochi',
        name: 'Mochi mangue (3)',
        category: 'desserts',
        price: 550,
        description: 'Pâte de riz glutineux.',
        stock: 20,
      },
      {
        slug: 'gyoza',
        name: 'Gyoza (6)',
        category: 'sushis',
        price: 650,
        description: 'Raviolis grillés.',
      },
    ],
  },
]

/** Orders seeded per restaurant: one per status, so every screen has a row. */
const ORDER_PLAN = [
  {
    key: 'pending',
    status: 'pending',
    payment: 'pending',
    method: 'card',
    type: 'pickup',
    minutesAgo: 4,
    lines: [0, 3],
    ticket: false,
  },
  {
    key: 'confirmed',
    status: 'confirmed',
    payment: 'paid',
    method: 'card',
    type: 'pickup',
    minutesAgo: 12,
    lines: [1],
    ticket: 'pending',
  },
  {
    key: 'preparing',
    status: 'preparing',
    payment: 'paid',
    method: 'card',
    type: 'dine_in',
    minutesAgo: 25,
    lines: [0, 4],
    ticket: 'in_progress',
    table: 'A3',
  },
  {
    key: 'ready',
    status: 'ready',
    payment: 'paid',
    method: 'cash',
    type: 'pickup',
    minutesAgo: 40,
    lines: [2],
    ticket: 'ready',
  },
  {
    key: 'out-for-delivery',
    status: 'out_for_delivery',
    payment: 'paid',
    method: 'card',
    type: 'delivery',
    minutesAgo: 55,
    lines: [0, 1],
    ticket: 'completed',
  },
  {
    key: 'delivered',
    status: 'delivered',
    payment: 'paid',
    method: 'card',
    type: 'delivery',
    minutesAgo: 600,
    lines: [1, 3],
    ticket: 'completed',
  },
  {
    key: 'completed',
    status: 'completed',
    payment: 'paid',
    method: 'cash',
    type: 'dine_in',
    minutesAgo: 1500,
    lines: [0, 4],
    ticket: 'completed',
    table: 'B1',
  },
  {
    key: 'cancelled',
    status: 'cancelled',
    payment: 'refunded',
    method: 'card',
    type: 'pickup',
    minutesAgo: 2000,
    lines: [2],
    ticket: false,
  },
] as const

/** Customers named on seeded orders. The first two have accounts. */
const DINERS = [
  { name: 'Jean Durand', email: 'client1@beyours.test', phone: '06 12 34 56 78' },
  { name: 'Camille Moreau', email: 'client2@beyours.test', phone: '06 98 76 54 32' },
  { name: 'Amélie Rousseau', email: 'amelie.rousseau@beyours.test', phone: '06 11 22 33 44' },
]

/**
 * Pictures live in `public/test-model/<prefix>-<name>.webp` and are served by the
 * site itself. The S3 bucket of this deployment is a placeholder, so nothing can be
 * uploaded to it; a path under `public/` needs no storage and no `remotePatterns`.
 */
const IMAGE_PREFIX: Record<StoreSlug, string> = {
  'bella-napoli-test': 'bella',
  'burger-lab-test': 'burger',
  'sakura-sushi-test': 'sakura',
}

const imagePath = (store: StoreSlug, name: string): string =>
  `/test-model/${IMAGE_PREFIX[store]}-${name}.webp`

/** The first products of a restaurant fill « Nos plats du moment » on its homepage. */
const TRENDING_COUNT = 4

const HOMEPAGE_COPY: Record<
  StoreSlug,
  { title: string; subtitle: string; heroAlt: string; seoTitle: string }
> = {
  'bella-napoli-test': {
    title: 'Bienvenue chez {Bella Napoli}',
    subtitle: 'Pizzas, entrées et desserts, à emporter, sur place ou en livraison.',
    heroAlt: 'Table de pizzeria avec une pizza margherita, une burrata et un verre de vin rouge',
    seoTitle: 'Bella Napoli (test) — Commandez en ligne',
  },
  'burger-lab-test': {
    title: 'Bienvenue chez {Burger Lab}',
    subtitle: 'Burgers, frites et boissons fraîches, à emporter, sur place ou en livraison.',
    heroAlt: 'Burgers, frites et milkshake sur une table en bois',
    seoTitle: 'Burger Lab (test) — Commandez en ligne',
  },
  'sakura-sushi-test': {
    title: 'Bienvenue chez {Sakura Sushi}',
    subtitle: 'Sushis, poke bowls et desserts japonais, à emporter ou en livraison.',
    heroAlt: 'Plateau de sushis, poke bowl saumon et gyoza sur une table sombre',
    seoTitle: 'Sakura Sushi (test) — Commandez en ligne',
  },
}

const cmsText = (textValue: string) => ({ type: 'text' as const, textValue })
const cmsImage = (mediaId: string, altText: string) => ({
  type: 'image' as const,
  mediaId,
  altText,
})

/**
 * Fills and publishes the `homepage` CMS page of one restaurant, once.
 *
 * Without it the storefront draws the sample copy of the template and no photograph.
 * Guarded by the hero's media record: a second run finds it and writes nothing.
 * Returns whether it wrote the page.
 */
async function seedHomepage(
  ctx: MutationCtx,
  storeId: Id<'stores'>,
  slug: StoreSlug,
  now: number,
): Promise<boolean> {
  const filename = `test-model-${IMAGE_PREFIX[slug]}-hero.webp`
  const already = await ctx.db
    .query('cmsMedia')
    .filter((q) => q.and(q.eq(q.field('storeId'), storeId), q.eq(q.field('filename'), filename)))
    .first()
  if (already) return false

  const copy = HOMEPAGE_COPY[slug]
  const url = imagePath(slug, 'hero')
  const mediaId = await ctx.db.insert('cmsMedia', {
    storeId,
    kind: 'image' as const,
    status: 'ready' as const,
    filename,
    mimeType: 'image/webp',
    size: 60_000,
    sourceUrl: url,
    url,
    width: 960,
    height: 720,
    folder: 'cms',
    usageCount: 2,
    uploadedBy: 'system-seed',
    uploadedAt: now,
  })

  // No badge, rating stamp or delivery time: a figure about an establishment is the
  // establishment's to state, and `no-fabricated-social-proof.test.ts` holds that.
  const blocks: Record<string, Record<string, unknown>> = {
    seo: {
      metaTitle: cmsText(copy.seoTitle),
      metaDescription: cmsText('Découvrez la carte et commandez en ligne.'),
      robots: { type: 'select' as const, textValue: 'index, follow' },
    },
    hero: {
      title: cmsText(copy.title),
      subtitle: cmsText(copy.subtitle),
      image: cmsImage(mediaId, copy.heroAlt),
      ctaLabel: cmsText('Voir le menu'),
    },
    trendingMeals: {
      sectionTitle: cmsText('Nos plats du moment'),
      viewAllLabel: cmsText('Tout voir'),
    },
    categories: {
      badge: cmsText('Découvrez le menu'),
      sectionTitle: cmsText('Nos catégories'),
      description: cmsText('Parcourez la carte par catégorie.'),
    },
    cta: {
      title: cmsText('Prêt à {commander} ?'),
      subtitle: cmsText('Découvrez la carte complète et commandez en quelques clics.'),
      buttonText: cmsText('Explorer le menu'),
      backgroundImage: cmsImage(mediaId, copy.heroAlt),
    },
  }

  for (const [blockKey, values] of Object.entries(blocks)) {
    await saveDraftBlockCore(ctx, {
      storeId,
      pageSlug: 'homepage',
      blockKey,
      values,
      updatedBy: 'system-seed',
    })
  }
  await publishPageCore(ctx, { storeId, pageSlug: 'homepage', updatedBy: 'system-seed' })
  return true
}

function trackingToken(storeIndex: number, orderIndex: number): string {
  return `TM${storeIndex}${orderIndex}`.padEnd(21, 'x')
}

export const internalSeedTestModel = internalMutation({
  args: {
    /** Better Auth user id by e-mail, for the accounts the script just created. */
    userIds: v.record(v.string(), v.string()),
  },
  handler: async (ctx, args) => {
    if (process.env.TEST_MODEL_ENABLED !== 'true') {
      throw new Error(
        'seedTestModel refused: this deployment is not marked as a test one. ' +
          'On a deployment that may be wiped and shared, run ' +
          '`npx convex env set TEST_MODEL_ENABLED true` first. Never on a client deployment.',
      )
    }

    const now = Date.now()
    const summary = {
      storesCreated: 0,
      homepagesSeeded: 0,
      productsCreated: 0,
      profilesWritten: 0,
      ordersCreated: 0,
      ticketsCreated: 0,
      promotionsCreated: 0,
      gamesCreated: 0,
      teamMembersCreated: 0,
      accountsMissing: [] as string[],
    }

    // --- Global settings: every payment method on, a delivery fee ----------
    const settings = await ctx.db.query('globalSettings').first()
    const globalSettingsValue = {
      currency: 'EUR',
      timezone: 'Europe/Paris',
      taxRate: 10,
      services: { dineIn: true, takeaway: true, delivery: true, clickAndCollect: true },
      minimumOrderAmount: 800,
      hours: ALL_DAY,
      delivery: { feeMode: 'fixed' as const, fee: 350, freeAbove: 4000, radius: 15 },
      payments: { cardProvider: 'stripe' as const, paypal: true, cash: true },
      integrations: {},
      updatedAt: now,
    }
    if (settings) {
      await ctx.db.patch(settings._id, globalSettingsValue)
    } else {
      await ctx.db.insert('globalSettings', globalSettingsValue)
    }

    // --- Restaurants, catalogue --------------------------------------------
    const storeIds = new Map<StoreSlug, Id<'stores'>>()
    const productsByStore = new Map<StoreSlug, Id<'products'>[]>()

    for (const def of STORES) {
      const found = await ctx.db
        .query('stores')
        .filter((q) => q.eq(q.field('slug'), def.slug))
        .first()

      const storeId: Id<'stores'> =
        found?._id ??
        (await ctx.db.insert('stores', {
          name: def.name,
          slug: def.slug,
          description: def.description,
          address: def.address,
          phone: def.phone,
          hours: def.hours,
          status: 'open' as const,
          createdAt: now,
          updatedAt: now,
        }))
      if (!found) summary.storesCreated += 1
      storeIds.set(def.slug, storeId)

      const categoryIds = new Map<string, Id<'categories'>>()
      for (const [index, category] of def.categories.entries()) {
        const existing = await ctx.db
          .query('categories')
          .filter((q) =>
            q.and(q.eq(q.field('storeId'), storeId), q.eq(q.field('slug'), category.slug)),
          )
          .first()
        // A category wears the picture of its first dish.
        const firstDish = def.products.find((product) => product.category === category.slug)
        const imageUrl = firstDish ? imagePath(def.slug, firstDish.slug) : undefined
        if (existing && !existing.imageUrl && imageUrl) {
          await ctx.db.patch(existing._id, { imageUrl, updatedAt: now })
        }
        categoryIds.set(
          category.slug,
          existing?._id ??
            (await ctx.db.insert('categories', {
              storeId,
              name: category.name,
              slug: category.slug,
              imageUrl,
              sortOrder: index,
              isActive: true,
              createdAt: now,
              updatedAt: now,
            })),
        )
      }

      const productIds: Id<'products'>[] = []
      for (const [index, product] of def.products.entries()) {
        const existing = await ctx.db
          .query('products')
          .withIndex('by_storeId_slug', (q) => q.eq('storeId', storeId).eq('slug', product.slug))
          .first()
        const trendingRank = index < TRENDING_COUNT ? index + 1 : undefined
        if (existing) {
          // A deployment seeded before pictures existed gets them on the next run.
          const missing: { images?: string[]; homepageTrendingRank?: number } = {}
          if (!existing.images?.length) missing.images = [imagePath(def.slug, product.slug)]
          if (existing.homepageTrendingRank == null && trendingRank !== undefined) {
            missing.homepageTrendingRank = trendingRank
          }
          if (Object.keys(missing).length > 0) {
            await ctx.db.patch(existing._id, { ...missing, updatedAt: now })
          }
          productIds.push(existing._id)
          continue
        }
        const id = await ctx.db.insert('products', {
          storeId,
          categoryId: categoryIds.get(product.category)!,
          name: product.name,
          slug: product.slug,
          description: product.description,
          price: product.price,
          taxRate: 10,
          images: [imagePath(def.slug, product.slug)],
          homepageTrendingRank: trendingRank,
          options: product.withSizeOption
            ? [
                {
                  id: 'size',
                  name: 'Taille',
                  required: true,
                  maxSelections: 1,
                  choices: [
                    { id: 'regular', name: 'Normale', priceModifier: 0 },
                    { id: 'large', name: 'Grande', priceModifier: 300 },
                  ],
                },
              ]
            : [],
          allergens: [],
          tags: [],
          stock:
            product.stock === undefined
              ? undefined
              : {
                  tracked: true,
                  quantity: product.stock,
                  lowStockThreshold: 3,
                  autoDisableWhenEmpty: product.stock === 0,
                },
          isActive: true,
          isFeatured: product.featured ?? false,
          sortOrder: index,
          source: 'manual',
          createdAt: now,
          updatedAt: now,
        })
        productIds.push(id)
        summary.productsCreated += 1
      }
      productsByStore.set(def.slug, productIds)

      if (await seedHomepage(ctx, storeId, def.slug, now)) summary.homepagesSeeded += 1
    }

    // --- Accounts: profile + restaurants + entitlements --------------------
    for (const account of TEST_MODEL_ACCOUNTS) {
      const userId = args.userIds[account.email]
      if (!userId) {
        summary.accountsMissing.push(account.email)
        continue
      }

      const accountStoreIds = account.storeSlugs.map((slug) => storeIds.get(slug)!)
      const profile = await ctx.db
        .query('userProfiles')
        .withIndex('by_userId', (q) => q.eq('userId', userId))
        .first()

      if (profile) {
        await ctx.db.patch(profile._id, {
          role: account.role,
          storeIds: accountStoreIds,
          updatedAt: now,
        })
      } else {
        await ctx.db.insert('userProfiles', {
          userId,
          role: account.role,
          storeIds: accountStoreIds,
          permissions: [],
          language: 'fr',
          createdAt: now,
          updatedAt: now,
        })
      }
      summary.profilesWritten += 1

      if (account.plan) {
        const preset = {
          starter: {
            monthlyQuota: 2,
            maxTopics: 3,
            monthlyImageQuota: 5,
            allowMultiLanguage: false,
            allowAutoPublish: false,
          },
          pro: {
            monthlyQuota: 8,
            maxTopics: undefined,
            monthlyImageQuota: 20,
            allowMultiLanguage: false,
            allowAutoPublish: true,
          },
          enterprise: {
            monthlyQuota: 30,
            maxTopics: undefined,
            monthlyImageQuota: 100,
            allowMultiLanguage: true,
            allowAutoPublish: true,
          },
        }[account.plan]
        const autoBlog = { enabled: true, plan: account.plan, ...preset }
        const entitlement = await ctx.db
          .query('ownerEntitlements')
          .withIndex('by_ownerId', (q) => q.eq('ownerId', userId))
          .first()
        if (entitlement) {
          await ctx.db.patch(entitlement._id, { autoBlog, updatedAt: now })
        } else {
          await ctx.db.insert('ownerEntitlements', {
            ownerId: userId,
            autoBlog,
            imageToProduct: { enabled: true, monthlyAnalysisQuota: 50 },
            createdAt: now,
            updatedAt: now,
          })
        }
      }

      // The Équipe screen of each restaurant lists its staff.
      if (['manager', 'kitchen', 'waiter', 'delivery'].includes(account.role)) {
        for (const slug of account.storeSlugs) {
          const storeId = storeIds.get(slug)!
          const member = await ctx.db
            .query('teamMembers')
            .withIndex('by_email', (q) => q.eq('email', account.email))
            .filter((q) => q.eq(q.field('storeId'), storeId))
            .first()
          if (member) continue
          await ctx.db.insert('teamMembers', {
            storeId,
            allStores: false,
            userId,
            name: account.name,
            email: account.email,
            role: account.role as 'manager' | 'kitchen' | 'waiter' | 'delivery',
            permissions: [],
            invitationStatus: 'accepted' as const,
            invitedAt: now,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          })
          summary.teamMembersCreated += 1
        }
      }
    }

    // --- Promotions per restaurant ------------------------------------------
    const DAY = 86_400_000
    for (const def of STORES) {
      const storeId = storeIds.get(def.slug)!
      const promos = [
        {
          code: 'BIENVENUE10',
          name: 'Bienvenue -10%',
          discountType: 'percentage' as const,
          discountValue: 10,
          minimumOrderAmount: 1000,
          start: now - DAY,
          end: now + 365 * DAY,
        },
        {
          code: 'MOINS5',
          name: '5 € offerts dès 25 €',
          discountType: 'fixed_amount' as const,
          discountValue: 500,
          minimumOrderAmount: 2500,
          start: now - DAY,
          end: now + 365 * DAY,
        },
        {
          code: 'LIVRAISON',
          name: 'Livraison offerte',
          discountType: 'free_delivery' as const,
          discountValue: undefined,
          minimumOrderAmount: undefined,
          start: now - DAY,
          end: now + 365 * DAY,
        },
        {
          code: 'EXPIRE',
          name: 'Code expiré (doit être refusé)',
          discountType: 'percentage' as const,
          discountValue: 50,
          minimumOrderAmount: undefined,
          start: now - 60 * DAY,
          end: now - 30 * DAY,
        },
      ]
      for (const promo of promos) {
        const existing = await ctx.db
          .query('promotions')
          .withIndex('by_storeId_couponCode', (q) =>
            q.eq('storeId', storeId).eq('couponCode', promo.code),
          )
          .first()
        if (existing) continue
        await ctx.db.insert('promotions', {
          storeId,
          name: promo.name,
          triggerMode: 'coupon' as const,
          couponCode: promo.code,
          discountType: promo.discountType,
          discountValue: promo.discountValue,
          scope: 'order' as const,
          minimumOrderAmount: promo.minimumOrderAmount,
          startDate: promo.start,
          endDate: promo.end,
          usageCount: 0,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        summary.promotionsCreated += 1
      }
    }

    // --- Game: wheel, prizes, actions, QR codes (first two restaurants) -----
    for (const def of STORES.slice(0, 2)) {
      const storeId = storeIds.get(def.slug)!
      const existingGame = await ctx.db
        .query('games')
        .withIndex('by_storeId', (q) => q.eq('storeId', storeId))
        .first()
      if (existingGame) continue

      const prizeDefs = [
        { name: 'Café offert', type: 'custom' as const, value: undefined },
        { name: '-10% sur la prochaine commande', type: 'discount_percentage' as const, value: 10 },
        { name: '2 € de réduction', type: 'discount_fixed' as const, value: 200 },
      ]
      const prizeIds: Id<'prizes'>[] = []
      for (const prize of prizeDefs) {
        prizeIds.push(
          await ctx.db.insert('prizes', {
            storeId,
            name: prize.name,
            type: prize.type,
            value: prize.value,
            validityDays: 30,
            totalAvailable: 100,
            remainingCount: 100,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          }),
        )
      }

      await ctx.db.insert('games', {
        storeId,
        type: 'wheel' as const,
        name: `Roue de la chance ${def.name}`,
        winRatio: 40,
        isActive: true,
        config: {
          cooldownHours: 24,
          actionMode: 'sequential' as const,
          wheelSections: [
            { label: 'Café offert', color: '#F97316', prizeId: prizeIds[0], isWinning: true },
            { label: 'Perdu', color: '#64748B', isWinning: false },
            { label: '-10%', color: '#0D9488', prizeId: prizeIds[1], isWinning: true },
            { label: 'Perdu', color: '#94A3B8', isWinning: false },
            { label: '2 €', color: '#7C3AED', prizeId: prizeIds[2], isWinning: true },
            { label: 'Perdu', color: '#64748B', isWinning: false },
          ],
        },
        createdAt: now,
        updatedAt: now,
      })
      summary.gamesCreated += 1

      const actions = [
        {
          type: 'google_review' as const,
          name: 'Laisser un avis Google',
          url: 'https://g.page/r/example-test/review',
        },
        {
          type: 'instagram_follow' as const,
          name: 'Suivre sur Instagram',
          url: 'https://instagram.com/example_test',
        },
        { type: 'email_subscribe' as const, name: "S'abonner à la newsletter", url: undefined },
      ]
      for (const [index, action] of actions.entries()) {
        await ctx.db.insert('requiredActions', {
          storeId,
          type: action.type,
          name: action.name,
          url: action.url,
          isRequired: true,
          sortOrder: index,
          timerSeconds: 5,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
      }

      for (const table of ['1', '2', '3']) {
        await ctx.db.insert('gameQRCodes', {
          storeId,
          code: `TM-${def.slug.slice(0, 5).toUpperCase()}-T${table}`,
          tableNumber: table,
          location: 'Salle',
          gameType: 'wheel' as const,
          isActive: true,
          scannedCount: 0,
          createdAt: now,
          updatedAt: now,
        })
      }
    }

    // --- Orders and kitchen tickets -----------------------------------------
    for (const [storeIndex, def] of STORES.entries()) {
      const storeId = storeIds.get(def.slug)!
      const productIds = productsByStore.get(def.slug)!
      const products = await Promise.all(productIds.map((id) => ctx.db.get(id)))

      // Oldest first, so order numbers run in the direction of the dates.
      const plan = [...ORDER_PLAN].sort((a, b) => b.minutesAgo - a.minutesAgo)

      for (const [orderIndex, order] of plan.entries()) {
        const idempotencyKey = `test-model-${def.slug}-${order.key}`
        const already = await ctx.db
          .query('orders')
          .withIndex('by_storeId_idempotencyKey', (q) =>
            q.eq('storeId', storeId).eq('idempotencyKey', idempotencyKey),
          )
          .first()
        if (already) continue

        const items = order.lines.map((lineIndex) => {
          const product = products[lineIndex]
          if (!product) {
            throw new Error(`seedTestModel: ${def.slug} has no product at index ${lineIndex}`)
          }
          return {
            productId: product._id,
            productName: product.name,
            quantity: 1 + (lineIndex % 2),
            unitPrice: product.price,
            selectedOptions: [],
            subtotal: product.price * (1 + (lineIndex % 2)),
            taxRatePercent: product.taxRate,
          }
        })
        const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0)
        const deliveryFee = order.type === 'delivery' ? 350 : undefined
        const { taxAmount, taxBreakdown, total } = computeOrderTotals({
          subtotal,
          taxRatePercent: items[0]!.taxRatePercent,
          lines: items.map((item) => ({
            subtotal: item.subtotal,
            taxRatePercent: item.taxRatePercent,
          })),
          deliveryFee,
        })

        const diner = DINERS[(storeIndex + orderIndex) % DINERS.length]!
        const placedAt = now - order.minutesAgo * 60_000
        const orderNumber = await allocateOrderNumber(ctx, storeId, { now: placedAt })
        const tableNumber = 'table' in order ? order.table : undefined

        const orderId = await ctx.db.insert('orders', {
          storeId,
          orderNumber,
          customerInfo: { name: diner.name, email: diner.email, phone: diner.phone },
          customerEmailKey: diner.email.trim().toLowerCase(),
          type: order.type,
          tableNumber,
          status: order.status,
          items,
          subtotal,
          taxAmount,
          taxBreakdown,
          deliveryFee,
          total,
          deliveryAddress:
            order.type === 'delivery'
              ? {
                  street: '8 rue Oberkampf',
                  city: def.address.city,
                  postalCode: def.address.postalCode,
                  country: 'FR',
                  instructions: 'Code 4512, deuxième étage.',
                }
              : undefined,
          paymentMethod: order.method,
          paymentStatus: order.payment,
          source: 'website' as const,
          idempotencyKey,
          createdAt: placedAt,
          updatedAt: placedAt,
        })
        summary.ordersCreated += 1

        if (order.ticket) {
          const startedAt = order.ticket === 'pending' ? undefined : placedAt + 60_000
          const readyAt =
            order.ticket === 'ready' || order.ticket === 'completed'
              ? placedAt + 15 * 60_000
              : undefined
          await ctx.db.insert('kitchenTickets', {
            storeId,
            orderId,
            orderNumber,
            orderType: order.type,
            items: items.map((item) => ({
              productName: item.productName,
              quantity: item.quantity,
              options: [],
            })),
            station: undefined,
            priority: 'normal' as const,
            source: 'website' as const,
            estimatedPrepTime: 15,
            trackingToken: trackingToken(storeIndex, orderIndex),
            estimatedReadyAt: placedAt + 15 * 60_000,
            customerName: order.type === 'delivery' ? diner.name : undefined,
            customerPhone: order.type === 'delivery' ? diner.phone : undefined,
            tableNumber,
            status: order.ticket,
            printStatus: 'not_required' as const,
            printAttempts: 0,
            startedAt,
            readyAt,
            completedAt: order.ticket === 'completed' ? (readyAt ?? placedAt) + 120_000 : undefined,
            createdAt: placedAt,
            updatedAt: now,
          })
          summary.ticketsCreated += 1
        }
      }
    }

    return summary
  },
})
