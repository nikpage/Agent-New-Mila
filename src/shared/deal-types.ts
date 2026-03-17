/**
 * Shared Deal Type Utilities
 *
 * Pure functions for deal type validation, used by planning and threading.
 * Extracted here to prevent cross-service imports that cause regression cascading.
 *
 * Rule: services import from shared/, never from each other.
 */

import { VALID_DEAL_TYPES } from '@/lib/supabase/types'
import type { DealType } from '@/lib/supabase/types'

/**
 * Validate AI-returned dealType against known values.
 * Returns null for invalid/unknown values instead of storing garbage.
 */
export function validateDealType(value: unknown): DealType {
  if (typeof value !== 'string') return null
  return (VALID_DEAL_TYPES as readonly string[]).includes(value)
    ? (value as DealType)
    : null
}
