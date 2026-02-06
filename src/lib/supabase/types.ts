/**
 * Database types generated from Supabase schema
 * These match the exact structure of the database tables
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export interface Database {
  public: {
    Tables: {
      users: {
        Row: {
          id: string
          email: string | null
          email_enabled: boolean
          email_unsubscribed: boolean
          email_timezone: string
          settings: Json | null
          google_oauth_tokens: Json | null
          encrypted_google_tokens: string | null
          mila_name: string | null
          public_name: string | null
          created_at: string
        }
        Insert: {
          id?: string
          email?: string | null
          email_enabled?: boolean
          email_unsubscribed?: boolean
          email_timezone?: string
          settings?: Json | null
          google_oauth_tokens?: Json | null
          encrypted_google_tokens?: string | null
          mila_name?: string | null
          public_name?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          email?: string | null
          email_enabled?: boolean
          email_unsubscribed?: boolean
          email_timezone?: string
          settings?: Json | null
          google_oauth_tokens?: Json | null
          encrypted_google_tokens?: string | null
          mila_name?: string | null
          public_name?: string | null
          created_at?: string
        }
      }
      cps: {
        Row: {
          id: string
          user_id: string
          primary_identifier: string
          name: string | null
          role: string | null
          is_blacklisted: boolean
          other_identifiers: Json | null
          locations: Json | null
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          primary_identifier: string
          name?: string | null
          role?: string | null
          is_blacklisted?: boolean
          other_identifiers?: Json | null
          locations?: Json | null
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          primary_identifier?: string
          name?: string | null
          role?: string | null
          is_blacklisted?: boolean
          other_identifiers?: Json | null
          locations?: Json | null
          created_at?: string
        }
      }
      cp_states: {
        Row: {
          cp_id: string
          state: string | null
          summary_text: string | null
          last_updated: string | null
        }
        Insert: {
          cp_id: string
          state?: string | null
          summary_text?: string | null
          last_updated?: string | null
        }
        Update: {
          cp_id?: string
          state?: string | null
          summary_text?: string | null
          last_updated?: string | null
        }
      }
      channels: {
        Row: {
          id: string
          user_id: string
          type: string
          identifier: string
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          type: string
          identifier: string
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          type?: string
          identifier?: string
          created_at?: string
        }
      }
      messages: {
        Row: {
          id: string
          user_id: string
          cp_id: string | null
          channel_id: string | null
          conversation_id: string | null
          thread_id: string | null
          external_id: string | null
          external_thread_id: string | null
          universal_message_id: string
          direction: string | null
          raw_text: string | null
          cleaned_text: string | null
          tag_primary: string | null
          tag_secondary: string | null
          message_type: string | null
          timestamp: string
          occurred_at: string | null
        }
        Insert: {
          id?: string
          user_id: string
          cp_id?: string | null
          channel_id?: string | null
          conversation_id?: string | null
          thread_id?: string | null
          external_id?: string | null
          external_thread_id?: string | null
          universal_message_id: string
          direction?: string | null
          raw_text?: string | null
          cleaned_text?: string | null
          tag_primary?: string | null
          tag_secondary?: string | null
          message_type?: string | null
          timestamp?: string
          occurred_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string
          cp_id?: string | null
          channel_id?: string | null
          conversation_id?: string | null
          thread_id?: string | null
          external_id?: string | null
          external_thread_id?: string | null
          universal_message_id?: string
          direction?: string | null
          raw_text?: string | null
          cleaned_text?: string | null
          tag_primary?: string | null
          tag_secondary?: string | null
          message_type?: string | null
          timestamp?: string
          occurred_at?: string | null
        }
      }
      message_embeddings: {
        Row: {
          message_id: string
          embedding: number[] | null
        }
        Insert: {
          message_id: string
          embedding?: number[] | null
        }
        Update: {
          message_id?: string
          embedding?: number[] | null
        }
      }
      conversation_threads: {
        Row: {
          id: string
          user_id: string
          topic: string
          state: string | null
          deal_type: string | null
          summary_text: string | null
          summary_json: Json | null
          summary_confidence: number | null
          summary_confidence_reason: string | null
          priority_score: number | null
          message_count: number | null
          messages_since_rebuild: number | null
          embedding: number[] | null
          created_at: string | null
          last_updated: string | null
        }
        Insert: {
          id?: string
          user_id: string
          topic: string
          state?: string | null
          deal_type?: string | null
          summary_text?: string | null
          summary_json?: Json | null
          summary_confidence?: number | null
          summary_confidence_reason?: string | null
          priority_score?: number | null
          message_count?: number | null
          messages_since_rebuild?: number | null
          embedding?: number[] | null
          created_at?: string | null
          last_updated?: string | null
        }
        Update: {
          id?: string
          user_id?: string
          topic?: string
          state?: string | null
          deal_type?: string | null
          summary_text?: string | null
          summary_json?: Json | null
          summary_confidence?: number | null
          summary_confidence_reason?: string | null
          priority_score?: number | null
          message_count?: number | null
          messages_since_rebuild?: number | null
          embedding?: number[] | null
          created_at?: string | null
          last_updated?: string | null
        }
      }
      thread_participants: {
        Row: {
          thread_id: string
          cp_id: string
          added_at: string | null
        }
        Insert: {
          thread_id: string
          cp_id: string
          added_at?: string | null
        }
        Update: {
          thread_id?: string
          cp_id?: string
          added_at?: string | null
        }
      }
      action_proposals: {
        Row: {
          id: string
          user_id: string
          conversation_id: string
          cp_id: string
          action_type: string
          status: string
          intent_cs: string | null
          rationale_cs: string | null
          missing_info: Json | null
          rationale: string
          payload: Json
          draft_subject: string | null
          draft_body_text: string | null
          priority_score: number
          dollar_value: number
          urgency: number
          pain_factor: number
          weight: number | null
          offer_multiplier: number | null
          queued_for_brief: boolean | null
          last_notified_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          conversation_id: string
          cp_id: string
          action_type: string
          status?: string
          intent_cs?: string | null
          rationale_cs?: string | null
          missing_info?: Json | null
          rationale: string
          payload?: Json
          draft_subject?: string | null
          draft_body_text?: string | null
          priority_score?: number
          dollar_value?: number
          urgency?: number
          pain_factor?: number
          weight?: number | null
          offer_multiplier?: number | null
          queued_for_brief?: boolean | null
          last_notified_at?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          conversation_id?: string
          cp_id?: string
          action_type?: string
          status?: string
          intent_cs?: string | null
          rationale_cs?: string | null
          missing_info?: Json | null
          rationale?: string
          payload?: Json
          draft_subject?: string | null
          draft_body_text?: string | null
          priority_score?: number
          dollar_value?: number
          urgency?: number
          pain_factor?: number
          weight?: number | null
          offer_multiplier?: number | null
          queued_for_brief?: boolean | null
          last_notified_at?: string | null
          created_at?: string
        }
      }
      todos: {
        Row: {
          id: string
          user_id: string
          cp_id: string | null
          thread_id: string | null
          description: string
          status: string | null
          due_date: string | null
          scheduled_time: string | null
          created_at: string | null
        }
        Insert: {
          id?: string
          user_id: string
          cp_id?: string | null
          thread_id?: string | null
          description: string
          status?: string | null
          due_date?: string | null
          scheduled_time?: string | null
          created_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string
          cp_id?: string | null
          thread_id?: string | null
          description?: string
          status?: string | null
          due_date?: string | null
          scheduled_time?: string | null
          created_at?: string | null
        }
      }
      events: {
        Row: {
          id: string
          user_id: string
          cp_id: string | null
          parent_event_id: string | null
          pre_block_group_id: string | null
          title: string | null
          description: string | null
          location: string | null
          event_type: string | null
          status: string | null
          start_time: string
          end_time: string
          created_at: string | null
        }
        Insert: {
          id?: string
          user_id: string
          cp_id?: string | null
          parent_event_id?: string | null
          pre_block_group_id?: string | null
          title?: string | null
          description?: string | null
          location?: string | null
          event_type?: string | null
          status?: string | null
          start_time: string
          end_time: string
          created_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string
          cp_id?: string | null
          parent_event_id?: string | null
          pre_block_group_id?: string | null
          title?: string | null
          description?: string | null
          location?: string | null
          event_type?: string | null
          status?: string | null
          start_time?: string
          end_time?: string
          created_at?: string | null
        }
      }
      emails: {
        Row: {
          id: string
          user_id: string
          action_id: string
          external_id: string | null
          to: string | null
          subject: string | null
          text_body: string | null
          html_body: string | null
          status: string
          sent_at: string | null
          bounced: boolean
          retry_count: number
          last_retry_at: string | null
          last_error: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          action_id: string
          external_id?: string | null
          to?: string | null
          subject?: string | null
          text_body?: string | null
          html_body?: string | null
          status?: string
          sent_at?: string | null
          bounced?: boolean
          retry_count?: number
          last_retry_at?: string | null
          last_error?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          action_id?: string
          external_id?: string | null
          to?: string | null
          subject?: string | null
          text_body?: string | null
          html_body?: string | null
          status?: string
          sent_at?: string | null
          bounced?: boolean
          retry_count?: number
          last_retry_at?: string | null
          last_error?: string | null
          created_at?: string
          updated_at?: string
        }
      }
      agent_errors: {
        Row: {
          id: string
          user_id: string | null
          error_id: string
          agent_type: string
          message_user: string
          message_internal: string
          created_at: string | null
        }
        Insert: {
          id?: string
          user_id?: string | null
          error_id: string
          agent_type: string
          message_user: string
          message_internal: string
          created_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string | null
          error_id?: string
          agent_type?: string
          message_user?: string
          message_internal?: string
          created_at?: string | null
        }
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
  }
}

// Convenience type aliases
export type User = Database['public']['Tables']['users']['Row']
export type CP = Database['public']['Tables']['cps']['Row']
export type CPState = Database['public']['Tables']['cp_states']['Row']
export type Channel = Database['public']['Tables']['channels']['Row']
export type Message = Database['public']['Tables']['messages']['Row']
export type ConversationThread = Database['public']['Tables']['conversation_threads']['Row']
export type ThreadParticipant = Database['public']['Tables']['thread_participants']['Row']
export type ActionProposal = Database['public']['Tables']['action_proposals']['Row']
export type Todo = Database['public']['Tables']['todos']['Row']
export type Event = Database['public']['Tables']['events']['Row']
export type Email = Database['public']['Tables']['emails']['Row']
export type AgentError = Database['public']['Tables']['agent_errors']['Row']

// Insert types
export type UserInsert = Database['public']['Tables']['users']['Insert']
export type CPInsert = Database['public']['Tables']['cps']['Insert']
export type MessageInsert = Database['public']['Tables']['messages']['Insert']
export type ConversationThreadInsert = Database['public']['Tables']['conversation_threads']['Insert']
export type ActionProposalInsert = Database['public']['Tables']['action_proposals']['Insert']
export type TodoInsert = Database['public']['Tables']['todos']['Insert']
export type EventInsert = Database['public']['Tables']['events']['Insert']

// Action types
export type ActionType = 'REPLY' | 'SCHEDULE' | 'WAIT' | 'FILE' | 'DELEGATE'
export type ActionStatus = 'pending' | 'approved' | 'needs_revision' | 'completed' | 'dismissed'

// Conversation summary JSON structure
export interface ConversationSummary {
  currentState: string
  risks: string[]
  nextSteps: string[]
  keyPoints: string[]
}
