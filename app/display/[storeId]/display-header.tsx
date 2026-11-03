"use client"

import { useEffect, useState } from "react"

interface DisplayHeaderProps {
  storeName: string
}

export function DisplayHeader({ storeName }: DisplayHeaderProps) {
  const [time, setTime] = useState("")

  useEffect(() => {
    const update = () => {
      setTime(new Date().toLocaleTimeString("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
      }))
    }
    update()
    const id = setInterval(update, 60_000)
    return () => clearInterval(id)
  }, [])

  return (
    <header className="flex items-center justify-between px-8 py-4">
      <div className="flex items-center gap-3">
        <div className="live-dot h-3 w-3 rounded-full bg-green-500" />
        <h1 className="text-3xl font-bold">{storeName}</h1>
      </div>
      <time className="text-2xl font-mono tabular-nums text-slate-300">
        {time}
      </time>
    </header>
  )
}
