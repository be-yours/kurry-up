"use client"

import { Empty, EmptyHeader, EmptyTitle } from "@be-yours/ui"

interface DisplayTicket {
  _id: string
  orderNumber: string
  status: string
  createdAt: number
  readyAt?: number
}

interface DisplayColumnProps {
  title: string
  tickets: DisplayTicket[]
  variant: "preparing" | "ready"
  flashingIds: Set<string>
}

export function DisplayColumn({
  title,
  tickets,
  variant,
  flashingIds,
}: DisplayColumnProps) {
  const borderClass = variant === "preparing"
    ? "display-ticket-preparing"
    : "display-ticket-ready"

  const headerColor = variant === "preparing"
    ? "text-amber-400"
    : "text-green-400"

  return (
    <div className="flex-1 px-4">
      <div className="flex items-center gap-3 mb-6">
        <h2 className={`text-2xl font-bold ${headerColor}`}>
          {title}
        </h2>
        <span className="text-lg text-slate-400 font-mono">
          ({tickets.length})
        </span>
      </div>

      <div className="space-y-3">
        {tickets.length === 0 ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyTitle>Aucune commande</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          tickets.map((ticket) => (
            <div
              key={ticket._id}
              className={`display-ticket ${borderClass} ${
                flashingIds.has(ticket._id) ? "ticket-flash" : ""
              }`}
            >
              <span className="text-3xl font-bold tabular-nums">
                #{ticket.orderNumber}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
