import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * `setup-aws.sh` must hand the deployment the topic before it asks SNS to
 * subscribe to it.
 *
 * The provisioning half of #428 was correct and the chain still ended in
 * silence, one step further down. `sesWebhookVerify` refuses to confirm a
 * subscription whose topic is not named in `SES_SNS_TOPIC_ARN` — deliberately,
 * because confirming is what turns "a stranger pointed their topic at us" into
 * "a stranger can publish to us". Nothing set that variable: not this script,
 * not `env:sync`, not `setup-convex-env.sh`.
 *
 * So a client provisioned exactly as instructed got `aws sns subscribe`, a
 * SubscriptionConfirmation the deployment refused, a subscription left
 * PendingConfirmation, and SNS eventually giving up — while the script printed
 * "the deployment confirms it on the first POST". `CLAUDE.md` documented the
 * variable correctly the whole time, and the operator follows the script.
 *
 * ORDER IS THE ASSERTION, which is why this reads the source rather than
 * running it: the failure was not that a step was missing from the script's
 * output, it was that two steps happened in the wrong order. A test that only
 * checked both mentions existed would have passed on the broken version.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = fs.readFileSync(path.join(HERE, "setup-aws.sh"), "utf8")

/** Where a pattern first appears, as a line number, or -1. */
function lineOf(pattern) {
  const lines = SCRIPT.split("\n")
  return lines.findIndex((line) => pattern.test(line))
}

describe("setup-aws.sh, step 2b", () => {
  it("sets SES_SNS_TOPIC_ARN at all", () => {
    // `grep -n "SES_SNS_TOPIC_ARN" apps/themes/scripts/setup-aws.sh` answered
    // NOT PRESENT, which is the whole defect in one command.
    expect(SCRIPT).toMatch(/SES_SNS_TOPIC_ARN/)
  })

  it("writes the ARN into the Convex env file", () => {
    // The Convex file, not `.env.local`: the verifier runs in the Convex
    // deployment and reads it from there.
    expect(SCRIPT).toMatch(/SES_SNS_TOPIC_ARN=%s/)
    expect(SCRIPT).toMatch(/CONVEX_ENV_FILE/)
  })

  it("does so BEFORE requesting the subscription", () => {
    const writesArn = lineOf(/SES_SNS_TOPIC_ARN written to|SES_SNS_TOPIC_ARN updated in/)
    const subscribes = lineOf(/^\s*aws sns subscribe/)

    expect(writesArn).toBeGreaterThan(-1)
    expect(subscribes).toBeGreaterThan(-1)
    // If this ever inverts, the first SubscriptionConfirmation is refused and
    // the subscription is stranded exactly as before.
    expect(writesArn).toBeLessThan(subscribes)
  })

  it("does not promise a confirmation it cannot know will happen", () => {
    // The old line was unconditional: "Subscription requested (the deployment
    // confirms it on the first POST)". It was false in precisely the case an
    // operator needed warning about.
    expect(SCRIPT).not.toMatch(/Subscription requested \(the deployment confirms it/)
  })

  it("tells the operator the command that fixes it when the push fails", () => {
    expect(SCRIPT).toMatch(/convex env set SES_SNS_TOPIC_ARN/)
  })
})

describe("the Convex env example", () => {
  it("documents SES_SNS_TOPIC_ARN, so a manual setup does not have to guess", () => {
    const example = fs.readFileSync(path.join(HERE, "..", ".env.convex.example"), "utf8")
    expect(example).toMatch(/^SES_SNS_TOPIC_ARN=/m)
  })
})
