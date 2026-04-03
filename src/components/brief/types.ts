import type { ActionProposal, ConversationSummary } from '@/lib/supabase/types'

/** Enriched action with CP/conversation data, as returned by the refresh API */
export interface BriefAction extends ActionProposal {
  cpName: string | null
  cpRole: string | null
  topic: string | null
  summaryJson: ConversationSummary | null
  /** AI-generated headline + story, populated at brief send time or on-demand */
  headline?: string | null
  story?: string | null
  /** Per-action HMAC token for API calls (generated server-side) */
  actionToken?: string
}

/** Completed action summary for the "Mila vyřídila" section */
export interface CompletedActionSummary {
  id: string
  actionType: string
  cpName: string | null
  topic: string | null
  intentCs: string | null
  completedAt: string
}

/** Calendar event for the itinerary view */
export interface BriefEvent {
  id: string
  title: string | null
  start_time: string
  end_time: string
  location: string | null
  status: string | null
  event_type: string | null
  /** Travel buffer annotation (minutes), computed by parent */
  travelMinutes?: number
  /** CP name associated with this event */
  cpName?: string | null
}

/** Todo for display in the brief */
export interface BriefTodo {
  id: string
  description: string
  status: string | null
  due_date: string | null
  scheduled_time: string | null
}

/** Cooling contact — conversation with no recent inbound activity */
export interface CoolingContact {
  conversationId: string
  cpName: string
  topic: string | null
  daysSilent: number
}

/** All data for one brief page render */
export interface BriefData {
  userName: string
  greeting: string | null
  actions: BriefAction[]
  events: {
    today: BriefEvent[]
    upcoming: BriefEvent[]
  }
  todos: BriefTodo[]
  completed: CompletedActionSummary[]
  coolingContacts: CoolingContact[]
  settings: {
    timezone: string
    aiLanguage: string
    aiToneUser: string
  }
}

/** Card CTA callback types */
export interface CardCallbacks {
  onExecute: (actionId: string) => Promise<void>
  onConvertTodo: (actionId: string) => Promise<void>
  onDismiss: (actionId: string) => Promise<void>
  onPostpone: (actionId: string, postponeTo: string) => Promise<void>
  onRegenerateDraft: (actionId: string, instruction: string) => Promise<{ subject: string; body: string }>
  onSaveDraft: (actionId: string, data: { subject?: string; body?: string; notes?: string; dynamicFields?: Record<string, string>; meetingType?: string }) => Promise<void>
}

/** CTA config for the StickyBar to render */
export interface StickyBarCTA {
  label: string
  action: () => Promise<void> | void
  primary?: boolean
  destructive?: boolean
  disabled?: boolean
}
