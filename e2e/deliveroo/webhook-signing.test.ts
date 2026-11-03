// @vitest-environment edge-runtime

/**
 * The Deliveroo webhook signature these suites produce — pinned, and proved
 * against the code that actually verifies it.
 *
 * WHY THIS FILE EXISTS
 *
 * `createSignature()` used to sign the request body alone. The verifier signs
 * `sequence_guid + " " + raw body`, so every webhook these suites ever sent
 * would have come back 401. Nobody found out, because the suites that send
 * webhooks skip whenever `CONVEX_SITE_URL` and a Deliveroo secret are unset —
 * so a signature that could never be accepted looked exactly like a green run,
 * for eleven suites, indefinitely.
 *
 * Two independent anchors, because one of them alone can be wrong quietly:
 *
 *  1. Expected digests computed OUTSIDE this codebase with LibreSSL, so a
 *     mistake in `createSignature()` cannot also produce its own expectation:
 *
 *         printf '%s %s' "$GUID" "$BODY" | openssl dgst -sha256 -hmac "$SECRET"
 *
 *  2. The real verifier and the real route. `verifyWebhookSignature` is
 *     exported from `@be-yours/integrations` and the Convex HTTP action
 *     is mounted here with `convex-test`, so a signature this directory
 *     produces is put in front of the code that will judge it in production.
 *
 * That second anchor is new. This file used to say the verifier "is
 * module-private and cannot be imported" and restate the algorithm by hand —
 * then assert that restatement against `createSignature`. Two copies of the
 * same idea agreeing with each other proves nothing about the third copy that
 * runs in production; the claim was also simply false, and the restatement is
 * gone.
 *
 * It still needs no network, no deployment, no secrets and no Convex
 * credentials, so it runs in ordinary CI on every push. That is the point: the
 * live suites cannot be relied on to notice.
 */

import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { deliveroo } from "@be-yours/integrations";
import {
  configureDeliverooEnv,
  newHarness,
  postRaw,
  readOrders,
  seedStoreWithDeliveroo,
  SEQUENCE_GUID as ROUTE_GUID,
  WEBHOOK_SECRET as ROUTE_SECRET,
} from "./convex-harness";
import {
  SIGNATURE_SEPARATOR,
  createNewOrderWebhook,
  createSignature,
  generateOrderId,
} from "./test-config";

const { verifyWebhookSignature } = deliveroo;

beforeAll(() => configureDeliverooEnv());

// ============================================================================
// Fixture
//
// Fixed on purpose. Every expected digest below is tied to these three exact
// strings — change one and the constants stop meaning anything.
// ============================================================================

const SECRET = "whsec_deliveroo_test_secret";
const SEQUENCE_GUID = "4f1c1b7e-6a2b-4f4e-9a3a-2f6f0f9a1b2c";
const BODY = '{"event":"order.new","body":{"order":{"id":"fr:1234","status":"placed"}}}';
const BODY_BYTES = Buffer.from(BODY, "utf8");

/**
 * HMAC-SHA256(SECRET, `${SEQUENCE_GUID} ${BODY}`), hex.
 *
 * Computed with LibreSSL's `openssl dgst`, not with this repository's code, so
 * a mistake in `createSignature()` cannot also produce the expectation.
 */
const EXPECTED_SIGNATURE =
  "e02008372a70c2e636d8100488110fd93ddfe8984ad98cd4eebf2698d6487997";

/** The defect: HMAC over the body alone, with no GUID and no separator. */
const BODY_ONLY_SIGNATURE =
  "0fbeb244e6b8ecd5e6adeeee93f9117be1ce1b4d9d2e28daa51f49b3eda1794a";

/** The legacy POS separator `" \n "`, wrong for every event these suites send. */
const LEGACY_POS_SIGNATURE =
  "bb8dd054d28399596e1f37695f2ddd89813379085c424f12fcccb2bfe488248b";

// ============================================================================
// The digest itself
// ============================================================================

describe("the signature these suites produce", () => {
  it("matches the digest computed independently with openssl", () => {
    expect(createSignature(SEQUENCE_GUID, BODY_BYTES, SECRET)).toBe(
      EXPECTED_SIGNATURE,
    );
  });

  it("is not the body-only digest that shipped for months", () => {
    const signature = createSignature(SEQUENCE_GUID, BODY_BYTES, SECRET);

    // Stated as its own assertion rather than folded into the one above: this
    // is the regression, by name, so a future run says which one came back.
    expect(signature).not.toBe(BODY_ONLY_SIGNATURE);
    expect(crypto.createHmac("sha256", SECRET).update(BODY_BYTES).digest("hex")).toBe(
      BODY_ONLY_SIGNATURE,
    );
  });

  it("signs bytes, so a re-serialized body does not silently change the digest", () => {
    // `sendWebhook()` serializes once and sends the same bytes it signed. If it
    // ever went back to signing a string and sending a fresh JSON.stringify,
    // a body whose re-serialization differs would break in production only.
    const withSpaces = Buffer.from(
      JSON.stringify(JSON.parse(BODY), null, 2),
      "utf8",
    );

    expect(createSignature(SEQUENCE_GUID, withSpaces, SECRET)).not.toBe(
      EXPECTED_SIGNATURE,
    );
  });
});

// ============================================================================
// The real verifier — packages/integrations/src/deliveroo/security.ts
// ============================================================================

describe("verifyWebhookSignature, the function the platform verifies with", () => {
  it("accepts what createSignature produced", async () => {
    await expect(
      verifyWebhookSignature(
        BODY_BYTES,
        createSignature(SEQUENCE_GUID, BODY_BYTES, SECRET),
        SEQUENCE_GUID,
        SECRET,
      ),
    ).resolves.toBe(true);
  });

  it("refuses the old, body-only signature", async () => {
    // The failing case, kept explicit: this is what the suites sent before the
    // fix, and it must stay a rejection.
    await expect(
      verifyWebhookSignature(BODY_BYTES, BODY_ONLY_SIGNATURE, SEQUENCE_GUID, SECRET),
    ).resolves.toBe(false);
  });

  it("refuses the legacy POS separator", async () => {
    // `" \n "` is what the old `new_order` / `cancel_order` POS webhook signs
    // with. Nothing here subscribes to it, and a verifier that accepted both
    // separators would accept a message it should have refused.
    expect(SIGNATURE_SEPARATOR).toBe(" ");
    await expect(
      verifyWebhookSignature(BODY_BYTES, LEGACY_POS_SIGNATURE, SEQUENCE_GUID, SECRET),
    ).resolves.toBe(false);
  });

  it("binds the signature to the GUID, so a replay under another GUID fails", async () => {
    await expect(
      verifyWebhookSignature(
        BODY_BYTES,
        createSignature(SEQUENCE_GUID, BODY_BYTES, SECRET),
        "00000000-0000-4000-8000-000000000000",
        SECRET,
      ),
    ).resolves.toBe(false);
  });

  it("binds the signature to the body, so a tampered body fails", async () => {
    const tampered = Buffer.from(BODY.replace("fr:1234", "fr:9999"), "utf8");

    await expect(
      verifyWebhookSignature(
        tampered,
        createSignature(SEQUENCE_GUID, BODY_BYTES, SECRET),
        SEQUENCE_GUID,
        SECRET,
      ),
    ).resolves.toBe(false);
  });
});

// ============================================================================
// The real route — convex/deliverooWebhookHandler.ts, through convex/http.ts
// ============================================================================

describe("the signed request at the Convex endpoint", () => {
  /** A real order payload, so a 200 means it was accepted AND processed. */
  function payload(): { body: string; orderId: string } {
    const orderId = generateOrderId("signed");
    return { body: JSON.stringify(createNewOrderWebhook({ id: orderId })), orderId };
  }

  it("is accepted when signed the way these suites sign", async () => {
    const t = newHarness();
    await seedStoreWithDeliveroo(t);
    const { body } = payload();

    const response = await postRaw(t, body, {
      "x-deliveroo-hmac-sha256": createSignature(
        ROUTE_GUID,
        Buffer.from(body, "utf8"),
        ROUTE_SECRET,
      ),
      "x-deliveroo-sequence-guid": ROUTE_GUID,
    });

    expect(response.status).toBe(200);
    expect(await readOrders(t)).toHaveLength(1);
  });

  it("is refused, and writes nothing, when signed over the body alone", async () => {
    // End to end, this is the bug: a well-formed request the verifier cannot
    // accept. It has to be a 401 and it has to happen before any processing.
    const t = newHarness();
    await seedStoreWithDeliveroo(t);
    const { body } = payload();

    const response = await postRaw(t, body, {
      "x-deliveroo-hmac-sha256": crypto
        .createHmac("sha256", ROUTE_SECRET)
        .update(Buffer.from(body, "utf8"))
        .digest("hex"),
      "x-deliveroo-sequence-guid": ROUTE_GUID,
    });

    expect(response.status).toBe(401);
    expect(await readOrders(t)).toHaveLength(0);
  });

  it("is refused when the sequence GUID header is missing", async () => {
    // The GUID is half the signed message. Without the header there is nothing
    // to verify against, and the handler must not fall back to the body alone.
    const t = newHarness();
    await seedStoreWithDeliveroo(t);
    const { body } = payload();

    const response = await postRaw(t, body, {
      "x-deliveroo-hmac-sha256": createSignature(
        ROUTE_GUID,
        Buffer.from(body, "utf8"),
        ROUTE_SECRET,
      ),
    });

    expect(response.status).toBe(401);
    expect(await readOrders(t)).toHaveLength(0);
  });
});
