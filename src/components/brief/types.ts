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
}

/** Todo for display in the brief */
export interface BriefTodo {
  id: string
  description: string
  status: string | null
  due_date: string | null
  scheduled_time: string | null
}

/** All data for one brief page render */
export interface BriefData {
  actions: BriefAction[]
  events: {
    today: BriefEvent[]
    upcoming: BriefEvent[]
  }
  todos: BriefTodo[]
  completed: CompletedActionSummary[]
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
