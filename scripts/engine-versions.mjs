#!/usr/bin/env node
/**
 * Which `@be-yours/*` versions this run actually installed.
 *
 * WHAT IT ANSWERS. The declared range is already in `package.json`. What a
 * failure cannot tell you is which version that range RESOLVED to, and this is
 * the one repository where the question matters: the application shell is
 * synced from the engine at HEAD, while the `@be-yours/*` packages arrive
 * from the registry at whatever was last published. Those two can be days
 * apart.
 *
 * On 07/09/2026 that cost a full diagnostic cycle. Runs 169, 171 and 172 all
 * failed on `product-form.spec.ts > should add choices to an option`, three
 * attempts each — and 172 ran AFTER the fix for exactly that test had merged
 * upstream, so it read as the fix failing. It was not. `^9.0.0` still resolved
 * to 9.0.0: a change to `packages/*` reaches a client only once a release is
 * published, and none had been. 9.0.1 turned the test green on the first
 * attempt. The gap this closes on the reading side is #389; the publishing side
 * is still open there.
 *
 * WHY IT IS A SCRIPT RATHER THAN AN INLINE `node -e`. It used to be inline, in
 * the `e2e` job only — and `e2e` carries `needs: web`, so GitHub skips it
 * outright whenever `web` (Lint, Typecheck, Unit tests, Build) fails. The
 * step's own `if: always()` cannot help there: `always()` is a STEP condition
 * and cannot resurrect a job that never started.
 *
 * That is precisely backwards, because the failure this diagnoses breaks the
 * build before it ever breaks Playwright. `scripts/check-mirror-build.mjs`
 * records the canonical instance: `Cannot find module
 * '@be-yours/admin/game'` — a **Typecheck** failure, in 71 of the
 * boilerplate's last 100 runs. In every one of those, `web` went red, `e2e` was
 * skipped, and the three lines that would have said "declared `^8.0.0` →
 * installed `8.0.0`, and the symbol landed at HEAD" never printed. The
 * diagnostic was reachable only when the build had already succeeded, i.e. only
 * when the version was probably fine.
 *
 * So both jobs run it now, and a script is what lets them without a second copy
 * of the logic drifting from the first.
 *
 * WHY IT IS THE LAST STEP AND NOT BESIDE `pnpm install`. A red run is read from
 * the END of its log. Printed at install time this would sit ~1400 lines from
 * the end, which is the same as not printing it. It also writes the run summary,
 * where log position does not matter at all.
 *
 * Exit code is always 0: this is a diagnostic, and a job must never go red
 * because the thing explaining the failure could not run.
 */
import { readFileSync, existsSync, appendFileSync } from 'node:fs'

const ENGINE_SCOPE = '@be-yours/'

// The whole body, because the promise above has to be true rather than
// intended. It was not: a malformed `package.json` threw SyntaxError and a
// missing one threw ENOENT, both exiting 1 — in a step that runs on `always()`
// in an already-failing job, i.e. exactly where this runs.
try {
  main()
} catch (error) {
  console.log(`Could not read the installed engine versions: ${error.message}`)
}

function main() {
  const deps = JSON.parse(readFileSync('package.json', 'utf8')).dependencies || {}
  const rows = Object.keys(deps)
    .filter((name) => name.startsWith(ENGINE_SCOPE))
    .map((name) => {
      const manifest = 'node_modules/' + name + '/package.json'
      // NOT INSTALLED rather than a throw: this runs on `always()`, so it must
      // survive a job that died before install — which is most of the runs it
      // exists for.
      const installed = existsSync(manifest)
        ? JSON.parse(readFileSync(manifest, 'utf8')).version
        : 'NOT INSTALLED'
      return [name, deps[name], installed]
    })

  if (rows.length === 0) {
    console.log('No @be-yours/* dependency is declared.')
    return
  }

  const width = Math.max(...rows.map((row) => row[0].length))
  console.log('Engine packages this run installed:')
  console.log('')
  for (const [name, range, installed] of rows) {
    console.log('  ' + name.padEnd(width) + '  ' + range.padEnd(9) + ' -> ' + installed)
  }

  // Also on the run summary page, which is where a human looks and where log
  // position does not matter.
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) {
    const table = [
      '### Engine packages installed',
      '',
      '| Package | Declared | Installed |',
      '| --- | --- | --- |',
    ]
      .concat(rows.map((row) => '| `' + row[0] + '` | `' + row[1] + '` | `' + row[2] + '` |'))
      .join('\n')
    appendFileSync(summary, table + '\n\n')
  }
}
