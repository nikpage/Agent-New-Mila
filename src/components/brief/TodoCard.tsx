'use client'

import { useState } from 'react'
import { theme } from '@/config/theme'
import type { BriefAction } from './types'

interface TodoCardProps {
  action: BriefAction
  onComplete: () => Promise<void>
  onPostpone: (postponeTo: string) => Promise<void>
  onDismiss: () => Promise<void>
}

const POSTPONE_OPTIONS = [
  { value: 'today', label: 'Dnes' },
  { value: 'tomorrow', label: 'Zítra' },
  { value: 'next_week', label: 'Příští týden' },
] as const

export function TodoCard({ action, onComplete, onPostpone, onDismiss }: TodoCardProps) {
  const [loading, setLoading] = useState<string | null>(null)
  const [postponeOpen, setPostponeOpen] = useState(false)

  const summary = action.summaryJson
  const intent = action.intent_cs || action.rationale_cs || action.rationale

  // Due context: natural language from the action's urgency + created_at
  const payload = action.payload as Record<string, unknown> | null
  const dueDate = payload?.due_date as string | null

  const run = (key: string, fn: () => Promise<void>) => async () => {
    setLoading(key)
    try { await fn() } finally { setLoading(null) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
      {/* Deal narrative */}
      {summary?.currentState && (
        <div style={{ fontSize: theme.typography.sizes.sm, color: theme.colors.textMuted, lineHeight: 1.6 }}>
          {summary.currentState}
        </div>
      )}

      {/* Task description */}
      <div style={{
        fontSize: theme.typography.sizes.base,
        color: theme.colors.text,
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
      }}>
        {intent}
      </div>

      {/* Due date */}
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

      {/* Postpone segmented control */}
      {postponeOpen && (
        <div style={{
          display: 'flex',
          gap: theme.spacing.xs,
          padding: theme.spacing.sm,
          backgroundColor: theme.colors.secondary,
          borderRadius: theme.borderRadius.md,
        }}>
          {POSTPONE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={run(`postpone-${opt.value}`, () => onPostpone(opt.value))}
              disabled={loading !== null}
              style={{
                flex: 1,
                padding: `${theme.spacing.sm} ${theme.spacing.md}`,
                backgroundColor: theme.colors.surface,
                border: `1px solid ${theme.colors.border}`,
                borderRadius: theme.borderRadius.md,
                cursor: 'pointer',
                fontSize: theme.typography.sizes.sm,
                fontWeight: theme.typography.weights.medium,
                color: theme.colors.text,
                opacity: loading ? 0.6 : 1,
              }}
            >
              {loading === `postpone-${opt.value}` ? '...' : opt.label}
            </button>
          ))}
        </div>
      )}

      {/* CTAs — rendered in StickyBar on mobile, inline on desktop */}
      <div style={{
        display: 'flex',
        gap: theme.spacing.sm,
        alignItems: 'center',
        paddingTop: theme.spacing.sm,
        borderTop: `1px solid ${theme.colors.border}`,
      }}>
        <button
          onClick={run('complete', onComplete)}
          disabled={loading !== null}
          style={{
            padding: `${theme.spacing.sm} ${theme.spacing.lg}`,
            backgroundColor: theme.colors.primary,
            color: 'white',
            border: 'none',
            borderRadius: theme.borderRadius.md,
            cursor: 'pointer',
            fontWeight: theme.typography.weights.medium,
            fontSize: theme.typography.sizes.base,
            opacity: loading === 'complete' ? 0.6 : 1,
          }}
        >
          {loading === 'complete' ? '...' : 'Hotovo'}
        </button>

        <button
          onClick={() => setPostponeOpen(!postponeOpen)}
          style={{
            padding: `${theme.spacing.sm} ${theme.spacing.lg}`,
            backgroundColor: theme.colors.secondary,
            color: theme.colors.text,
            border: 'none',
            borderRadius: theme.borderRadius.md,
            cursor: 'pointer',
            fontWeight: theme.typography.weights.medium,
            fontSize: theme.typography.sizes.base,
          }}
        >
          Odložit
        </button>

        <button
          onClick={run('dismiss', async () => {
            if (confirm('Opravdu smazat tento úkol?')) {
              await onDismiss()
            }
          })}
          disabled={loading !== null}
          style={{
            padding: `${theme.spacing.sm} ${theme.spacing.md}`,
            backgroundColor: 'transparent',
            color: theme.colors.textMuted,
            border: 'none',
            borderRadius: theme.borderRadius.md,
            cursor: 'pointer',
            fontSize: theme.typography.sizes.sm,
            marginLeft: 'auto',
          }}
        >
          Smazat
        </button>
      </div>
    </div>
  )
}
