#!/usr/bin/env node
/**
 * Logo variants and the app icon — CLIENT ZONE. Owner: agent « chrome » (site/ART_DIRECTION.md § 10).
 *
 * Source: public/brand/logo/kurry-up.svg, the brand's own logo supplied by the user (a copy is kept in
 * site/source/brand/logo-kurry-up-original.svg). The paths are never redrawn: the variants only change the
 * viewBox, drop the tagline path or change the fill.
 *
 *   kurry-up-mot.svg     the word alone (viewBox cut under the letters, tagline path removed): small sizes,
 *                        where the « INDIAN STREET FOOD » line would be under 6 px high
 *   kurry-up-creme.svg   the whole lockup in cream #FDF3DA, for the green footer (from 1024 px)
 *   kurry-up-mot-creme.svg  the word alone in cream, for the footer under 1024 px
 *   icon-192.png         the K of the logo in ink on a square of the brand orange #EA5800
 *
 *   node site/tools/logo-variants.mjs
 */
import { readFileSync, writeFileSync } from "node:fs"
import sharp from "sharp"

const root = new URL("../../public/brand/", import.meta.url)
const src = readFileSync(new URL("logo/kurry-up.svg", root), "utf8")

// Measured on a 400 dpi render: the letters run from y 0 to 130.38, the tagline from 165.68 to 176.30.
const WORD_H = 130.6
const paths = [...src.matchAll(/<path[^>]*\/>/g)].map((m) => m[0])
// the tagline is the one path that starts below the letters
const tagline = paths.filter((p) => {
  const y = Number(/d="m[\d.]+,([\d.]+)/.exec(p)?.[1] ?? 0)
  return y > WORD_H
})
if (tagline.length !== 1) throw new Error(`expected one tagline path, found ${tagline.length}`)

const word = src.replace(tagline[0], "").replace(/viewBox="[^"]+"/, `viewBox="0 0 555.82 ${WORD_H}"`)
writeFileSync(new URL("logo/kurry-up-mot.svg", root), word)

const creme = src.replace(/fill:#010000/g, "fill:#fdf3da")
writeFileSync(new URL("logo/kurry-up-creme.svg", root), creme)
writeFileSync(new URL("logo/kurry-up-mot-creme.svg", root), word.replace(/fill:#010000/g, "fill:#fdf3da"))

// The K: the first letter of the word, x 0 to 72 (the U starts near x 80).
const kSvg = word.replace(/viewBox="[^"]+"/, `viewBox="0 0 72 ${WORD_H}"`).replace(/fill:#010000/g, "fill:#1f1712")
const size = 192
const kH = Math.round(size * 0.66)
const k = await sharp(Buffer.from(kSvg), { density: 600 }).resize({ height: kH }).png().toBuffer()
const kMeta = await sharp(k).metadata()
await sharp({ create: { width: size, height: size, channels: 4, background: "#ea5800" } })
  .composite([{ input: k, left: Math.round((size - (kMeta.width ?? 0)) / 2), top: Math.round((size - kH) / 2) }])
  .png()
  .toFile(new URL("icon-192.png", root).pathname)

console.log("kurry-up-mot.svg, kurry-up-creme.svg, kurry-up-mot-creme.svg, icon-192.png written")
