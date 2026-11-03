#!/usr/bin/env node
/**
 * Fails when the e2e run did not actually execute tests.
 *
 * Playwright exits 0 when it has nothing to run, and this suite has two ways of
 * having nothing to run that both look like success:
 *
 *   1. `playwright.config.ts` builds the `setup` and `admin` projects out of a
 *      spread — `...(hasRealBackend ? [project] : [])`. Without a backend they
 *      are not skipped, they are never declared, and 43 of 56 spec files vanish
 *      from the run AND from the report. There is no "skipped" line for a
 *      project that does not exist.
 *   2. Every test in a project can self-skip. `requireSeedPassword()` calls
 *      `test.skip(...)` when SEED_PASSWORD is unset, which is every test that
 *      signs in.
 *
 * Either way the job goes green over an untested product, which is worse than
 * no job at all because the green is believed. So: name the projects that must
 * report tests, and the floor the whole run must clear.
 *
 * Usage: node scripts/assert-e2e-ran.mjs <report.json> [--min N] [--projects a,b]
 */

import fs from "node:fs"

/* ── The verdict, as two pure functions so they can be tested ────────────── */

/** Walk the suite tree and count every test result by project and status. */
export function tally(report) {
  const byProject = new Map()
  const bump = (project, key) => {
    if (!byProject.has(project)) {
      byProject.set(project, { ran: 0, skipped: 0 })
    }
    byProject.get(project)[key]++
  }

  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const project = test.projectName || suite.title || "(unnamed)"
        // "skipped" covers both test.skip() and a test never attempted. An
        // empty `results` array is the second case: `every` is true on it.
        const skipped = (test.results ?? []).every((r) => r.status === "skipped")
        bump(project, skipped || test.status === "skipped" ? "skipped" : "ran")
      }
    }
    for (const child of suite.suites ?? []) visit(child)
  }
  for (const suite of report.suites ?? []) visit(suite)
  return byProject
}

/** Everything wrong with this run, in the words the job log will carry. */
export function verdict(byProject, min, required) {
  const problems = []
  const totalRan = [...byProject.values()].reduce((n, p) => n + p.ran, 0)

  if (totalRan < min) {
    problems.push(`only ${totalRan} test(s) actually ran; at least ${min} were expected`)
  }
  for (const { name, min: floor } of required) {
    const counts = byProject.get(name)
    if (!counts) {
      problems.push(
        `project "${name}" reported nothing — it was not declared. ` +
          `That is the hasRealBackend spread: no backend, no project, no report, green run.`
      )
    } else if (counts.ran === 0) {
      problems.push(`project "${name}" declared ${counts.skipped} test(s) and ran none of them`)
    } else if (counts.ran < floor) {
      problems.push(
        `project "${name}" ran ${counts.ran} test(s); at least ${floor} were expected. ` +
          `A quarter of this suite is one shard, so a count this low usually means a ` +
          `shard's blob never reached the merge rather than that tests were removed.`
      )
    }
  }
  return problems
}

/**
 * Flags, strictly.
 *
 * The previous parser was `args[args.indexOf(name) + 1]`, which reads the
 * equals form as an unknown token and falls back to the default. So
 * `--min=100` meant a floor of 1, `--projects=setup,public,admin` meant no
 * per-project rule at all, and the two together exited 0 over a report holding
 * neither `setup` nor `admin`. A trailing `--min` with no value was worse:
 * `Number(undefined)` is NaN, `totalRan < NaN` is false, and the floor was
 * gone — the script exited 0 over an empty report, which is precisely the
 * failure it exists to prevent.
 *
 * None of that announced itself. So: both forms are understood, a flag without
 * a value is an error, and an unknown flag is an error rather than a silent
 * default.
 */
export function parseArgs(argv) {
  const out = { reportPath: undefined, min: 1, projects: [] }
  const positional = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf("=")
    const name = eq === -1 ? arg : arg.slice(0, eq)
    let value = eq === -1 ? argv[++i] : arg.slice(eq + 1)
    if (value === undefined || (eq === -1 && value.startsWith("--"))) {
      throw new Error(`${name} needs a value`)
    }

    if (name === "--min") {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`--min needs a non-negative whole number, got "${value}"`)
      }
      out.min = n
    } else if (name === "--projects") {
      // `name` or `name:min`. A bare name means "at least one test", which is
      // what this flag used to mean everywhere.
      const list = []
      for (const item of value.split(",").map((s) => s.trim()).filter(Boolean)) {
        const [pname, pmin] = item.split(":")
        if (!pname) throw new Error(`--projects entry "${item}" has no project name`)
        if (pmin === undefined) {
          list.push({ name: pname, min: 1 })
          continue
        }
        const n = Number(pmin)
        if (!Number.isInteger(n) || n < 1) {
          throw new Error(`--projects entry "${item}" needs a whole floor of 1 or more`)
        }
        list.push({ name: pname, min: n })
      }
      if (list.length === 0) throw new Error("--projects needs at least one project name")
      out.projects = list
    } else {
      throw new Error(`unknown flag ${name}`)
    }
  }

  out.reportPath = positional[0]
  return out
}

/* ── Check 0: the guard has to still work ───────────────────────────────── */

/**
 * This script is the only thing standing between a suite that ran nothing and a
 * green required check. Nothing else asserts its behaviour, so it asserts its
 * own — on every run, in the job that is about to trust it. The cases are the
 * three ways the suite has actually gone hollow, plus a healthy run, because a
 * guard that only ever fails is switched off within the week.
 */
const SELF_TEST = [
  {
    name: "an empty report is not a pass",
    report: { suites: [] },
    expect: "reject",
  },
  {
    name: "a project that was never declared is not a pass, whatever the count",
    report: synth({ public: { ran: 150 } }),
    expect: "reject",
  },
  {
    name: "a project that declared tests and skipped them all is not a pass",
    report: synth({ setup: { ran: 1 }, public: { ran: 150 }, admin: { skipped: 40 } }),
    expect: "reject",
  },
  {
    // Every required project is present and running, so only the floor can
    // reject this. Without it the `--min` check could be deleted and every
    // other case here would still pass.
    name: "a run far below the floor is not a pass, even with every project present",
    report: synth({ setup: { ran: 1 }, public: { ran: 2 }, admin: { ran: 1 } }),
    expect: "reject",
  },
  {
    // Measured on run 33750984671: setup 4, public 75, admin 463. Losing one
    // shard of four takes admin to roughly 347, which must not pass.
    name: "a project that lost a shard's worth of tests is not a pass",
    report: synth({ setup: { ran: 4 }, public: { ran: 56 }, admin: { ran: 347 } }),
    expect: "reject",
  },
  {
    name: "a real run passes",
    report: synth({ setup: { ran: 4 }, public: { ran: 75 }, admin: { ran: 463 } }),
    expect: "accept",
  },
]

/** Build a Playwright-shaped report: { project: { ran, skipped } }. */
function synth(projects) {
  const specs = []
  for (const [projectName, counts] of Object.entries(projects)) {
    for (let i = 0; i < (counts.ran ?? 0); i++) {
      specs.push({ tests: [{ projectName, status: "expected", results: [{ status: "passed" }] }] })
    }
    for (let i = 0; i < (counts.skipped ?? 0); i++) {
      specs.push({ tests: [{ projectName, status: "skipped", results: [{ status: "skipped" }] }] })
    }
  }
  return { suites: [{ title: "self-test", specs, suites: [] }] }
}

/**
 * The flag forms that used to disarm the guard silently. Each must now either
 * be understood correctly or be refused outright — never accepted as a default.
 */
const SELF_TEST_ARGS = [
  { argv: ["r.json", "--min", "100"], expect: { min: 100 } },
  { argv: ["r.json", "--min=100"], expect: { min: 100 } },
  { argv: ["r.json", "--projects", "a,b"], expect: { projects: [{ name: "a", min: 1 }, { name: "b", min: 1 }] } },
  { argv: ["r.json", "--projects=a,b"], expect: { projects: [{ name: "a", min: 1 }, { name: "b", min: 1 }] } },
  { argv: ["r.json", "--projects=a:60,b"], expect: { projects: [{ name: "a", min: 60 }, { name: "b", min: 1 }] } },
  { argv: ["r.json", "--projects=a:0"], expect: "throw" },
  { argv: ["r.json", "--projects=a:x"], expect: "throw" },
  { argv: ["r.json", "--projects=:60"], expect: "throw" },
  { argv: ["r.json", "--min"], expect: "throw" },
  { argv: ["r.json", "--min", "--projects", "a"], expect: "throw" },
  { argv: ["r.json", "--min", "abc"], expect: "throw" },
  { argv: ["r.json", "--projects="], expect: "throw" },
  { argv: ["r.json", "--porjects", "a"], expect: "throw" },
]

function selfTestArgs() {
  const broken = []
  for (const c of SELF_TEST_ARGS) {
    const shown = c.argv.join(" ")
    let got
    try {
      got = parseArgs(c.argv)
    } catch {
      if (c.expect !== "throw") broken.push(`\`${shown}\` should have parsed, but was refused`)
      continue
    }
    if (c.expect === "throw") {
      broken.push(`\`${shown}\` should have been refused, but parsed as ${JSON.stringify(got)}`)
      continue
    }
    for (const [k, v] of Object.entries(c.expect)) {
      if (JSON.stringify(got[k]) !== JSON.stringify(v)) {
        broken.push(`\`${shown}\` gave ${k}=${JSON.stringify(got[k])}, expected ${JSON.stringify(v)}`)
      }
    }
  }
  return broken
}

function selfTest() {
  const broken = selfTestArgs()
  for (const c of SELF_TEST) {
    const problems = verdict(tally(c.report), 100, [
      { name: "setup", min: 1 },
      { name: "public", min: 60 },
      { name: "admin", min: 350 },
    ])
    const accepted = problems.length === 0
    if (accepted !== (c.expect === "accept")) {
      broken.push(
        c.expect === "accept"
          ? `${c.name} — but it was rejected: ${problems.join("; ")}`
          : `${c.name} — but it was accepted`
      )
    }
  }
  return broken
}

/* ── Main ───────────────────────────────────────────────────────────────── */

let opts
try {
  opts = parseArgs(process.argv.slice(2))
} catch (e) {
  console.error(`::error::${e.message}`)
  console.error("Usage: node scripts/assert-e2e-ran.mjs <report.json> [--min N] [--projects a,b]")
  process.exit(1)
}
const { reportPath, min: MIN, projects: REQUIRED } = opts

const brokenGuard = selfTest()
if (brokenGuard.length) {
  console.error(`\n::error::The e2e guard itself is broken — ${brokenGuard.length} self-test failure(s):`)
  for (const p of brokenGuard) console.error(`  - ${p}`)
  console.error("\nIt can no longer tell a hollow run from a real one, so it must not be trusted.")
  process.exit(1)
}

if (!reportPath || !fs.existsSync(reportPath)) {
  console.error(`::error::No Playwright JSON report at ${reportPath ?? "<unset>"}.`)
  console.error("The run produced no report at all, so nothing can be said about it.")
  process.exit(1)
}

let report
try {
  report = JSON.parse(fs.readFileSync(reportPath, "utf8"))
} catch (e) {
  console.error(`::error::Playwright report at ${reportPath} is not valid JSON: ${e.message}`)
  process.exit(1)
}

const byProject = tally(report)
const totalRan = [...byProject.values()].reduce((n, p) => n + p.ran, 0)

console.log("Playwright executed:")
if (byProject.size === 0) console.log("  (no projects reported any test)")
for (const [project, counts] of [...byProject].sort()) {
  console.log(`  ${project.padEnd(12)} ${String(counts.ran).padStart(4)} ran, ${counts.skipped} skipped`)
}

const problems = verdict(byProject, MIN, REQUIRED)

if (problems.length) {
  console.error(`\n::error::The e2e suite did not run. ${problems.length} problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error("\nA suite that ran nothing must not report success.")
  process.exit(1)
}

console.log(`\n${totalRan} test(s) ran across ${byProject.size} project(s).`)
