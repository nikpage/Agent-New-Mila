/**
 * Shared Scoring Utilities
 *
 * Pure functions used by multiple services (planning, lead-tracking, scheduling).
 * Extracted here to prevent cross-service imports that cause regression cascading.
 *
 * Rule: services import from shared/, never from each other.
 * When you change logic here, ALL consumers get the fix automatically.
 */

/**
 * Select offer multiplier based on counterparty role.
 * Sellers get higher multiplier (more commission value).
 */
export function selectOfferMultiplier(
  cpRole: string | null,
  sellerMultiplier: number,
  buyerMultiplier: number
): number {
  return cpRole === 'seller' ? sellerMultiplier : buyerMultiplier
}

/**
 * Compute days since last contact from a CP.
 *
 * Single source of truth — used by both planning (Step 6) and lead-tracking (Step 7).
 * Before extraction, planning fell back to conversation.last_updated while
 * lead-tracking fell back to conversation.created_at, causing inconsistent scoring.
 * Now both use the same fallback chain: latestInbound → created_at → now.
 *
 * Fallback to created_at (not last_updated) because last_updated resets on every
 * summary rebuild, which would make daysIgnored artificially low.
 */
export function computeDaysIgnored(
  latestInboundTimestamp: string | Date | null | undefined,
  conversationCreatedAt: string | Date | null | undefined,
): number {
  const lastContactDate = latestInboundTimestamp
    ? new Date(latestInboundTimestamp)
    : conversationCreatedAt
      ? new Date(conversationCreatedAt)
      : new Date()
  return Math.max(0, Math.floor(
    (Date.now() - lastContactDate.getTime()) / (1000 * 60 * 60 * 24)
  ))
}
