#!/usr/bin/env node
/**
 * Toggle the trailing newline of `site/theme.css` — CLIENT ZONE.
 *
 * The dev CSS does not rebuild when only an imported `site/pages/*.css` changes: run this after each such
 * edit, then wait ~4 s. One read and one write, so several agents can call it without clobbering theme.css.
 *
 *   node site/tools/bump-theme.mjs
 */
import { readFileSync, writeFileSync } from "node:fs"

const file = new URL("../theme.css", import.meta.url)
const css = readFileSync(file, "utf8")
writeFileSync(file, css.endsWith("\n\n") ? css.slice(0, -1) : css.replace(/\n*$/, "\n\n"))
