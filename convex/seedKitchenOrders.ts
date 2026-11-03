import {  } from "./_generated/server"
import { v } from "convex/values"
import { storeMutation } from "./lib/storeFunctions"

/**
 * Seed mutation: creates demo orders + kitchen tickets for testing KDS.
 * Requires auth. Creates 8 orders in various states to populate the kanban board.
 */

const SAMPLE_ITEMS = [
  [
    { productName: "Burger Classic", quantity: 2, options: ["Sans oignon", "Cheddar"], notes: "Bien cuit" },
    { productName: "Frites maison", quantity: 2, options: ["Grande portion"] },
    { productName: "Coca-Cola", quantity: 2, options: [] },
  ],
  [
    { productName: "Pizza Margherita", quantity: 1, options: ["Base tomate", "Mozzarella fraîche"] },
    { productName: "Tiramisu", quantity: 1, options: [] },
  ],
  [
    { productName: "Pad Thai", quantity: 1, options: ["Poulet", "Piquant"], notes: "Allergie arachides" },
    { productName: "Rouleaux de printemps", quantity: 3, options: ["Sauce soja"] },
  ],
  [
    { productName: "Caesar Salad", quantity: 1, options: ["Poulet grillé", "Sauce a part"] },
    { productName: "Soupe du jour", quantity: 1, options: [] },
  ],
  [
    { productName: "Poke Bowl Saumon", quantity: 2, options: ["Riz vinaigre", "Edamame", "Avocat"] },
    { productName: "Mochi", quantity: 4, options: ["Mangue", "Matcha"] },
  ],
  [
    { productName: "Steak frites", quantity: 1, options: ["Saignant", "Sauce poivre"], notes: "VIP - Table 3" },
    { productName: "Crème brulee", quantity: 2, options: [] },
    { productName: "Vin rouge (verre)", quantity: 2, options: ["Bordeaux"] },
  ],
  [
    { productName: "Fish & Chips", quantity: 3, options: ["Sauce tartare"] },
    { productName: "Coleslaw", quantity: 3, options: [] },
  ],
  [
    { productName: "Tacos poulet", quantity: 2, options: ["Guacamole", "Pico de gallo"] },
    { productName: "Nachos", quantity: 1, options: ["Fromage", "Jalapenos"] },
    { productName: "Limonade maison", quantity: 2, options: [] },
  ],
]

const CUSTOMER_NAMES = [
  "Jean Dupont", "Marie Martin", "Pierre Durand", "Sophie Bernard",
  "Lucas Moreau", "Emma Leroy", "Hugo Thomas", "Lea Petit",
]

const ORDER_TYPES = ["dine_in", "delivery", "pickup", "dine_in", "delivery", "pickup", "dine_in", "dine_in"] as const
const SOURCES = ["website", "uber_eats", "website", "pos", "deliveroo", "website", "pos", "website"] as const
const PRIORITIES = ["normal", "normal", "urgent", "normal", "normal", "vip", "normal", "normal"] as const
const STATIONS = [undefined, "mains", "starters", undefined, "mains", "mains", "starters", undefined]

/**
 * One per seeded order, `undefined` wherever `ORDER_TYPES` is not `dine_in`.
 * Mixed on purpose — a plain number, a room letter and a named area — because
 * that is what dining rooms actually use, and a demo of nothing but `1..8`
 * would suggest the field only takes integers.
 */
const TABLE_NUMBERS = ["12", undefined, undefined, "A3", undefined, undefined, "7", "Terrasse 2"] as const

function generateNanoid(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
  let result = ""
  for (let i = 0; i < 21; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

// Demo fixtures, deployed with the backend. Auth-only with a client `storeId`
// meant any account could inject fake orders into any restaurant's kitchen.
// `kitchen:manage` is held by super admins only.
export const seedKitchenOrders = storeMutation({
  permission: "kitchen:manage",
  args: { storeId: v.id("stores") },
  handler: async (ctx, args) => {

    const now = Date.now()

    // Get store for print config
    const store = await ctx.db.get(args.storeId)
    if (!store) throw new Error("Store not found")

    const createdIds: string[] = []

    for (let i = 0; i < 8; i++) {
      const orderNumber = `TEST-${String(i + 1).padStart(4, "0")}`
      const items = SAMPLE_ITEMS[i]!
      const orderType = ORDER_TYPES[i]!
      const source = SOURCES[i]!
      const priority = PRIORITIES[i]!
      const station = STATIONS[i]
      const customerName = CUSTOMER_NAMES[i]!
      const prepTime = 10 + Math.floor(Math.random() * 20) // 10-30 min
      const createdOffset = (8 - i) * 3 * 60_000 // stagger creation times

      // 1. Create the order
      const orderId = await ctx.db.insert("orders", {
        storeId: args.storeId,
        orderNumber,
        customerInfo: {
          name: customerName,
          email: `${customerName.toLowerCase().replace(" ", ".")}@test.com`,
          phone: `+33 6 ${String(10 + i).padStart(2, "0")} ${String(20 + i).padStart(2, "0")} ${String(30 + i).padStart(2, "0")} ${String(40 + i).padStart(2, "0")}`,
        },
        type: orderType,
        tableNumber: orderType === "dine_in" ? TABLE_NUMBERS[i] : undefined,
        status: "preparing",
        items: items.map((item) => ({
          productName: item.productName,
          quantity: item.quantity,
          unitPrice: 800 + Math.floor(Math.random() * 2000),
          selectedOptions: item.options.map((opt) => ({
            optionName: opt,
            priceModifier: 0,
          })),
          subtotal: item.quantity * (800 + Math.floor(Math.random() * 2000)),
          notes: item.notes,
        })),
        subtotal: 2000 + Math.floor(Math.random() * 5000),
        taxAmount: 400 + Math.floor(Math.random() * 1000),
        total: 2400 + Math.floor(Math.random() * 6000),
        paymentMethod: "card",
        paymentStatus: "paid",
        source,
        notes: i === 2 ? "ATTENTION: Allergie arachides" : undefined,
        estimatedPrepTime: prepTime,
        deliveryAddress: orderType === "delivery" ? {
          street: `${10 + i} Rue de la Paix`,
          city: "Paris",
          postalCode: "75001",
          country: "FR",
        } : undefined,
        createdAt: now - createdOffset,
        updatedAt: now - createdOffset,
      })

      // 2. Create the kitchen ticket
      const ticketCreatedAt = now - createdOffset

      // Determine ticket status based on index for demo variety
      let ticketStatus: "pending" | "in_progress" | "ready" | "completed"
      let startedAt: number | undefined
      let readyAt: number | undefined
      let completedAt: number | undefined
      let pickedUpAt: number | undefined

      if (i < 2) {
        // 0,1 => pending
        ticketStatus = "pending"
      } else if (i < 4) {
        // 2,3 => in_progress
        ticketStatus = "in_progress"
        startedAt = ticketCreatedAt + 60_000
      } else if (i < 6) {
        // 4,5 => ready
        ticketStatus = "ready"
        startedAt = ticketCreatedAt + 60_000
        readyAt = ticketCreatedAt + prepTime * 60_000
      } else {
        // 6,7 => completed
        ticketStatus = "completed"
        startedAt = ticketCreatedAt + 60_000
        readyAt = ticketCreatedAt + prepTime * 60_000
        completedAt = readyAt + 120_000
        if (i === 7) pickedUpAt = completedAt + 30_000
      }

      const trackingToken = generateNanoid()

      const ticketId = await ctx.db.insert("kitchenTickets", {
        storeId: args.storeId,
        orderId,
        orderNumber,
        orderType,
        items: items.map((item) => ({
          productName: item.productName,
          quantity: item.quantity,
          options: item.options,
          notes: item.notes,
        })),
        station,
        priority,
        source,
        assignedTo: undefined,
        estimatedPrepTime: prepTime,
        trackingToken,
        estimatedReadyAt: ticketCreatedAt + prepTime * 60_000,
        customerName: orderType === "delivery" ? customerName : undefined,
        customerPhone: orderType === "delivery" ? `+33 6 ${String(10 + i).padStart(2, "0")} 00 00 00` : undefined,
        tableNumber: orderType === "dine_in" ? TABLE_NUMBERS[i] : undefined,
        deliveryNotes: i === 1 ? "2eme étage, code 4578" : undefined,
        allergens: i === 2 ? ["arachides"] : undefined,
        status: ticketStatus,
        printStatus: "not_required",
        printAttempts: 0,
        startedAt,
        readyAt,
        completedAt,
        pickedUpAt,
        createdAt: ticketCreatedAt,
        updatedAt: now,
      })

      createdIds.push(ticketId)
    }

    return {
      created: createdIds.length,
      message: `${createdIds.length} commandes + tickets de test créés avec succès`,
    }
  },
})

/**
 * Clean up: remove all TEST- orders and their kitchen tickets
 */
export const cleanKitchenSeed = storeMutation({
  permission: "kitchen:manage",
  args: { storeId: v.id("stores") },
  handler: async (ctx, args) => {

    // Find all test kitchen tickets
    const tickets = await ctx.db
      .query("kitchenTickets")
      .withIndex("by_storeId", (q) => q.eq("storeId", args.storeId))
      .collect()

    const testTickets = tickets.filter((t) => t.orderNumber.startsWith("TEST-"))

    // Delete kitchen tickets
    for (const ticket of testTickets) {
      await ctx.db.delete(ticket._id)
    }

    // Find and delete test orders
    const orders = await ctx.db
      .query("orders")
      .withIndex("by_storeId", (q) => q.eq("storeId", args.storeId))
      .collect()

    const testOrders = orders.filter((o) => o.orderNumber.startsWith("TEST-"))

    for (const order of testOrders) {
      await ctx.db.delete(order._id)
    }

    return {
      deletedTickets: testTickets.length,
      deletedOrders: testOrders.length,
    }
  },
})
