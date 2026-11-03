#!/usr/bin/env node
/**
 * Builds the hero film of the home, « le film peint » — CLIENT ZONE. Owner: the « accueil » agent.
 *
 *   node site/tools/video.mjs            (ffmpeg on the PATH, sharp from node_modules)
 *
 * Source (never served): site/source/video/kurry-up-brand.mp4, the brand's own film (50,6 s, 1280x720, 25 fps,
 * downloaded with the user's agreement; image rights to be confirmed by the brand, see site/A_COMPLETER.md).
 *
 * Four plans, each 3 to 5 s, made of the brand's own cuts (hard cuts kept inside a plan). Between two plans the
 * cut is replaced by a PASS OF THE BRUSH (xfade custom): the next plan is painted over the previous one from left
 * to right, with a ragged dry-brush front, three bristle streaks running ahead and a thin cream wet edge, the
 * same gesture as the site's `.ky-passe` (ART_DIRECTION.md §6). The last plan is painted over the first one and
 * the file is cut so that its last frame meets its first: the loop has no seam.
 *
 * Framing 3:2 (1080x720 crop of the 720p source, each segment with its own horizontal offset), a light warm grade
 * (moderate saturation, no look), mild denoise for the encoder, no audio.
 *
 * Outputs (public/brand/video/):
 *   kurry-film-1080.mp4  H.264 High, 1080x720, ≥ 768 px      kurry-film-1080.webm  VP9, same
 *   kurry-film-720.mp4   H.264 Main, 720x480,  < 768 px      kurry-film-720.webm   VP9, same
 *   kurry-film-1080.webp, kurry-film-720.webp                  posters = the first frame of the loop
 * Intermediate (never served): site/source/video/kurry-film-master.mp4 (near-lossless 1080x720).
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const SRC = path.join(ROOT, "site/source/video/kurry-up-brand.mp4")
const MASTER = path.join(ROOT, "site/source/video/kurry-film-master.mp4")
const OUT = path.join(ROOT, "public/brand/video")

/** Width of the 3:2 crop in the 1280x720 source; `x` is the left edge of the crop (0 to 200). */
const CROP_W = 1080
/** Duration of a brush pass between two plans, in seconds (the site's pass is 500 ms; a film reads a bit slower). */
const PASS = 0.64

/** The plans: [start, end, cropX] in seconds of the source, cut on the source's own scene changes. */
const PLANS = {
  enseigne: [
    [9.96, 11.12, 200], // red plaque « INDIAN STREET FOOD », cream shaded letters
    [11.2, 12.32, 100], // red plaque « Feel good Vibes »
    [5.48, 6.6, 200], //   green awning « KURRY UP », cream letters
  ],
  poulet: [
    [21.72, 23.56, 100], // chicken tikka in the tray, the tongs
    [26.0, 28.24, 100], //  chicken tikka laid on the rice with the tongs
  ],
  bol: [
    [28.32, 29.64, 100], // butter chicken ladled over the rice
    [30.76, 31.64, 100], // the bowl filled from above, at the counter
    [31.72, 33.28, 100], // fresh coriander on the composed bowl
  ],
  naan: [
    [42.24, 42.72, 100], // the naan laid in the tandoor
    [43.6, 45.32, 100], //  butter brushed on the naan
    [45.4, 46.9, 100], //   the naan slipped into the Kurry Up paper
  ],
}
const ORDER = ["enseigne", "poulet", "bol", "naan"]

/* The brush front, in units of the frame width (xfade custom: P runs 1 -> 0, A = previous plan, B = next).
   q = 1 - P, eased by smoothstep; the front runs from -m to 1 + m so that the ragged edge starts fully off the
   left side and ends fully off the right one. The edge is made of bristles: the height is cut into bands (46,
   then 150 finer ones), each band leads by its own pseudo-random amount (hash of its index), on a slow wave;
   the rarest bands (dry streaks) run well ahead. The frames are in planar RGB here (gbrp, all planes full size). */
const M = 0.14
const hash = (n) => `(sin(floor(Y/H*${n})*12.9898+${n})*43758.5453-floor(sin(floor(Y/H*${n})*12.9898+${n})*43758.5453))`
const EDGE = `(0.028*sin(Y/H*6.3+1.1)+0.045*${hash(46)}+0.014*${hash(150)}+0.07*gt(${hash(46)},0.93))`
const Q = "((1-P)*(1-P)*(3-2*(1-P)))"
const FRONT = `(${Q}*${(1 + 2 * M).toFixed(2)}-${M}+${EDGE})`
/* cream #FDF3DA, the wet edge of the stroke: gbrp planes are G, B, R */
const CREAM = "if(eq(PLANE,0),243,if(eq(PLANE,1),218,253))"
const BRUSH = `if(lt(X/W,${FRONT}-0.014),B,if(lt(X/W,${FRONT}),${CREAM},A))`

const GRADE = [
  "hqdn3d=1.2:1.2:3:3",
  "eq=contrast=1.035:saturation=1.05:gamma=1.015",
  "colorbalance=rs=0.02:bs=-0.025:rm=0.03:bm=-0.03:rh=0.015:bh=-0.02",
].join(",")

function run(args) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" })
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(" ")}`)
}

function buildMaster() {
  const segs = ORDER.flatMap((p) => PLANS[p].map((s) => ({ plan: p, s })))
  const parts = [`[0:v]split=${segs.length}${segs.map((_, i) => `[s${i}]`).join("")}`]
  segs.forEach(({ s: [a, b, x] }, i) => {
    parts.push(`[s${i}]trim=start=${a}:end=${b},setpts=PTS-STARTPTS,crop=${CROP_W}:720:${x}:0,setsar=1[c${i}]`)
  })
  const len = {}
  let k = 0
  for (const p of ORDER) {
    const n = PLANS[p].length
    const ins = PLANS[p].map(() => `[c${k++}]`).join("")
    len[p] = PLANS[p].reduce((t, [a, b]) => t + (b - a), 0)
    parts.push(`${ins}concat=n=${n}:v=1:a=0,fps=25,settb=AVTB,format=gbrp[${p}]`)
  }
  // the first plan twice: once to open, once (its first second) to be painted over the last plan (the loop)
  parts.push(`[${ORDER[0]}]split=2[p0][loopsrc]`)
  parts.push(`[loopsrc]trim=end=${PASS + 0.4},setpts=PTS-STARTPTS[pend]`)
  const chain = ["p0", ...ORDER.slice(1), "pend"]
  const lens = [len[ORDER[0]], ...ORDER.slice(1).map((p) => len[p])]
  let prev = chain[0]
  let offset = 0
  for (let i = 1; i < chain.length; i++) {
    offset += lens[i - 1] - PASS
    const out = i === chain.length - 1 ? "xall" : `x${i}`
    parts.push(`[${prev}][${chain[i]}]xfade=transition=custom:duration=${PASS}:offset=${offset.toFixed(3)}:expr='${BRUSH}'[${out}]`)
    prev = out
  }
  // cut from PASS (the opening plan as it stands once a pass is complete) to offset + PASS (the same frame,
  // reached again at the end of the last pass): the loop is seamless
  const start = PASS
  const end = offset + PASS
  parts.push(`[xall]trim=start=${start}:end=${end.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p,${GRADE}[out]`)
  run(["-i", SRC, "-filter_complex", parts.join(";"), "-map", "[out]", "-an", "-c:v", "libx264", "-crf", "10", "-preset", "medium", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", MASTER])
  console.log(`master ${(end - start).toFixed(2)} s, plans ${ORDER.map((p) => `${p} ${len[p].toFixed(2)} s`).join(", ")}`)
}

/* the source is BT.709; the planar-RGB round trip leaves the master untagged */
const TAGS = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]

function encode() {
  fs.mkdirSync(OUT, { recursive: true })
  const sizes = [
    { name: "1080", scale: null, crf264: 27, crf9: 37, profile: ["-profile:v", "high", "-level", "4.0"] },
    { name: "720", scale: "scale=720:480:flags=lanczos", crf264: 28, crf9: 38, profile: ["-profile:v", "main", "-level", "3.1"] },
  ]
  for (const s of sizes) {
    const vf = s.scale ? ["-vf", s.scale] : []
    const mp4 = path.join(OUT, `kurry-film-${s.name}.mp4`)
    const webm = path.join(OUT, `kurry-film-${s.name}.webm`)
    run(["-i", MASTER, ...vf, "-an", "-c:v", "libx264", ...s.profile, "-crf", String(s.crf264), "-preset", "veryslow", "-tune", "film", "-g", "50", "-pix_fmt", "yuv420p", ...TAGS, "-movflags", "+faststart", mp4])
    run(["-i", MASTER, ...vf, "-an", "-c:v", "libvpx-vp9", "-crf", String(s.crf9), "-b:v", "0", "-deadline", "good", "-cpu-used", "1", "-row-mt", "1", "-g", "50", "-pix_fmt", "yuv420p", ...TAGS, webm])
  }
}

async function posters() {
  for (const s of [{ name: "1080", w: 1080, q: 74 }, { name: "720", w: 720, q: 72 }]) {
    const png = path.join(ROOT, "site/source/video", `poster-${s.name}.png`)
    run(["-i", path.join(OUT, `kurry-film-${s.name}.mp4`), "-frames:v", "1", png])
    await sharp(png).resize({ width: s.w }).webp({ quality: s.q, effort: 6 }).toFile(path.join(OUT, `kurry-film-${s.name}.webp`))
    fs.rmSync(png)
  }
}

fs.mkdirSync(OUT, { recursive: true })
const only = process.argv[2]
if (!only || only === "master") buildMaster()
if (!only || only === "encode") encode()
if (!only || only === "posters") await posters()
for (const f of fs.readdirSync(OUT).sort()) console.log(f.padEnd(24), `${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0)} Ko`)
