'use client'

import { theme } from '@/config/theme'
import { ReplyCard } from './ReplyCard'
import { ScheduleCard } from './ScheduleCard'
import { TodoCard } from './TodoCard'
import { ConflictSection } from './ConflictSection'
import type { BriefAction } from './types'
import type { ConflictCardData } from '@/components/action/action-card-template'

interface BriefCardProps {
  action: BriefAction
  token: string
  expanded: boolean
  onToggle: () => void
  onExecute: () => Promise<void>
  onConvertTodo: () => Promise<void>
  onDismiss: () => Promise<void>
  onPostpone: (postponeTo: string) => Promise<void>
  onRegenerateDraft: (instruction: string) => Promise<{ subject: string; body: string }>
  onSaveDraft: (data: { meetingType?: string; dynamicFields?: Record<string, string>; notes?: string }) => Promise<void>
  /** Card has been acted on (done/sent) */
  done?: boolean
}

function getUrgencySignal(urgency: number): string {
  if (urgency >= 10) return '🔥🔥🔥 '
  if (urgency >= 9) return '🔥 '
  return ''
}

export function BriefCard({
  action, token, expanded, onToggle,
  onExecute, onConvertTodo, onDismiss, onPostpone,
  onRegenerateDraft, onSaveDraft, done,
}: BriefCardProps) {
  const headline = action.headline || action.cpName || 'Akce'
  const story = action.story || action.intent_cs || action.rationale_cs || action.rationale
  const urgencySignal = getUrgencySignal(action.urgency)

  const payload = action.payload as Record<string, unknown> | null
  const conflicts = (payload?.conflicts as ConflictCardData[]) || []
  const hasConflicts = conflicts.filter(c => !(c as Record<string, unknown>).resolved).length > 0

  // Done state
  if (done) {
    return (
      <div style={{
        padding: `${theme.spacing.md} ${theme.spacing.lg}`,
        backgroundColor: theme.colors.surface,
        borderRadius: theme.borderRadius.lg,
        border: `1px solid ${theme.colors.border}`,
        display: 'flex',
        alignItems: 'center',
        gap: theme.spacing.md,
        opacity: 0.7,
      }}>
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '24px',
          height: '24px',
          borderRadius: theme.borderRadius.full,
          backgroundColor: theme.colors.successBg,
          color: theme.colors.success,
          fontSize: '14px',
          flexShrink: 0,
        }}>
          ✓
        </span>
        <span style={{
          fontSize: theme.typography.sizes.sm,
          color: theme.colors.textMuted,
          textDecoration: 'line-through',
        }}>
          {headline}
        </span>
      </div>
    )
  }

  // Collapsed view
  if (!expanded) {
    return (
      <button
        onClick={onToggle}
        style={{
          display: 'block',
          width: '100%',
          textAlign: 'left',
          padding: `${theme.spacing.md} ${theme.spacing.lg}`,
          backgroundColor: theme.colors.surface,
          borderRadius: theme.borderRadius.lg,
          border: `1px solid ${theme.colors.border}`,
          boxShadow: theme.shadows.card,
          cursor: 'pointer',
          transition: 'box-shadow 0.2s',
        }}
      >
        <div style={{
          fontSize: theme.typography.sizes.base,
          fontWeight: theme.typography.weights.semibold,
          color: theme.colors.text,
          lineHeight: 1.4,
          marginBottom: theme.spacing.xs,
        }}>
          {urgencySignal}{headline}
        </div>
        <div style={{
          fontSize: theme.typography.sizes.sm,
          color: theme.colors.textMuted,
          lineHeight: 1.5,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {story}
        </div>
      </button>
    )
  }

  // Expanded view
  return (
    <div style={{
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borderRadius.lg,
      border: `1px solid ${theme.colors.border}`,
      boxShadow: theme.shadows.hover,
      overflow: 'hidden',
    }}>
      {/* Header — tappable to collapse */}
      <button
        onClick={onToggle}
        style={{
          display: 'block',
          width: '100%',
          textAlign: 'left',
          padding: `${theme.spacing.lg} ${theme.spacing.lg} ${theme.spacing.sm}`,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        <div style={{
          fontSize: theme.typography.sizes.lg,
          fontWeight: theme.typography.weights.semibold,
          color: theme.colors.text,
          lineHeight: 1.4,
          marginBottom: theme.spacing.xs,
        }}>
          {urgencySignal}{headline}
        </div>
        <div style={{
          fontSize: theme.typography.sizes.sm,
          color: theme.colors.textMuted,
          lineHeight: 1.6,
        }}>
          {story}
        </div>
      </button>

      {/* Conflict section (SCHEDULE only) */}
      {hasConflicts && action.action_type === 'SCHEDULE' && (
        <div style={{ padding: `0 ${theme.spacing.lg} ${theme.spacing.md}` }}>
          <ConflictSection
            conflicts={conflicts}
            cpName={action.cpName || ''}
            actionId={action.id}
            token={token}
          />
        </div>
      )}

      {/* Type-specific expanded content */}
      <div style={{ padding: `0 ${theme.spacing.lg} ${theme.spacing.lg}` }}>
        {action.action_type === 'REPLY' && (
          <ReplyCard
            action={action}
            token={token}
            onExecute={onExecute}
            onConvertTodo={onConvertTodo}
            onRegenerateDraft={onRegenerateDraft}
          />
        )}
        {action.action_type === 'SCHEDULE' && (
          <ScheduleCard
            action={action}
            token={token}
            onExecute={onExecute}
            onConvertTodo={onConvertTodo}
            onRegenerateDraft={onRegenerateDraft}
            onSaveDraft={onSaveDraft}
          />
        )}
        {action.action_type === 'TODO' && (
          <TodoCard
            action={action}
            onComplete={onExecute}
            onPostpone={onPostpone}
            onDismiss={onDismiss}
          />
        )}
      </div>
    </div>
  )
}
