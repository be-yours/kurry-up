"use node"

import { action } from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3"
import { mediaKeyFromUrl } from "@be-yours/core/aws/media-url"

/**
 * OpenAI fetches an `image_url` from its own servers, so a URL that only this
 * deployment can read is no use to it. For anything in our bucket — proxy
 * path, CDN, or a pre-private-bucket S3 row — read the bytes here and inline
 * them. Anything else (an Unsplash pick, an operator-pasted link) is already
 * reachable and goes through untouched.
 */
async function inlineOwnMedia(imageUrl: string): Promise<string> {
  const bucketName = process.env.AWS_S3_BUCKET_NAME
  const key = mediaKeyFromUrl(imageUrl, {
    publicBaseUrl: process.env.AWS_S3_PUBLIC_BASE_URL,
    bucketName,
  })
  if (!key) return imageUrl
  if (!bucketName) throw new Error("AWS_S3_BUCKET_NAME not configured")

  const client = new S3Client({
    region: process.env.AWS_REGION ?? "eu-west-3",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  })

  const object = await client.send(
    new GetObjectCommand({ Bucket: bucketName, Key: key }),
  )
  const bytes = await object.Body!.transformToByteArray()
  const contentType = object.ContentType ?? "image/jpeg"

  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`
}

// @guarded-inline: checks content:write by role — no store to scope against
export const generateAltText = action({
  args: {
    imageUrl: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new Error("Not authenticated")

    // Deployment-wide operation with no store to scope against. "Logged in"
    // included every customer account, so the check is by role.
    await ctx.runQuery(internal.authHelpers.checkPermission, {
      permission: "content:write",
    });

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error("OPENAI_API_KEY not configured")

    const image = await inlineOwnMedia(args.imageUrl)

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0.3,
        max_tokens: 100,
        messages: [
          {
            role: "system",
            content:
              "Describe this image concisely for use as alt text (accessibility). " +
              "Max 125 characters. Return only the description in the same language as any visible text, " +
              "or in French if no text is visible. No quotes, no formatting.",
          },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: image, detail: "low" },
              },
            ],
          },
        ],
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      throw new Error(`OpenAI API error (${response.status}): ${err}`)
    }

    const data = await response.json()
    const altText = data.choices?.[0]?.message?.content?.trim() ?? ""

    return { altText }
  },
})
