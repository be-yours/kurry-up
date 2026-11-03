/**
 * French typography for visitor copy. CLIENT ZONE. Owner: agent « réseau + franchise ».
 *
 * Copy is written with ordinary spaces in `copy.ts`; this pass puts the non-breaking space where French
 * wants it (before : ; ? ! € and », after «, between a number and its unit h / min). It runs once, at
 * module load, on plain strings only: deterministic, so the server and the client render the same text.
 */

const NB = '\u00a0'

export function typo(s: string): string {
  return s
    .replace(/ ([:;?!€»])/g, `${NB}$1`)
    .replace(/« /g, `«${NB}`)
    .replace(/(\d) (h|min|H|MIN|j)\b/g, `$1${NB}$2`)
    .replace(/\bh (\d)/g, `h${NB}$1`)
}

/** The same pass on every string of a copy object (arrays and nested objects included). */
export function typoDeep<T>(value: T): T {
  if (typeof value === 'string') return typo(value) as T
  if (Array.isArray(value)) return value.map((v) => typoDeep(v)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = typoDeep(v)
    return out as T
  }
  return value
}
