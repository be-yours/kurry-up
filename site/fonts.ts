/**
 * Site fonts — CLIENT ZONE. Kurry Up, « La Fresque » (contract: site/ART_DIRECTION.md).
 *
 * The engine reads two variable names whatever typeface they carry: `--font-inter` is the BODY face and
 * `--font-poppins` the HEADING face (app/globals.css, `--font-heading`). Keep both names.
 *
 *   heading  Bungee 400 (David Jonathan Ross): capitals drawn for urban signage, the letter of a painted
 *            wall. One weight and no italic, so site/pages/shared.css sets headings to 400 and switches
 *            font synthesis off (the engine writes `font-black` and `italic` on its titles). Never the
 *            Shade / Inline / Outline cuts. Titles of 28 px and more only.
 *   body     Mukta 400 to 800 (Ek Type, Mumbai): the reading face, dish names in 800, prices in 700
 *            with tabular figures.
 *
 * Subsets: `latin` carries é è ê à ç ô û ï œ « » ’ € (U+00C0-00FF, U+0152-0153, U+2000-206F, U+20AC);
 * `latin-ext` is loaded as well for the names of the network (Saint-Denis de La Réunion is covered by
 * `latin`, but a street name with a rarer letter must not fall back to the system face mid-word).
 */
import { Bungee, Mukta } from "next/font/google"

const body = Mukta({
  variable: "--font-inter",
  weight: ["400", "500", "600", "700", "800"],
  subsets: ["latin", "latin-ext"],
  display: "swap",
})

const heading = Bungee({
  variable: "--font-poppins",
  weight: "400",
  subsets: ["latin", "latin-ext"],
  display: "swap",
})

export const fontVariables = `${body.variable} ${heading.variable}`
