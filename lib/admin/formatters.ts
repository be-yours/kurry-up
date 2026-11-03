/**
 * Format price from cents to currency string
 * @param cents - Price in cents (e.g., 1250 = €12.50)
 * @param currency - Currency code (default: EUR)
 * @returns Formatted price string
 */
export function formatPrice(cents: number, currency: string = "EUR"): string {
  const amount = cents / 100

  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency,
  }).format(amount)
}

/**
 * Format timestamp to French date string
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Formatted date string (e.g., "15 févr. 2026 à 14:30")
 */
export function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp))
}

/**
 * Format timestamp to short date string
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Formatted date string (e.g., "15/02/2026")
 */
export function formatShortDate(timestamp: number): string {
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "short",
  }).format(new Date(timestamp))
}

/**
 * Format order number with # prefix
 * @param orderNumber - Order number string
 * @returns Formatted order number (e.g., "#1234")
 */
export function formatOrderNumber(orderNumber: string): string {
  return `#${orderNumber}`
}

/**
 * Generate a URL-friendly slug from text
 * @param text - Text to slugify
 * @returns Lowercase slug with hyphens
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD") // Normalize to decomposed form for accents
    .replace(/[\u0300-\u036f]/g, "") // Remove accents
    .replace(/[^a-z0-9]+/g, "-") // Replace non-alphanumeric with hyphens
    .replace(/^-+|-+$/g, "") // Remove leading/trailing hyphens
    .substring(0, 100) // Limit length
}

/**
 * Convert euros to cents
 * @param euros - Amount in euros
 * @returns Amount in cents
 */
export function eurosToCents(euros: number): number {
  return Math.round(euros * 100)
}

/**
 * Convert cents to euros
 * @param cents - Amount in cents
 * @returns Amount in euros
 */
export function centsToEuros(cents: number): number {
  return cents / 100
}
