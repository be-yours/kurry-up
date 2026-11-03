/**
 * The people of the shared test model.
 *
 * Plain data, no Convex import, so that `scripts/test-model.mts` (which creates
 * the sign-in accounts through Better Auth) and `seedTestModel.ts` (which gives
 * each account a profile and its restaurants) read ONE list. Two copies would
 * drift, and the symptom is an account that signs in and sees no restaurant.
 *
 * Addresses are on `.test`, reserved by RFC 2606 and undeliverable: nothing in
 * the test model can put a mail in a real inbox. To test an e-mail flow, place
 * the order with your own address instead.
 */

export type TestModelRole =
  | 'super_admin'
  | 'client_admin'
  | 'manager'
  | 'kitchen'
  | 'waiter'
  | 'delivery'
  | 'customer'

/** Slugs of the three test restaurants, in the order the seed creates them. */
export const TEST_MODEL_STORE_SLUGS = [
  'bella-napoli-test',
  'burger-lab-test',
  'sakura-sushi-test',
] as const

export type TestModelStoreSlug = (typeof TEST_MODEL_STORE_SLUGS)[number]

export interface TestModelAccount {
  email: string
  name: string
  role: TestModelRole
  /** Restaurants this profile may administer. Customers hold none. */
  storeSlugs: readonly TestModelStoreSlug[]
  /** One line for the credentials sheet: what this account is for. */
  purpose: string
  /** Auto Blog / image-to-product plan for owners. */
  plan?: 'starter' | 'pro' | 'enterprise'
}

export const TEST_MODEL_ACCOUNTS: readonly TestModelAccount[] = [
  {
    email: 'superadmin@beyours.test',
    name: 'Super Admin',
    role: 'super_admin',
    storeSlugs: TEST_MODEL_STORE_SLUGS,
    purpose: 'Everything, including the screens no client role can open',
  },
  {
    email: 'owner@beyours.test',
    name: 'Amadou Diallo',
    role: 'client_admin',
    storeSlugs: TEST_MODEL_STORE_SLUGS,
    purpose: 'Owner of the 3 restaurants (multi-store), Auto Blog pro',
    plan: 'pro',
  },
  {
    email: 'owner2@beyours.test',
    name: 'Nadia Benali',
    role: 'client_admin',
    storeSlugs: ['sakura-sushi-test'],
    purpose: 'Owner of ONE restaurant only: proves tenant isolation, Auto Blog starter',
    plan: 'starter',
  },
  {
    email: 'manager@beyours.test',
    name: 'Marie Martin',
    role: 'manager',
    storeSlugs: ['bella-napoli-test', 'burger-lab-test'],
    purpose: 'Manager of 2 restaurants; cannot reach the third',
  },
  {
    email: 'cuisine@beyours.test',
    name: 'Pierre Dupont',
    role: 'kitchen',
    storeSlugs: ['bella-napoli-test'],
    purpose: 'Kitchen display of Bella Napoli',
  },
  {
    email: 'service@beyours.test',
    name: 'Sophie Laurent',
    role: 'waiter',
    storeSlugs: ['bella-napoli-test'],
    purpose: 'Waiter of Bella Napoli',
  },
  {
    email: 'livreur@beyours.test',
    name: 'Karim Haddad',
    role: 'delivery',
    storeSlugs: ['bella-napoli-test'],
    purpose: 'Delivery driver of Bella Napoli',
  },
  {
    email: 'client1@beyours.test',
    name: 'Jean Durand',
    role: 'customer',
    storeSlugs: [],
    purpose: 'Diner with an order history',
  },
  {
    email: 'client2@beyours.test',
    name: 'Camille Moreau',
    role: 'customer',
    storeSlugs: [],
    purpose: 'Diner with no order yet: place the first one',
  },
]
