/**
 * Shared business logic — pure functions used by multiple services.
 *
 * Services import from here, NEVER from each other.
 * This prevents regression cascading across service boundaries.
 */
export { selectOfferMultiplier } from './scoring'
export { validateDealType } from './deal-types'
