import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * `pnpm ses:check` — the go-live gate of `tasks/client-aws-onboarding-runbook.md`.
 *
 * The script answers one question: can this AWS account email a real customer
 * yet, or is it still in the SES sandbox? Nothing else in the product reports
 * that — every sending path swallows a sandbox rejection and returns success —
 * so the runbook's step 6 trusts this exit code alone.
 *
 * That makes a *wrong* answer worse than no answer, and two wrong answers were
 * shipped here before these tests existed:
 *
 *  1. the `sesv2 get-account` response was passed through `eval`, so a field
 *     containing `$(…)` was executed by the shell and the script then graded
 *     the result of that execution rather than what AWS said;
 *  2. an `EnforcementStatus` the script did not recognise was warned about and
 *     then blessed with exit 0 — a gate reporting green on a state it had not
 *     understood.
 *
 * The suite drives the real script with a stub `aws` on PATH, so it exercises
 * the shell as an operator runs it. It asserts on exit codes because that is
 * the contract the runbook and the sign-off checklist consume.
 */

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-ses-status.sh")

/** SESv2 GetAccount, as returned by an account that has left the sandbox. */
const PRODUCTION = JSON.stringify({
  ProductionAccessEnabled: true,
  SendingEnabled: true,
  EnforcementStatus: "HEALTHY",
  SendQuota: { Max24HourSend: 50000, SentLast24Hours: 301, MaxSendRate: 14 },
})

/** The same call on a fresh account: still sandboxed, no request filed. */
const SANDBOX = JSON.stringify({
  ProductionAccessEnabled: false,
  SendingEnabled: true,
  EnforcementStatus: "HEALTHY",
  SendQuota: { Max24HourSend: 200, SentLast24Hours: 12, MaxSendRate: 1 },
})

let stubDir

beforeAll(() => {
  // A stub `aws` that replays canned responses. Real credentials are never
  // available in CI, and the paths worth pinning are the ones a live account
  // reaches once and then never again.
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "ses-check-"))
  fs.writeFileSync(
    path.join(stubDir, "aws"),
    [
      "#!/usr/bin/env bash",
      'case "$1 $2" in',
      '  "sts get-caller-identity")',
      '    [ "${FAKE_AUTH:-yes}" = "no" ] && exit 255',
      '    echo "123456789012"; exit 0 ;;',
      '  "sesv2 get-account")',
      '    [ -n "${FAKE_ACCOUNT_JSON+x}" ] || exit 254',
      "    printf '%s' \"$FAKE_ACCOUNT_JSON\"; exit 0 ;;",
      '  "sesv2 get-email-identity")',
      '    [ -n "${FAKE_IDENTITY_JSON+x}" ] || exit 254',
      "    printf '%s' \"$FAKE_IDENTITY_JSON\"; exit 0 ;;",
      "esac",
      "exit 254",
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
})

afterAll(() => {
  fs.rmSync(stubDir, { recursive: true, force: true })
})

/**
 * Run the script with the stub ahead of the real PATH.
 *
 * `node` is put on PATH explicitly: the script requires it to read the JSON,
 * and the interpreter running Vitest is not guaranteed to be on PATH under
 * every package manager.
 *
 * `bareEnv` builds a PATH holding ONLY the directory `node` lives in, and
 * deliberately does NOT inherit `process.env.PATH`. The point of that case is a
 * machine with no AWS CLI, and inheriting the real PATH made it a question
 * about the machine instead: it passed on a container with no `aws` installed
 * and failed on a GitHub runner, which ships one.
 *
 * @param {Record<string, string>} env
 * @param {{ bareEnv?: boolean }} [opts] omit the stub, to test a missing CLI
 */
/**
 * Where `bash` actually is.
 *
 * Resolved once, and the script is spawned through the absolute path, because
 * the `bareEnv` case hands the child a PATH that deliberately holds almost
 * nothing — spawning by name there fails to find the interpreter and produces
 * no output at all, which is not the thing under test.
 */
const BASH = ["/bin/bash", "/usr/bin/bash"].find((p) => fs.existsSync(p)) ?? "bash"

function run(env, opts = {}) {
  const nodeDir = path.dirname(process.execPath)
  const searchPath = opts.bareEnv
    ? nodeDir
    : [stubDir, nodeDir, process.env.PATH].join(path.delimiter)
  const result = spawnSync(BASH, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: searchPath,
      // Never inherit a real developer's region or domain into an assertion.
      AWS_REGION: "eu-west-3",
      DOMAIN: "",
      ...env,
    },
  })
  // ANSI colour would otherwise defeat every string assertion below.
  const stdout = (result.stdout ?? "").replace(/\[[0-9;]*m/g, "")
  return { code: result.status, stdout }
}

describe("check-ses-status.sh — the account verdict", () => {
  it("exits 0 and says READY once production access is granted", () => {
    const { code, stdout } = run({ FAKE_ACCOUNT_JSON: PRODUCTION })
    expect(stdout).toContain("Production access: GRANTED")
    expect(stdout).toContain("READY — this account can email real customers.")
    expect(code).toBe(0)
  })

  it("exits 1 and names the sandbox when production access is not granted", () => {
    const { code, stdout } = run({ FAKE_ACCOUNT_JSON: SANDBOX })
    expect(stdout).toContain("SANDBOX")
    expect(stdout).toContain("No review on file")
    expect(stdout).toContain("NOT READY")
    expect(code).toBe(1)
  })

  it("reports the review status and the AWS support case when one is on file", () => {
    const { code, stdout } = run({
      FAKE_ACCOUNT_JSON: JSON.stringify({
        ...JSON.parse(SANDBOX),
        Details: { ReviewDetails: { Status: "PENDING", CaseId: "175012345600001" } },
      }),
    })
    expect(stdout).toContain("Review of your request: PENDING")
    expect(stdout).toContain("support case 175012345600001")
    expect(code).toBe(1)
  })

  it("blocks on a disabled account and on a paused reputation", () => {
    const disabled = run({
      FAKE_ACCOUNT_JSON: JSON.stringify({ ...JSON.parse(PRODUCTION), SendingEnabled: false }),
    })
    expect(disabled.stdout).toContain("Sending: DISABLED")
    expect(disabled.code).toBe(1)

    const shutdown = run({
      FAKE_ACCOUNT_JSON: JSON.stringify({ ...JSON.parse(PRODUCTION), EnforcementStatus: "SHUTDOWN" }),
    })
    expect(shutdown.stdout).toContain("Reputation: SHUTDOWN")
    expect(shutdown.code).toBe(1)
  })
})

describe("check-ses-status.sh — a wrong answer must be impossible", () => {
  it("does not execute a command substitution carried in the response", () => {
    // Regression: the response used to be `eval`'d. This wrote the marker file
    // AND made the script grade the value as HEALTHY, because the shell had
    // already consumed the `$(…)`.
    const marker = path.join(stubDir, "injected.txt")
    const { code, stdout } = run({
      FAKE_ACCOUNT_JSON: JSON.stringify({
        ...JSON.parse(PRODUCTION),
        EnforcementStatus: `HEALTHY$(touch ${marker})`,
      }),
    })
    expect(fs.existsSync(marker)).toBe(false)
    // Reported verbatim, so the operator sees what AWS actually returned.
    expect(stdout).toContain(`HEALTHY$(touch ${marker})`)
    expect(stdout).not.toContain("Reputation: HEALTHY.")
    expect(code).toBe(2)
  })

  it("refuses to call an unrecognised reputation ready", () => {
    const { code, stdout } = run({
      FAKE_ACCOUNT_JSON: JSON.stringify({
        ...JSON.parse(PRODUCTION),
        EnforcementStatus: "SOME_FUTURE_STATE",
      }),
    })
    expect(stdout).toContain("unrecognised")
    expect(stdout).toContain("COULD NOT TELL")
    expect(stdout).not.toContain("READY — this account")
    expect(code).toBe(2)
  })

  it("prefers a named blocker over 'could not tell' when both apply", () => {
    const { code, stdout } = run({
      FAKE_ACCOUNT_JSON: JSON.stringify({
        ...JSON.parse(SANDBOX),
        EnforcementStatus: "SOME_FUTURE_STATE",
      }),
    })
    expect(stdout).toContain("NOT READY")
    expect(code).toBe(1)
  })

  it("treats an unreadable response as unknown, never as 'not sandboxed'", () => {
    for (const body of ["<html>503 Service Unavailable</html>", '"a string"', "null"]) {
      const { code, stdout } = run({ FAKE_ACCOUNT_JSON: body })
      expect(stdout).toContain("Could not parse")
      expect(code).toBe(2)
    }
  })
})

describe("check-ses-status.sh — it says what to do when it cannot run", () => {
  it("exits 2 with an actionable message when the AWS CLI is absent", () => {
    const { code, stdout } = run({}, { bareEnv: true })
    expect(stdout).toContain("aws not found on PATH")
    expect(stdout).toContain("aws configure")
    expect(stdout).toContain("client-aws-onboarding-runbook.md")
    expect(code).toBe(2)
  })

  it("exits 2 and names the remedy when there are no credentials", () => {
    const { code, stdout } = run({ FAKE_AUTH: "no" })
    expect(stdout).toContain("No AWS credentials")
    expect(stdout).toContain("aws configure")
    expect(code).toBe(2)
  })
})

describe("check-ses-status.sh — the identity, when DOMAIN is given", () => {
  it("passes once DKIM reads SUCCESS and the identity is verified", () => {
    const { code, stdout } = run({
      FAKE_ACCOUNT_JSON: PRODUCTION,
      DOMAIN: "chez-mario.fr",
      FAKE_IDENTITY_JSON: JSON.stringify({
        DkimAttributes: { Status: "SUCCESS" },
        VerifiedForSendingStatus: true,
      }),
    })
    expect(stdout).toContain("DKIM for chez-mario.fr: SUCCESS.")
    expect(code).toBe(0)
  })

  it("blocks while DKIM is still PENDING, and warns about the 72h deadline", () => {
    const { code, stdout } = run({
      FAKE_ACCOUNT_JSON: PRODUCTION,
      DOMAIN: "chez-mario.fr",
      FAKE_IDENTITY_JSON: JSON.stringify({
        DkimAttributes: { Status: "PENDING" },
        VerifiedForSendingStatus: false,
      }),
    })
    expect(stdout).toContain("PENDING")
    expect(stdout).toContain("72h")
    expect(code).toBe(1)
  })

  it("blocks when the domain was never provisioned in SES", () => {
    const { code, stdout } = run({ FAKE_ACCOUNT_JSON: PRODUCTION, DOMAIN: "inconnu.fr" })
    expect(stdout).toContain("not found in SES")
    expect(stdout).toContain("setup-aws.sh")
    expect(code).toBe(1)
  })
})
