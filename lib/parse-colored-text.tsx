import { Fragment } from "react"

/**
 * Parse text with {curly braces} and render the braced content
 * with an accent color class.
 *
 * Example:
 *   "Bienvenue Chez {Nous}" → "Bienvenue Chez " + <span class="text-orange-500">Nous</span>
 */
export function parseColoredText(
  text: string,
  accentClassName = "text-orange-500 not-italic",
): React.ReactNode {
  const parts = text.split(/(\{[^}]+\})/g)

  if (parts.length === 1) return text

  return (
    <Fragment>
      {parts.map((part, i) => {
        if (part.startsWith("{") && part.endsWith("}")) {
          return (
            <span key={i} className={accentClassName}>
              {part.slice(1, -1)}
            </span>
          )
        }
        return part
      })}
    </Fragment>
  )
}
