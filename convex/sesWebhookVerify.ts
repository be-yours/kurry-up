"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";

/**
 * Verify the RSA signature Amazon SNS puts on every message.
 *
 * `/webhooks/ses` used to authenticate nothing: it checked that the body's own
 * `SigningCertURL` field looked like an Amazon host and treated that as proof.
 * An unauthenticated POST could therefore forge a bounce or a complaint for any
 * address — the handler reads the subscriber, store and campaign ids straight
 * out of the same unsigned body — suppressing mail to a real customer and
 * moving the campaign counters with it.
 *
 * Node, not the V8 runtime, for the same reason as `stripeWebhookVerify.ts`:
 * `crypto.createVerify` takes a PEM certificate directly, where Web Crypto
 * would need the SubjectPublicKeyInfo picked out of the X.509 DER by hand.
 */
export const verify = internalAction({
  args: {
    /** The raw JSON body, exactly as received. */
    body: v.string(),
  },
  handler: async (
    _ctx,
    args
  ): Promise<{
    valid: boolean;
    reason?: string;
    /** The topic the message came from, once the signature has proved it. */
    topicArn?: string;
    /** Whether this deployment may confirm a subscription for that topic. */
    mayConfirm?: boolean;
  }> => {
    const {
      buildSnsStringToSign,
      canVerify,
      hashAlgorithmFor,
      isAllowedTopic,
      isValidSigningCertUrl,
      mayConfirmSubscription,
      topicPolicy,
    } = await import("@be-yours/convex-functions/snsSignature");

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(args.body);
    } catch {
      return { valid: false, reason: "unparseable" };
    }

    if (!canVerify(message)) {
      return { valid: false, reason: "incomplete" };
    }

    const certUrl = String(message.SigningCertURL);
    // Checked again here rather than trusted from `canVerify`: this is the line
    // that decides which host we make a request to, and it should be readable
    // as such at the point of the fetch.
    if (!isValidSigningCertUrl(certUrl)) {
      return { valid: false, reason: "cert_host" };
    }

    let certPem: string;
    try {
      const response = await fetch(certUrl);
      if (!response.ok) return { valid: false, reason: "cert_unreachable" };
      certPem = await response.text();
    } catch {
      return { valid: false, reason: "cert_unreachable" };
    }

    // `hashAlgorithmFor` refuses SignatureVersion 1 (SHA-1), so this is also
    // the version gate. Reported separately: a topic still on version 1 is a
    // one-line setup fix, and "incomplete" would send an operator looking for
    // a missing field.
    const algorithm = hashAlgorithmFor(String(message.SignatureVersion));
    if (!algorithm) return { valid: false, reason: "signature_version" };
    const stringToSign = buildSnsStringToSign(message);
    if (stringToSign === null) {
      return { valid: false, reason: "incomplete" };
    }

    const crypto = await import("node:crypto");
    let signatureOk: boolean;
    try {
      // One algorithm, because `hashAlgorithmFor` now answers with one:
      // SignatureVersion 1 is SHA-1 and is refused above.
      const verifier = crypto.createVerify("RSA-SHA256");
      verifier.update(stringToSign, "utf8");
      signatureOk = verifier.verify(
        certPem,
        String(message.Signature),
        "base64"
      );
    } catch {
      // A malformed certificate or signature is a rejection, never a pass.
      return { valid: false, reason: "bad_signature" };
    }
    if (!signatureOk) return { valid: false, reason: "bad_signature" };

    // The signature proves AMAZON sent this. It does not prove OUR topic did:
    // every SNS topic in every AWS account is signed by the same
    // infrastructure, with a certificate on the same hosts the URL check
    // allows. So the topic is checked too, after the signature has made the
    // `TopicArn` field trustworthy — before it, it is just another string the
    // sender wrote.
    //
    // AN UNCONFIGURED DEPLOYMENT REFUSES. It used to accept, on the grounds
    // that SNS delivers only to a confirmed subscription and this endpoint
    // refuses to create one — but nothing here requires a subscription at all.
    // This is an HTTPS URL that takes a POST from anyone, so an attacker
    // publishes on their own topic, keeps the signed JSON Amazon hands them,
    // and replays it here. The two refusals are logged apart because they need
    // different fixes: `topic_not_configured` means set `SES_SNS_TOPIC_ARN`,
    // `topic_not_allowed` means this is not one of the topics it names.
    const { allowed, allowAnyTopic, reason } = topicPolicy(process.env);
    const topicArn =
      typeof message.TopicArn === "string" ? message.TopicArn : undefined;
    if (!isAllowedTopic(topicArn, allowed, allowAnyTopic)) {
      console.error(
        `[SES] refusing an SNS message: ${reason} —`,
        topicArn ?? "(no TopicArn)",
        "— set SES_SNS_TOPIC_ARN on this deployment to this value."
      );
      return { valid: false, reason };
    }

    return {
      valid: true,
      ...(topicArn ? { topicArn } : {}),
      // Confirming a subscription is what turns "a stranger pointed their
      // topic at us" into "a stranger can publish to us", so it is decided
      // here, against the configuration, and never from the body alone.
      mayConfirm: mayConfirmSubscription(topicArn, allowed),
    };
  },
});
