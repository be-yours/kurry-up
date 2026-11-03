import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/* ── THE CLOCK AND THE COLLATION, DECLARED RATHER THAN INHERITED (#635) ──
   No vitest config, setup file or workflow set `TZ` or `LANG`, so CI was UTC by
   ACCIDENT — the runner's default — and a laptop was whatever the person had.
   That is how the March clock-change defect in `dashboardStats.ts` passed CI and
   failed on a machine set to Europe/Paris: the test was right, the environment
   was never stated, and the disagreement had nowhere to surface.

   `??=`, so a deliberate override still wins — the `Test (Europe/Paris)` job in
   ci.yml is that override. A suite that must run in a real French zone should
   say so per test with `vi.stubEnv`, where the intent is visible.

   WRITTEN OUT IN EACH CONFIG RATHER THAN IMPORTED FROM THE ROOT. `apps/themes`
   is cloned on its own, without this monorepo around it, so a
   `../../vitest.shared` resolves to nothing for a client and vitest refuses to
   start — `pnpm check:mirror-build` caught exactly that. The duplication is the
   price of a file that still works after the clone, and
   `ci-coverage.test.ts` asserts every config carries it.

   Set here rather than in `test.env` because a module that reads the zone at
   import time does so before a worker's env is applied. */
process.env.TZ ??= 'UTC'
process.env.LANG ??= 'C.UTF-8'

export default defineConfig({
  // The app imports itself as `@/…`. Type-only imports erase before Vitest ever
  // resolves them, which is why this was not needed until a tested module
  // imported a *value* that way.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  // The automatic JSX runtime, stated here rather than left to tsconfig
  // discovery. esbuild resolves `jsx` from the tsconfig NEAREST THE FILE, and
  // the engine packages ship `files: ["src"]` — source, no tsconfig. So a
  // `.tsx` inside `node_modules/@be-yours/*` got the classic transform,
  // which emits `React.createElement` into a module that never imports React:
  // `ReferenceError: React is not defined`, from `ui/src/components/Empty.tsx`
  // and `admin/src/game/actions-screen.tsx`. This app's own tsconfig already
  // says `"jsx": "react-jsx"`; this makes that true for everything Vitest
  // transforms, not only for the files it happens to find a tsconfig beside.
  esbuild: { jsx: 'automatic' },
  // ---------------------------------------------------------------------
  // THE `test` SCRIPT IN package.json RUNS THIS SUITE IN FOUR SEQUENTIAL
  // SHARDS, and that is not a speed optimisation — it is what keeps the run
  // from failing on a slow machine.
  //
  // A worker talks to the main process over birpc, and `DEFAULT_TIMEOUT` in
  // vitest 3.2.7 is 60 s, hard-coded: `getRpcOptions()` passes no timeout, so
  // no config here can raise it. While the main thread is busy transforming
  // the module graph, a worker's `onTaskUpdate` waits. Past 60 s it throws
  // `[vitest-worker]: Timeout calling "onTaskUpdate"` and vitest exits
  // non-zero over a run in which every test passed — which is exactly what CI
  // reported four times: `193 passed · 2920 passed · Errors 1 error`.
  //
  // It is the collection burst that blocks, and sharding bounds it. Measured
  // on this suite: whole, `collect 41.33s`; worst of four shards, 18.09s. The
  // runner that failed was 1.4x slower than the one that passed, uniformly
  // across every phase, which put the whole-suite burst over the line and
  // leaves a shard comfortably under it. Four sequential processes cost about
  // 10 % more wall time (74.5s against 67.56s) and that is the price.
  //
  // Reducing workers was measured and rejected: `--maxWorkers=2` bought 17 %
  // off collect for 24 % more duration, and `=1` doubled the run.
  //
  // `test:coverage` deliberately does NOT shard — four partial reports are not
  // a coverage report.
  // ---------------------------------------------------------------------
  test: {
    globals: true,
    // The engine packages ship TypeScript SOURCE, not a build: `admin`,
    // `convex-functions`, `convex-schema` and `ui` all declare `files: ["src"]`
    // and point `main` at `./src/index.ts`. Inside the monorepo that is
    // invisible — pnpm symlinks `node_modules/@be-yours/*` to
    // `packages/*`, so the resolved path falls OUTSIDE `node_modules` and gets
    // transformed like first-party source. A client installs a real directory
    // inside `node_modules`, where Vitest transforms nothing by default, and
    // the suite dies twice over: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`
    // when Node is handed a `.ts` file, and `React is not defined` when a
    // `.tsx` file reaches the runtime with its JSX uncompiled.
    //
    // `next.config.ts` already says this for the build, with
    // `transpilePackages`. Nothing had said it for the test run, so the first
    // release that published these packages as source (2026-09-06) turned the
    // boilerplate's CI red on a template that compiles perfectly here. Every
    // runner that transforms code needs its own version of this statement.
    server: { deps: { inline: [/@be-yours\//] } },
    // 30s was sized for the convex-test cold start on a machine doing nothing
    // else: each of the 27 suites compiles the whole `convex/` module graph on
    // its first call. Under contention that cost is not linear — a run measured
    // 433s of collection where an idle one takes 16s, and
    // `unsubscribe-link.test.ts` crossed 30s on its first `t.fetch`, which is
    // the cold start and not the assertion. 60s still catches a genuine hang,
    // and no longer turns a busy runner into a red build.
    testTimeout: 60_000,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Playwright owns the *.spec.ts files under e2e/. The *.test.ts files
      // there are Vitest suites (the Deliveroo scenarios) and must stay
      // visible: excluding all of e2e/ hid eleven of them from both runners.
      // `reference` fixed exactly this and the fix was never carried over.
      '**/e2e/**/*.spec.ts',
      '**/e2e/**/*.setup.ts',
      '**/.{idea,git,cache,output,temp}/**',
    ],
  },
})
