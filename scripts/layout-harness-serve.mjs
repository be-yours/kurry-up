#!/usr/bin/env node
/**
 * Serves `.layout-harness/` over HTTP, for reviewing the layout families (#507).
 *
 * Over HTTP rather than `file://` so the pages behave like pages: a linked
 * stylesheet resolves, there is no size ceiling on what a viewer will open, and
 * the browser applies the same rules it applies to the app.
 *
 * Run `node scripts/layout-harness.mjs` first to build the pages.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".layout-harness");
const PORT = Number(process.env.PORT ?? 4507);

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8" };

http
  .createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const file = path.join(ROOT, name === "/" ? "index.html" : name);

    // Nothing outside the harness directory, whatever the path claims.
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(fs.readFileSync(file));
  })
  .listen(PORT, () => console.log(`layout harness on http://localhost:${PORT}`));
