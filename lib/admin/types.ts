import type { Id } from "@/convex/_generated/dataModel"

/**
 * Explicit types for Convex documents used in admin components.
 * These resolve the Doc<"table"> → { [x: string]: any } typing issue
 * where Convex codegen produces overly-wide index signatures.
 */

// ─── Kitchen Tickets ────────────────────────────────────────────
//
// Moved to `@be-yours/admin` (`src/lib/types.ts`) with the KDS itself.
// The screen used to live in this app and, byte for byte, in its twin, so a
// schema change had to be made in three places. It is made in one now, and
// nothing in this app reads these types any more.

// ─── Orders ─────────────────────────────────────────────────────

export type OrderItemOption = {
  optionId?: string
  optionName: string
  choiceId?: string
  choiceName?: string
  priceModifier: number
}

export type OrderItem = {
  productId?: Id<"products">
  productName: string
  quantity: number
  unitPrice: number
  selectedOptions: OrderItemOption[]
  subtotal: number
  notes?: string
  externalId?: string
}

export type OrderStatus = "pending" | "confirmed" | "preparing" | "ready" | "out_for_delivery" | "delivered" | "completed" | "cancelled"
// `refund_pending`: a paid order was cancelled and the money is owed back,
// but nothing has been sent yet. Mirrors the union in `@be-yours/admin`.
export type OrderPaymentStatus = "pending" | "paid" | "failed" | "refunded" | "partially_refunded" | "refund_pending"
export type OrderSource = "website" | "uber_eats" | "deliveroo" | "pos"
export type OrderType = "delivery" | "pickup" | "dine_in"

export type Order = {
  _id: Id<"orders">
  _creationTime: number
  storeId: Id<"stores">
  orderNumber: string
  customerId?: string
  customerInfo: {
    name: string
    email?: string
    phone?: string
  }
  type: OrderType
  status: OrderStatus
  items: OrderItem[]
  subtotal: number
  taxAmount: number
  deliveryFee?: number
  discountAmount?: number
  total: number
  deliveryAddress?: {
    street: string
    city: string
    postalCode: string
    country: string
    latitude?: number
    longitude?: number
    instructions?: string
  }
  paymentMethod?: string
  paymentStatus: OrderPaymentStatus
  source: OrderSource
  notes?: string
  estimatedPrepTime?: number
  estimatedDeliveryTime?: number
  completedAt?: number
  cancelledAt?: number
  cancellationReason?: string
  viewToken?: string
  createdAt: number
  updatedAt: number
}

// ─── Payments ───────────────────────────────────────────────────

export type PaymentProvider = "stripe" | "sumup" | "paypal" | "square" | "cash"
export type PaymentStatus = "pending" | "processing" | "succeeded" | "failed" | "refunded" | "partially_refunded"

export type Payment = {
  _id: Id<"payments">
  _creationTime: number
  orderId: Id<"orders">
  storeId: Id<"stores">
  amount: number
  currency: string
  provider: PaymentProvider
  status: PaymentStatus
  externalId?: string
  metadata?: {
    last4?: string
    brand?: string
    receiptUrl?: string
  }
  refundedAmount?: number
  refundReason?: string
  createdAt: number
  updatedAt: number
}

// ─── Team Members ───────────────────────────────────────────────

export type TeamMemberRole = "manager" | "kitchen" | "waiter" | "delivery"
export type InvitationStatus = "pending" | "accepted" | "expired"

export type TeamMember = {
  _id: Id<"teamMembers">
  _creationTime: number
  storeId?: Id<"stores">
  allStores: boolean
  userId?: string
  name: string
  email: string
  role: TeamMemberRole
  permissions: string[]
  invitationStatus: InvitationStatus
  invitationToken?: string
  invitedAt?: number
  isActive: boolean
  createdAt: number
  updatedAt: number
}

// ─── Categories ─────────────────────────────────────────────────

export type Category = {
  _id: Id<"categories">
  _creationTime: number
  name: string
  slug: string
  description?: string
  imageUrl?: string
  isActive: boolean
  storeId: Id<"stores">
  sortOrder: number
  parentId?: Id<"categories">
  createdAt: number
  updatedAt: number
}

// ─── Stores ─────────────────────────────────────────────────────

export type StoreStatus = "draft" | "open" | "closed" | "temporarily_unavailable"

export type Store = {
  _id: Id<"stores">
  _creationTime: number
  name: string
  slug: string
  description?: string
  address: {
    street: string
    city: string
    postalCode: string
    country: string
    latitude?: number
    longitude?: number
  }
  phone?: string
  email?: string
  useGlobalHours?: boolean
  hours: Array<{
    day: number
    open: string
    close: string
    isClosed: boolean
  }>
  status: StoreStatus
  overrides?: {
    services?: { dineIn: boolean; takeaway: boolean; delivery: boolean; clickAndCollect: boolean }
    minimumOrderAmount?: number
    deliveryRadius?: number
    deliveryFee?: number
    deliveryFreeAbove?: number
  }
  themeId?: string
  orderConfirmation?: "auto" | "manual"
  orderMode?: "auto_accept" | "auto_reject" | "manual"
  printConfig?: {
    provider: "browser" | "star_cloud" | "epson_cloud" | "sunmi_cloud"
    printerId?: string
    apiKey?: string
    triggers: ("confirmed" | "ready" | "reprint")[]
    paperSize: "80mm" | "58mm"
    enabled: boolean
  }
  displayConfig?: { autoDismissEnabled: boolean; autoDismissMinutes: number }
  soundConfig?: {
    newTicket: { enabled: boolean; volume: number }
    overdue: { enabled: boolean; volume: number }
    printerOffline: { enabled: boolean; volume: number }
  }
  trendingMode?: "manual" | "automatic"
  branding?: unknown
  integrations?: unknown
  settings?: unknown
  createdAt: number
  updatedAt: number
}

// ─── Products ───────────────────────────────────────────────────

export type Product = {
  _id: Id<"products">
  _creationTime: number
  storeId: Id<"stores">
  categoryId: Id<"categories">
  name: string
  slug: string
  description?: string
  price: number
  images: string[]
  isActive: boolean
  isFeatured: boolean
  sortOrder: number
  tags: string[]
  allergens: string[]
  createdAt: number
  updatedAt: number
}

// ─── Store Integrations ─────────────────────────────────────────

export type IntegrationPlatform = "uberEats" | "deliveroo"

export type StoreIntegration = {
  _id: Id<"storeIntegrations">
  _creationTime: number
  storeId: Id<"stores">
  platform: IntegrationPlatform
  platformStoreId: string
  syncMenu: boolean
  autoAccept: boolean
  orderMode?: "auto_accept" | "auto_reject" | "manual"
  enabled: boolean
  brandId?: string
  storeStatus?: "ONLINE" | "PAUSED" | "OFFLINE"
  prepTime?: number
  lastMenuSyncAt?: number
  menuSyncStatus?: "idle" | "syncing" | "success" | "error"
  menuSyncError?: string
  lastSyncAt?: number
  createdAt: number
  updatedAt: number
}

// ─── Languages ──────────────────────────────────────────────────

export type Language = {
  _id: Id<"languages">
  _creationTime: number
  storeId: Id<"stores">
  code: string
  name: string
  nativeName: string
  flagEmoji?: string
  isDefault: boolean
  isActive: boolean
  isRtl: boolean
  sortOrder?: number
  createdAt: number
  updatedAt: number
}
