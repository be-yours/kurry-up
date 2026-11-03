import { v } from "convex/values";
import {
  documentsForOrder,
  invoiceById,
  invoicesForStore,
  issueInvoiceForOrder,
} from "@be-yours/convex-functions/invoices";
import {
  renderInvoiceHtml,
  type InvoiceDocument,
} from "@be-yours/convex-functions/invoiceHtml";
import { storeMutation, storeQuery } from "./lib/storeFunctions";

/**
 * Invoices — *factures* — and the credit notes that reverse them.
 *
 * Issuing happens on the payment seam in the defs layer, not here; these are
 * the ways a document is read back, plus one way to issue an invoice by hand
 * for an order that has none.
 */

/**
 * Issue the invoice for a paid order that has none.
 *
 * Every order paid from now on is invoiced on the payment seam. This exists for
 * the two cases that seam cannot reach: orders paid before invoicing shipped,
 * and orders that settled while `globalSettings.seller` was still incomplete —
 * which is every establishment until its owner fills the block in.
 *
 * Idempotent, and it refuses for the same reasons the automatic path does; the
 * result names the reason so the screen can say why rather than fail silently.
 */
export const issueForOrder = storeMutation({
  permission: "payments:write",
  args: { orderId: v.id("orders") },
  // `storeIdFromDocument` reads `args.id`; this one is keyed on `orderId`.
  storeIdFrom: async (ctx, args) => {
    const order = await ctx.db.get(args.orderId);
    if (!order) throw new Error("Order not found");
    return order.storeId;
  },
  handler: (ctx, args) => issueInvoiceForOrder(ctx, args.orderId),
});


/**
 * The documents issued for one order.
 *
 * `documentsForOrder` has existed in the engine since invoicing shipped, with
 * its docblock saying "the answer differs between the storefront and the
 * admin" — and **zero production callers** (#622). This is the admin half.
 *
 * `payments:read`, not `payments:write`: reading a receipt is not issuing one,
 * and a manager who can see the turnover can see what was invoiced.
 */
export const listForOrder = storeQuery({
  permission: "payments:read",
  args: { orderId: v.id("orders") },
  storeIdFrom: async (ctx, args) => {
    const order = await ctx.db.get(args.orderId);
    if (!order) throw new Error("Order not found");
    return order.storeId;
  },
  handler: (ctx, args) => documentsForOrder(ctx, args.orderId),
});

/**
 * Every invoice this establishment has issued, newest first.
 *
 * Bounded in the engine — this table grows with every paid order, for ever.
 */
export const listForStore = storeQuery({
  permission: "payments:read",
  // `storeIdFrom` defaults to `args.storeId`, which is what this takes.
  args: { storeId: v.id("stores"), limit: v.optional(v.number()) },
  handler: (ctx, args) =>
    invoicesForStore(ctx, args.storeId, { limit: args.limit }),
});

/**
 * One document, rendered.
 *
 * The HTML is built from the STORED row and nothing else: an invoice is frozen
 * at issue (art. 242 nonies A CGI), so a renderer that consulted a live setting
 * would restate a document that has already been given to a customer. The
 * renderer is a pure function in the engine for that reason, and for the other
 * one — a PDF path, when it comes, reads the same row.
 *
 * Returns the markup rather than a file: the browser prints it to PDF, and the
 * stylesheet is written for A4. Nothing here needs a rendering engine in the
 * Convex runtime.
 */
export const renderById = storeQuery({
  permission: "payments:read",
  args: { invoiceId: v.id("invoices") },
  storeIdFrom: async (ctx, args) => {
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice) throw new Error("Invoice not found");
    return invoice.storeId;
  },
  handler: async (ctx, args) => {
    const invoice = await invoiceById(ctx, args.invoiceId);
    if (!invoice) return null;
    return {
      number: invoice.number,
      kind: invoice.kind,
      issuedAt: invoice.issuedAt,
      html: renderInvoiceHtml(invoice as InvoiceDocument),
    };
  },
});
