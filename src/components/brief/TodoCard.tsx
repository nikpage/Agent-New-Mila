'use client'

import { useState } from 'react'
import { useTheme } from '@/contexts/ThemeContext'
import type { BriefAction } from './types'

interface TodoCardProps {
  action: BriefAction
  onPostpone: (postponeTo: string) => Promise<void>
  showPostponePicker?: boolean
}

export function TodoCard({ action, onPostpone, showPostponePicker }: TodoCardProps) {
  const theme = useTheme()
  const [postponeOpen, setPostponeOpen] = useState(false)
  const externalToggle = showPostponePicker ?? false

  // Sync external toggle
  const effectivePostponeOpen = postponeOpen || externalToggle
  const [loading, setLoading] = useState<string | null>(null)

  const summary = action.summaryJson
  const intent = action.intent_cs || action.rationale_cs || action.rationale
  const payload = action.payload as Record<string, unknown> | null
  const dueDate = payload?.due_date as string | null

  const POSTPONE_OPTIONS = [
    { value: 'today', label: 'Dnes' },
    { value: 'tomorrow', label: 'Zítra' },
    { value: 'next_week', label: 'Příští týden' },
  ] as const

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
      {/* Deal context */}
      {summary?.currentState && (
        <div style={{
          fontSize: theme.typography.sizes.sm, color: theme.colors.textMuted, lineHeight: 1.6,
          borderLeft: `2px solid ${theme.colors.border}`, paddingLeft: theme.spacing.md,
        }}>
          {summary.currentState}
        </div>
      )}

      {/* Task description */}
      <div style={{
        fontSize: theme.typography.sizes.base, color: theme.colors.text,
        lineHeight: 1.6, whiteSpace: 'pre-wrap',
      }}>
        {intent}
      </div>

      {/* Due date + Item 26: urgency context */}
      {dueDate && (
        <div style={{ fontSize: theme.typography.sizes.sm }}>
          <span style={{ color: theme.colors.textMuted }}>Termín: </span>
          <span style={{
            color: action.urgency >= 8 ? theme.colors.error : action.urgency >= 5 ? theme.colors.warning : theme.colors.text,
            fontWeight: theme.typography.weights.medium,
          }}>
            {new Date(dueDate).toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long' })}
          </span>
        </div>
      )}
      {action.urgency >= 5 && (
        <div style={{
          fontSize: theme.typography.sizes.xs,
          color: action.urgency >= 9 ? theme.colors.error : action.urgency >= 7 ? theme.colors.warning : theme.colors.textMuted,
          fontWeight: theme.typography.weights.medium,
          fontStyle: 'italic',
        }}>
          {action.urgency >= 9 ? 'Musíš to udělat TEĎKA'
            : action.urgency >= 7 ? 'Měl bys to udělat dnes'
            : 'Měl bys to udělat brzy'}
        </div>
      )}

      {/* Inline postpone picker (toggled from StickyBar "Odložit") */}
      {effectivePostponeOpen && (
        <div style={{
          display: 'flex', gap: theme.spacing.xs,
          padding: theme.spacing.sm, backgroundColor: theme.colors.background,
          borderRadius: theme.borderRadius.md,
        }}>
          {POSTPONE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={async () => {
                setLoading(opt.value)
                try { await onPostpone(opt.value) } finally { setLoading(null) }
              }}
              disabled={loading !== null}
              style={{
                flex: 1, padding: `${theme.spacing.sm} ${theme.spacing.md}`,
                backgroundColor: theme.colors.surface,
                border: `1px solid ${theme.colors.border}`,
                borderRadius: theme.borderRadius.md, cursor: 'pointer',
                fontSize: theme.typography.sizes.sm, fontWeight: theme.typography.weights.medium,
                color: theme.colors.text, opacity: loading ? 0.6 : 1,
              }}
            >
              {loading === opt.value ? '...' : opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
