// features/planning/types.ts

export type ActionType = 'REPLY' | 'SCHEDULE' | 'WAIT' | 'DELEGATE' | 'FILE';

export interface ScoreFactors {
  dollar_value: number;      // V: 1-13 (symbolic scale)
  urgency: number;           // U: 0-10
  pain_factor: number;       // P: 0-10
  weight: number;            // W: 0-10 for movable, 100 for immovable
  offer_multiplier: number;  // 1.5 if property offer from owner, 1.0 otherwise
  days_ignored: number;      // D: Days waiting on agent (New)
  totalPriority: number;     // Calculated score
}

export interface ActionPlan {
  action: ActionType;
  confidence: number; // 0.0 - 1.0
  reasoning: string;

  // Restored specific scoring logic
  scores: ScoreFactors;

  // Context for the drafter
  draftingContext?: {
    intent: string;
    keyPoints: string[];
    tone: 'professional' | 'urgent' | 'friendly';
  };
}
