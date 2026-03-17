/**
 * Shared Scoring Utilities
 *
 * Pure functions used by multiple services (planning, lead-tracking, scheduling).
 * Extracted here to prevent cross-service imports that cause regression cascading.
 *
 * Rule: services import from shared/, never from each other.
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
