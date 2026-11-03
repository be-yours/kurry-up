"use client"

import { Truck, ShoppingBag, Utensils } from "lucide-react"
import type { OrderType } from "@be-yours/restaurant"
import { isOrderTypeOffered, type StoreServices } from "@be-yours/convex-schema"

interface OrderTypeSelectorProps {
  value: OrderType
  onChange: (type: OrderType) => void
  disabled?: boolean
  /**
   * The services in force, or `null` while they load.
   *
   * `null` used to mean "offer everything", and that is what put Livraison in
   * front of customers of a restaurant that does not deliver: the store
   * override this was read from is `undefined` on every establishment that has
   * not customised it. `null` now means "not known yet", and nothing is
   * offered until it is.
   */
  services?: StoreServices | null
}

/**
 * Which service each order type needs is `ORDER_TYPE_SERVICE`, next to the
 * schema — the same map `orders.create` validates against. Kept in one place so
 * the button a customer can press and the order the server accepts cannot
 * disagree.
 */
const options: {
  type: OrderType
  label: string
  icon: typeof Truck
}[] = [
  { type: "delivery", label: "Livraison", icon: Truck },
  { type: "pickup", label: "À emporter", icon: ShoppingBag },
  { type: "dine_in", label: "Sur place", icon: Utensils },
]

export function OrderTypeSelector({
  value,
  onChange,
  disabled,
  services,
}: OrderTypeSelectorProps) {
  const availableOptions = services
    ? options.filter((opt) => isOrderTypeOffered(opt.type, services))
    : []

  return (
    <div
      className={`grid gap-2 ${
        availableOptions.length === 3 ? "grid-cols-3" : availableOptions.length === 2 ? "grid-cols-2" : "grid-cols-1"
      } ${disabled ? "pointer-events-none opacity-50" : ""}`}
    >
      {availableOptions.map((opt) => {
        const isSelected = value === opt.type
        const Icon = opt.icon

        return (
          <button
            key={opt.type}
            onClick={() => onChange(opt.type)}
            className={`flex flex-col items-center gap-2 rounded-xl border px-3 py-3 text-center transition-colors ${
              isSelected
                ? "border-primary bg-primary/5 text-accent-foreground"
                : "border-border text-muted-foreground hover:border-primary/50"
            }`}
          >
            <Icon className="h-5 w-5" />
            <span className="text-xs font-medium">{opt.label}</span>
          </button>
        )
      })}
    </div>
  )
}
