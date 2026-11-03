// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * What a bounce costs, and who decides.
 *
 * `markBounced` suppressed an address only on its third bounce. For a mailbox
 * SES reports as `Permanent` — the domain resolves, the user does not, and no
 * amount of retrying changes that — the other two sends are pure ratio. AWS
 * suspends a sending identity on a 5% bounce rate, and a list built over two
 * years carries enough dead addresses to reach that on its own once each one
 * counts three times. The suspension takes order confirmations down with the
 * marketing, because they leave through the same identity.
 *
 * The classification was already arriving. `SESNotification` declared
 * `bounce.bounceType` and the `Bounce` arm never read it, so `markBounced` was
 * called with the subscriber id alone — and its validator had no argument to
 * receive the type with even if the arm had passed one.
 *
 * These drive the real `POST /webhooks/ses` with a genuinely signed SNS
 * envelope rather than calling the mutation directly, because "the webhook
 * forwards the bounce type" is a claim about the route. The mutation's own
 * arithmetic is covered in `packages/convex-functions`.
 */

import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000
const CERT_URL =
  "https://sns.eu-west-3.amazonaws.com/SimpleNotificationService-test.pem"

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

/**
 * Cancel whatever the test left on the scheduler — see `unsubscribe-link.test.ts`
 * for why a pending job outliving its transaction fails the run from outside
 * any assertion.
 */
afterEach(() => {
  delete process.env.SES_SNS_TOPIC_ARN
  delete process.env.SES_SNS_ALLOW_ANY_TOPIC
})

afterEach(async () => {
  for (const t of harnesses) {
    // Let whatever is already RUNNING finish first.
    //
    // The loop below cancels `inProgress` jobs as well as pending ones, and
    // cancelling a job mid-run is what `convexTest` raises
    // "Unexpected scheduled function state after it finished running: canceled"
    // over — an unhandled rejection that turns a fully green run red, blaming
    // whichever file happened to be executing rather than the one that queued
    // the work. It stayed hidden while the only scheduled work was the 5s menu
    // sync, which is always still `pending`; the order confirmation goes on at
    // `runAfter(0)` from every payment path, so under parallel load it is
    // routinely mid-flight when this runs.
    //
    // `finishInProgressScheduledFunctions`, not `finishAllScheduledFunctions`:
    // the second one advances the clock and fires the delayed menu syncs, which
    // is the disease the comment above describes. This one only waits for what
    // was already running.
    await t.finishInProgressScheduledFunctions()
    await t.run(async (ctx) => {
      const pending = await ctx.db.system.query("_scheduled_functions").collect()
      for (const job of pending) {
        if (job.state.kind === "pending" || job.state.kind === "inProgress") {
          await ctx.scheduler.cancel(job._id)
        }
      }
    })
  }
  harnesses.length = 0
  vi.unstubAllGlobals()
})

/**
 * One RSA keypair for the file: SNS signs with a private key and publishes the
 * certificate, so a test that wants to pass the real verifier has to do both.
 * Generating 2048 bits per test is the slowest thing here by an order of
 * magnitude, and nothing under test depends on the key changing.
 */
let signMessage: (stringToSign: string) => string
let certPem: string

/**
 * The topic this deployment is configured to accept, shared by every suite.
 *
 * It has to be set. `SES_SNS_TOPIC_ARN` unset now refuses every notification,
 * not just every subscription: the endpoint is an HTTPS URL anyone can POST
 * to, so an attacker publishes on a topic in their own AWS account and replays
 * the JSON Amazon signed for them, and "SNS only delivers to a confirmed
 * subscription" never had anything to do with it. Configuring the variable is
 * what `tasks/webhook-migration-checklist.md` already requires before a
 * subscription is confirmed.
 */
const CONFIGURED_TOPIC = "arn:aws:sns:eu-west-3:000000000000:ses-events"

beforeEach(async () => {
  process.env.SES_SNS_TOPIC_ARN = CONFIGURED_TOPIC
  if (signMessage) return
  const { generateKeyPairSync, createSign } = await import("node:crypto")
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  })
  certPem = publicKey.export({ type: "spki", format: "pem" }) as string
  signMessage = (stringToSign: string) => {
    // SHA-256, because SignatureVersion 1 (SHA-1) is refused: the sender picks
    // the version, and offering both means the weaker one is the one that
    // counts. See `hashAlgorithmFor` in `snsSignature.ts`.
    const signer = createSign("RSA-SHA256")
    signer.update(stringToSign, "utf8")
    return signer.sign(privateKey, "base64")
  }
})

async function seedSubscriber(
  t: ReturnType<typeof convexTest>,
  status: "active" | "complained" = "active"
) {
  const storeId = await t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Luigi",
      slug: `luigi-${status}-${Math.random()}`,
      address: {
        street: "1 rue de la Paix",
        city: "Paris",
        postalCode: "75002",
        country: "France",
      },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )

  const id = await t.run((ctx) =>
    ctx.db.insert("emailSubscribers", {
      storeId,
      email: "yanis@resto.example",
      status,
      source: "storefront_form" as const,
      tags: ["newsletter"],
      consentAt: NOW,
      consentSource: "test",
      bounceCount: 0,
      metadata: {
        totalOrders: 0,
        totalSpent: 0,
        averageOrderValue: 0,
        favoriteProducts: [],
        orderTypes: [],
      },
      createdAt: NOW,
      updatedAt: NOW,
    })
  )

  return { storeId, id }
}

/**
 * A signed SNS envelope carrying one SES bounce notification.
 *
 * The signed bytes are `field\nvalue\n` for the fields SNS signs, in the order
 * it signs them — the same construction `buildSnsStringToSign` performs. Get it
 * wrong and the verifier rejects, which is the safe direction but would make
 * every test here pass for the wrong reason, so the assertions below check the
 * response status too.
 */
function signedBounce(args: {
  storeId: Id<"stores">
  subscriberId: Id<"emailSubscribers">
  bounceType: "Permanent" | "Transient" | "Undetermined"
  messageId?: string
}) {
  const notification = {
    notificationType: "Bounce",
    mail: {
      messageId: args.messageId ?? "ses-1",
      source: "no-reply@beyours.fr",
      destination: ["yanis@resto.example"],
      headers: [
        { name: "X-Store-Id", value: args.storeId },
        { name: "X-Subscriber-Id", value: args.subscriberId },
      ],
    },
    bounce: {
      bounceType: args.bounceType,
      bouncedRecipients: [{ emailAddress: "yanis@resto.example" }],
    },
  }

  return signedNotification(notification, args.messageId ?? "sns-1")
}

/** Wrap and sign any SES notification body, whatever its shape. */
function signedNotification(notification: unknown, messageId: string) {
  const envelope: Record<string, string> = {
    Type: "Notification",
    MessageId: messageId,
    TopicArn: "arn:aws:sns:eu-west-3:000000000000:ses-events",
    Message: JSON.stringify(notification),
    Timestamp: new Date(NOW).toISOString(),
    SignatureVersion: "2",
    SigningCertURL: CERT_URL,
  }

  const signedFields = [
    "Message",
    "MessageId",
    "Subject",
    "Timestamp",
    "TopicArn",
    "Type",
  ]
  let stringToSign = ""
  for (const field of signedFields) {
    if (envelope[field] === undefined) continue
    stringToSign += `${field}\n${envelope[field]}\n`
  }
  envelope.Signature = signMessage(stringToSign)

  return JSON.stringify(envelope)
}

/** The verifier fetches the certificate; hand it the matching public key. */
function stubCertificateFetch() {
  vi.stubGlobal("fetch", async (input: unknown) => {
    if (String(input) === CERT_URL) return new Response(certPem, { status: 200 })
    throw new Error(`unexpected fetch: ${String(input)}`)
  })
}

async function deliverBounce(
  t: ReturnType<typeof convexTest>,
  body: string
): Promise<number> {
  const response = await t.fetch("/webhooks/ses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  })
  return response.status
}

function readSubscriber(
  t: ReturnType<typeof convexTest>,
  id: Id<"emailSubscribers">
) {
  return t.run(async (ctx) => await ctx.db.get(id))
}

describe("POST /webhooks/ses — Bounce", () => {
  test("a permanent bounce suppresses the address on the first event", async () => {
    const t = newHarness()
    const { storeId, id } = await seedSubscriber(t)
    stubCertificateFetch()

    expect(
      await deliverBounce(t, signedBounce({ storeId, subscriberId: id, bounceType: "Permanent" }))
    ).toBe(200)

    const after = await readSubscriber(t, id)
    // Not on the third. `pageForSending` selects on `status === "active"`, so
    // anything short of this flip is two more sends to a mailbox that does not
    // exist.
    expect(after?.status).toBe("bounced")
    expect(after?.bounceCount).toBe(1)
  })

  test("a transient bounce keeps the three-strike counter", async () => {
    const t = newHarness()
    const { storeId, id } = await seedSubscriber(t)
    stubCertificateFetch()

    // A full mailbox or a greylisting recovers. Suppressing on the first one
    // would quietly delete real customers from the list.
    for (const attempt of [1, 2]) {
      expect(
        await deliverBounce(
          t,
          signedBounce({
            storeId,
            subscriberId: id,
            bounceType: "Transient",
            messageId: `t-${attempt}`,
          })
        )
      ).toBe(200)
      const between = await readSubscriber(t, id)
      expect(between?.status).toBe("active")
      expect(between?.bounceCount).toBe(attempt)
    }

    await deliverBounce(
      t,
      signedBounce({ storeId, subscriberId: id, bounceType: "Transient", messageId: "t-3" })
    )

    const after = await readSubscriber(t, id)
    expect(after?.status).toBe("bounced")
    expect(after?.bounceCount).toBe(3)
  })

  test("an undetermined bounce is treated as transient", async () => {
    const t = newHarness()
    const { storeId, id } = await seedSubscriber(t)
    stubCertificateFetch()

    await deliverBounce(
      t,
      signedBounce({ storeId, subscriberId: id, bounceType: "Undetermined" })
    )

    // SES could not classify it. An address we cannot prove dead keeps its
    // place on the list.
    const after = await readSubscriber(t, id)
    expect(after?.status).toBe("active")
    expect(after?.bounceCount).toBe(1)
  })

  test("a bounce does not overwrite a spam complaint", async () => {
    const t = newHarness()
    const { storeId, id } = await seedSubscriber(t, "complained")
    stubCertificateFetch()

    await deliverBounce(
      t,
      signedBounce({ storeId, subscriberId: id, bounceType: "Permanent" })
    )

    // Both statuses suppress, but only one of them is the answer to "why did
    // you stop mailing this person" that a regulator asks for.
    const after = await readSubscriber(t, id)
    expect(after?.status).toBe("complained")
    expect(after?.bounceCount).toBe(1)
  })

  test("a classification SES has not used before still counts", async () => {
    const t = newHarness()
    const { storeId, id } = await seedSubscriber(t)
    stubCertificateFetch()

    const body = JSON.parse(
      signedBounce({ storeId, subscriberId: id, bounceType: "Permanent" })
    )
    // Rewrite the classification inside the signed payload, then re-sign, so
    // this is a well-formed message carrying a value the validator's closed
    // union does not know.
    const notification = JSON.parse(body.Message)
    notification.bounce.bounceType = "SomethingAwsAddedLater"
    const resigned = signedBounce({
      storeId,
      subscriberId: id,
      bounceType: notification.bounce.bounceType as "Permanent",
      messageId: "unknown-1",
    })

    expect(await deliverBounce(t, resigned)).toBe(200)

    // The whole dispatch runs inside a catch that only logs, so a validator
    // error here would silently drop the bounce — worse than the behaviour
    // this replaced. It must count instead, and not suppress.
    const after = await readSubscriber(t, id)
    expect(after?.bounceCount).toBe(1)
    expect(after?.status).toBe("active")
  })

  test("a Bounce carrying no bounce object at all still counts", async () => {
    const t = newHarness()
    const { storeId, id } = await seedSubscriber(t)
    stubCertificateFetch()

    const envelope = JSON.parse(
      signedBounce({ storeId, subscriberId: id, bounceType: "Permanent" })
    )
    const notification = JSON.parse(envelope.Message)
    delete notification.bounce
    const rebuilt = signedNotification(notification, "no-bounce-1")

    expect(await deliverBounce(t, rebuilt)).toBe(200)
    const after = await readSubscriber(t, id)
    expect(after?.bounceCount).toBe(1)
    expect(after?.status).toBe("active")
  })

  test("an unsigned bounce changes nothing", async () => {
    const t = newHarness()
    const { storeId, id } = await seedSubscriber(t)
    stubCertificateFetch()

    const forged = JSON.parse(
      signedBounce({ storeId, subscriberId: id, bounceType: "Permanent" })
    )
    forged.Signature = Buffer.from("not-a-signature").toString("base64")

    // Suppression is now a one-event decision, which makes forging one cheaper
    // than it was: a single unauthenticated POST would silence a competitor's
    // best customer.
    expect(await deliverBounce(t, JSON.stringify(forged))).toBe(403)
    const after = await readSubscriber(t, id)
    expect(after?.status).toBe("active")
    expect(after?.bounceCount).toBe(0)
  })
})

/**
 * The bounce that carries no correlation headers at all.
 *
 * `handleSesWebhook` reads `X-Store-Id` and `X-Subscriber-Id` out of
 * `mail.headers`, and SES omits `mail.headers` from a notification unless the
 * sending identity is configured to include the original headers. Nothing
 * configured that: `setup-aws.sh` created the configuration set with no
 * destination, no SNS topic and no identity notification of any kind, so
 * `POST /webhooks/ses` was routed and never called. Wired by hand it still
 * dropped everything — the handler's whole body sat behind
 * `if (!storeId || !subscriberId) return 200`, which reads a headerless bounce
 * as "sent outside the campaign system".
 *
 * A 200 is the worst available answer there: it tells SNS the delivery
 * succeeded, so nothing retries and nothing is queued for inspection. The dead
 * address stays `active` and is re-mailed on every campaign, and AWS suspends
 * the account at a 5 % complaint rate with nothing in the product able to say
 * why.
 *
 * `setup-aws.sh` Step 2b now sets the headers flag, so the precise path is the
 * one a new deployment takes. These hold the other one — every client
 * provisioned before it.
 */
describe("POST /webhooks/ses — no correlation headers", () => {
  /** The same envelope as `signedBounce`, with `mail.headers` left out. */
  function headerlessNotification(args: {
    type: "Bounce" | "Complaint" | "Delivery"
    bounceType?: "Permanent" | "Transient" | "Undetermined"
    email?: string
    messageId?: string
  }) {
    const email = args.email ?? "yanis@resto.example"
    const notification: Record<string, unknown> = {
      notificationType: args.type,
      mail: {
        messageId: args.messageId ?? "ses-headerless",
        source: "no-reply@beyours.fr",
        destination: [email],
      },
    }
    if (args.type === "Bounce") {
      notification.bounce = {
        bounceType: args.bounceType ?? "Permanent",
        bouncedRecipients: [{ emailAddress: email }],
      }
    }
    if (args.type === "Complaint") {
      notification.complaint = { complainedRecipients: [{ emailAddress: email }] }
    }
    return signedNotification(notification, args.messageId ?? "sns-headerless")
  }

  /** Every report `captureBackendError` has queued, by source. */
  function queuedReports(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) => {
      const jobs = await ctx.db.system.query("_scheduled_functions").collect()
      return jobs
        .filter((job) => job.name.includes("reportError"))
        .map((job) => job.args[0] as { source?: string; message?: string })
    })
  }

  test("a permanent bounce suppresses the address it names", async () => {
    const t = newHarness()
    stubCertificateFetch()
    const { id } = await seedSubscriber(t)

    expect(await deliverBounce(t, headerlessNotification({ type: "Bounce" }))).toBe(200)

    // The whole defect: this used to still read `active`, for ever.
    expect((await readSubscriber(t, id))?.status).toBe("bounced")
  })

  test("a complaint suppresses the address it names", async () => {
    const t = newHarness()
    stubCertificateFetch()
    const { id } = await seedSubscriber(t)

    expect(await deliverBounce(t, headerlessNotification({ type: "Complaint" }))).toBe(200)

    expect((await readSubscriber(t, id))?.status).toBe("complained")
  })

  test("it suppresses the address in every store that holds it", async () => {
    // Deliberate, and the conservative direction rather than the convenient
    // one. A hard bounce is a fact about the MAILBOX and is equally true of
    // every store carrying it, and the complaint rate AWS suspends over is
    // per-account — one AWS account per client, every store of theirs inside
    // it. Leaving the second row `active` keeps mailing an address already
    // known to be dead, on the same account.
    const t = newHarness()
    stubCertificateFetch()
    const first = await seedSubscriber(t)
    const second = await seedSubscriber(t)
    expect(first.storeId).not.toBe(second.storeId)

    await deliverBounce(t, headerlessNotification({ type: "Bounce" }))

    expect((await readSubscriber(t, first.id))?.status).toBe("bounced")
    expect((await readSubscriber(t, second.id))?.status).toBe("bounced")
  })

  test("the address is matched case-insensitively, as SES reports it", async () => {
    const t = newHarness()
    stubCertificateFetch()
    const { id } = await seedSubscriber(t)

    await deliverBounce(
      t,
      headerlessNotification({ type: "Bounce", email: "Yanis@Resto.Example" })
    )

    expect((await readSubscriber(t, id))?.status).toBe("bounced")
  })

  test("a delivery does NOT fall back — that would corrupt a campaign figure", async () => {
    // Suppression is a fact about the address; a delivery, an open and a click
    // are campaign statistics, and attributing one to a store that did not send
    // the message makes the number wrong rather than complete.
    const t = newHarness()
    stubCertificateFetch()
    const { id } = await seedSubscriber(t)

    expect(await deliverBounce(t, headerlessNotification({ type: "Delivery" }))).toBe(200)

    expect((await readSubscriber(t, id))?.status).toBe("active")
    const events = await t.run((ctx) => ctx.db.query("emailEvents").collect())
    expect(events).toHaveLength(0)
  })

  test("a bounce matching no subscriber is reported, not silently dropped", async () => {
    // The configuration fault has to be visible somewhere. Answering 200 and
    // recording nothing is exactly how this stayed invisible until an account
    // was suspended.
    const t = newHarness()
    stubCertificateFetch()
    await seedSubscriber(t)

    expect(
      await deliverBounce(
        t,
        headerlessNotification({ type: "Bounce", email: "nobody@resto.example" })
      )
    ).toBe(200)

    const reports = await queuedReports(t)
    expect(reports).toHaveLength(1)
    expect(reports[0]?.source).toBe("emailHttpHandlers.handleSesWebhook")
    // Named, so whoever reads the report knows which half to go and fix.
    expect(reports[0]?.message).toContain("no original headers")
  })

  test("a delivery matching nobody is not reported — it is ordinary", async () => {
    const t = newHarness()
    stubCertificateFetch()

    await deliverBounce(
      t,
      headerlessNotification({ type: "Delivery", email: "nobody@resto.example" })
    )

    expect(await queuedReports(t)).toHaveLength(0)
  })

  test("headers still win when SES sends them", async () => {
    // The precise path stays precise: a bounce carrying `X-Subscriber-Id`
    // marks that subscriber and no other, whatever else holds the address.
    const t = newHarness()
    stubCertificateFetch()
    const first = await seedSubscriber(t)
    const second = await seedSubscriber(t)

    await deliverBounce(
      t,
      signedBounce({
        storeId: first.storeId,
        subscriberId: first.id,
        bounceType: "Permanent",
      })
    )

    expect((await readSubscriber(t, first.id))?.status).toBe("bounced")
    expect((await readSubscriber(t, second.id))?.status).toBe("active")
  })
})

/**
 * A valid Amazon signature says AMAZON sent it, not that OUR topic did.
 *
 * Every SNS topic in every AWS account is signed by the same infrastructure,
 * with a certificate on the same `sns.<region>.amazonaws.com` hosts the URL
 * check allows. And the endpoint used to CONFIRM any subscription whose
 * `SubscribeURL` was on such a host — so a stranger pointed their own topic at
 * `/webhooks/ses`, the endpoint subscribed itself, and from then on their
 * forged bounces carried a genuine signature and suppressed real customers'
 * addresses.
 */
describe("which SNS topic the webhook accepts", () => {
  /** A signed `SubscriptionConfirmation`, as SNS sends it. */
  function signedConfirmation(topicArn: string) {
    const envelope: Record<string, string> = {
      Type: "SubscriptionConfirmation",
      MessageId: "sns-confirm-1",
      Token: "confirm-token",
      TopicArn: topicArn,
      Message: "You have chosen to subscribe to the topic.",
      SubscribeURL: `https://sns.eu-west-3.amazonaws.com/?Action=ConfirmSubscription&Token=confirm-token`,
      Timestamp: new Date(NOW).toISOString(),
      SignatureVersion: "2",
      SigningCertURL: CERT_URL,
    }
    let stringToSign = ""
    for (const field of [
      "Message",
      "MessageId",
      "SubscribeURL",
      "Timestamp",
      "Token",
      "TopicArn",
      "Type",
    ]) {
      if (envelope[field] === undefined) continue
      stringToSign += `${field}\n${envelope[field]}\n`
    }
    envelope.Signature = signMessage(stringToSign)
    return JSON.stringify(envelope)
  }

  const OUR_TOPIC = CONFIGURED_TOPIC
  const THEIR_TOPIC = "arn:aws:sns:eu-west-3:999999999999:ses-events"

  test("a signed bounce from another account's topic is refused", async () => {
    process.env.SES_SNS_TOPIC_ARN = OUR_TOPIC
    const t = newHarness()
    const { id } = await seedSubscriber(t)
    stubCertificateFetch()

    const body = signedNotification(
      {
        notificationType: "Bounce",
        bounce: {
          bounceType: "Permanent",
          bouncedRecipients: [{ emailAddress: "yanis@resto.example" }],
        },
        mail: { headers: [] },
      },
      "sns-foreign"
    ).replace(
      `"TopicArn":"${OUR_TOPIC}"`,
      `"TopicArn":"${THEIR_TOPIC}"`
    )

    // The body is re-signed by nobody: rewriting the ARN also breaks the
    // signature, which is the point — an attacker with their OWN topic gets a
    // real signature over their own ARN, and that is the case the allow-list
    // exists for. Either way the webhook must refuse.
    expect(await deliverBounce(t, body)).toBe(403)
    expect((await readSubscriber(t, id))?.status).toBe("active")
  })

  test("a subscription from an unconfigured topic is not confirmed", async () => {
    // No `SES_SNS_TOPIC_ARN`: the endpoint must not fetch the `SubscribeURL`.
    // That fetch is what turned "a stranger pointed their topic at us" into "a
    // stranger can publish to us".
    delete process.env.SES_SNS_TOPIC_ARN
    const t = newHarness()
    const fetched: string[] = []
    vi.stubGlobal("fetch", async (input: unknown) => {
      const url = String(input)
      if (url === CERT_URL) return new Response(certPem, { status: 200 })
      fetched.push(url)
      return new Response("OK", { status: 200 })
    })

    const status = await deliverBounce(t, signedConfirmation(THEIR_TOPIC))

    // Answered 200 — SNS retries a non-2xx, and there is nothing to retry.
    expect(status).toBe(200)
    expect(fetched).toEqual([])
  })

  test("an UNCONFIGURED deployment refuses a signed bounce from any topic", async () => {
    /*
      The hole the allow-list left, end to end.

      `isAllowedTopic` answered `true` on an empty list, and the argument was
      that SNS delivers only to a confirmed subscription while this endpoint
      refuses to create one — so the fail-open could not be reached. Nothing
      here requires a subscription. `/webhooks/ses` is an HTTPS URL that takes
      a POST from anyone: an attacker publishes on a topic in their OWN AWS
      account, to a subscription pointing at their own server, keeps the signed
      envelope Amazon hands them, and replays it here. The signature is
      genuine, the certificate is on an allowed host, the topic check waved it
      through — and the handler marked whichever subscriber the body named
      bounced, suppressing mail to a real customer.

      The body below is signed by this suite's own key, which is exactly the
      position that attacker is in with respect to their own topic: correctly
      signed, and not ours.
    */
    delete process.env.SES_SNS_TOPIC_ARN
    const t = newHarness()
    const { id } = await seedSubscriber(t)
    stubCertificateFetch()

    const body = signedNotification(
      {
        notificationType: "Bounce",
        bounce: {
          bounceType: "Permanent",
          bouncedRecipients: [{ emailAddress: "yanis@resto.example" }],
        },
        mail: { headers: [] },
      },
      "sns-unconfigured"
    )

    expect(await deliverBounce(t, body)).toBe(403)
    expect((await readSubscriber(t, id))?.status).toBe("active")
  })

  test("and accepts it again only when an operator says so in as many words", async () => {
    // The escape hatch, for a deployment mid-configuration with a
    // subscription an operator already confirmed. It restores the old
    // behaviour for NOTIFICATIONS and nothing else.
    delete process.env.SES_SNS_TOPIC_ARN
    process.env.SES_SNS_ALLOW_ANY_TOPIC = "true"
    const t = newHarness()
    const { id } = await seedSubscriber(t)
    stubCertificateFetch()

    const body = signedNotification(
      {
        notificationType: "Bounce",
        bounce: {
          bounceType: "Permanent",
          bouncedRecipients: [{ emailAddress: "yanis@resto.example" }],
        },
        mail: { headers: [] },
      },
      "sns-hatch"
    )

    expect(await deliverBounce(t, body)).toBe(200)
    expect((await readSubscriber(t, id))?.status).toBe("bounced")
  })

  test("the hatch still confirms no subscription — that half never re-opens", async () => {
    // Confirming a subscription is what turns "a stranger pointed their topic
    // at us" into "a stranger can publish to us". No environment variable may
    // put that back.
    delete process.env.SES_SNS_TOPIC_ARN
    process.env.SES_SNS_ALLOW_ANY_TOPIC = "true"
    const t = newHarness()
    const fetched: string[] = []
    vi.stubGlobal("fetch", async (input: unknown) => {
      const url = String(input)
      if (url === CERT_URL) return new Response(certPem, { status: 200 })
      fetched.push(url)
      return new Response("OK", { status: 200 })
    })

    expect(await deliverBounce(t, signedConfirmation(THEIR_TOPIC))).toBe(200)
    expect(fetched).toEqual([])
  })

  test("a subscription from the configured topic is confirmed", async () => {
    process.env.SES_SNS_TOPIC_ARN = OUR_TOPIC
    const t = newHarness()
    const fetched: string[] = []
    vi.stubGlobal("fetch", async (input: unknown) => {
      const url = String(input)
      if (url === CERT_URL) return new Response(certPem, { status: 200 })
      fetched.push(url)
      return new Response("OK", { status: 200 })
    })

    expect(await deliverBounce(t, signedConfirmation(OUR_TOPIC))).toBe(200)
    expect(fetched).toHaveLength(1)
    expect(fetched[0]).toContain("ConfirmSubscription")
  })
})
