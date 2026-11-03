"use client"

interface DisplayFooterProps {
  storeSlug: string
}

export function DisplayFooter({ storeSlug }: DisplayFooterProps) {
  return (
    /* `slate-400`, not `slate-500`: this footer sits on the `#0f172a` the
       kitchen screen paints in `display.css`, where 500 measures 3.75:1 —
       under the 4.5:1 a 14px line owes, on a screen read across a kitchen. */
    <footer className="px-8 py-3 flex items-center justify-between text-sm text-slate-400">
      <span>{storeSlug}</span>
      <span>Powered by BeYours</span>
    </footer>
  )
}
