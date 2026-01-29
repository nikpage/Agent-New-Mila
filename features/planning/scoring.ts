// features/planning/scoring.ts

import { UserSettings, ActionPlan } from './types';

export function calculateMilaScore(
  czkAmount: number,
  role: string,
  settings: any
): number {
  const { anchor_2, anchor_10, role_configs, offer_multiplier = 1.5 } = settings;

  // 1. Role-Based Urgency Override (e.g., Wife = Top Urgency)
  if (role_configs?.[role]?.top_urgency) {
    return 1000; // Bypass score
  }

  // 2. Anchor-Based Financial Scoring (1-13 Scale)
  let symbolicValue = 1;
  if (czkAmount <= anchor_2) {
    symbolicValue = 2;
  } else if (czkAmount >= anchor_10) {
    symbolicValue = 10 + Math.min(3, (czkAmount / anchor_10)); // Scale up to 13
  } else {
    // Linear interpolation between anchor 2 and 10
    symbolicValue = 2 + ((czkAmount - anchor_2) / (anchor_10 - anchor_2)) * 8;
  }

  // 3. Apply Multipliers (e.g., Property Offer)
  const isOffer = true; // Logic to be passed from AI classification
  const vAdjusted = symbolicValue * (isOffer ? offer_multiplier : 1.0);

  // 4. Final Mila Formula
  // Priority = (V_adjusted × Urgency) + (Pain Factor × (Days Ignored + 1)²) + Weight
  // (Simplified for this logic block, assuming U, P, D, W are provided by AI)
  return vAdjusted;
}
