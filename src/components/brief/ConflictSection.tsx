'use client'

import { useState } from 'react'
import { theme } from '@/config/theme'
import type { ConflictCardData } from '@/components/action/action-card-template'

interface ConflictSectionProps {
  conflicts: ConflictCardData[]
  cpName: string
  actionId: string
  token: string
}

/**
 * Plain language conflict display that extends the SCHEDULE card.
 * No scores, no weights, no jargon — just what the user needs to know.
 */
export function ConflictSection({ conflicts, cpName, actionId, token }: ConflictSectionProps) {
  const unresolvedConflicts = conflicts.filter(c => !(c as Record<string, unknown>).resolved)
  const [resolving, setResolving] = useState<number | null>(null)
  const [resolvedIdxs, setResolvedIdxs] = useState<Set<number>>(new Set())

  if (unresolvedConflicts.length === 0) return null

  async function handleResolve(idx: number, resolution: string) {
    setResolving(idx)
    try {
      const res = await fetch(`/api/action/${actionId}/resolve-conflict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, conflict_idx: idx, action: resolution }),
      })
      if (res.ok) {
        setResolvedIdxs(prev => new Set(prev).add(idx))
      }
    } finally {
      setResolving(null)
    }
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: theme.spacing.sm,
      padding: theme.spacing.md,
      backgroundColor: '#fef2f2',
      border: '2px solid #dc2626',
      borderRadius: theme.borderRadius.md,
    }}>
      {unresolvedConflicts.map((conflict, idx) => {
        if (resolvedIdxs.has(idx)) return null

        const tz = 'Europe/Prague'
        const start = new Date(conflict.event_start)
        const end = new Date(conflict.event_end)
        const timeStr = `${start.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })} – ${end.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })}`
        const dateStr = start.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz })

        // Build plain-language description
        const altTimeStr = conflict.alt_slot_start ? (() => {
          const altS = new Date(conflict.alt_slot_start!)
          const altE = conflict.alt_slot_end ? new Date(conflict.alt_slot_end) : new Date(altS.getTime() + 30 * 60000)
          return `${altS.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz })}, ${altS.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })} – ${altE.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })}`
        })() : null

        const suggestion = conflict.recommendation === 'move_existing' && altTimeStr
          ? `Přesunout na ${altTimeStr}?`
          : 'Nelze přesunout.'

        const isResolving = resolving === idx

        return (
          <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
            <div style={{ fontSize: theme.typography.sizes.sm, color: '#991b1b', lineHeight: 1.6 }}>
              Koliduje s: <strong>{conflict.event_title}</strong> ({dateStr}, {timeStr}).{' '}
              {suggestion}
            </div>

            {/* Items 28-29: Inline resolution buttons */}
            <div style={{ display: 'flex', gap: theme.spacing.sm, flexWrap: 'wrap' }}>
              {conflict.recommendation === 'move_existing' && altTimeStr && (
                <button
                  onClick={() => handleResolve(idx, 'reschedule_existing')}
                  disabled={isResolving}
                  style={{
                    padding: `${theme.spacing.xs} ${theme.spacing.md}`,
                    backgroundColor: '#dc2626',
                    color: 'white',
                    border: 'none',
                    borderRadius: theme.borderRadius.md,
                    fontSize: theme.typography.sizes.sm,
                    fontWeight: theme.typography.weights.medium,
                    cursor: isResolving ? 'not-allowed' : 'pointer',
                    opacity: isResolving ? 0.6 : 1,
                  }}
                >
                  {isResolving ? '...' : `Přesunout ${conflict.event_title}`}
                </button>
              )}
              <button
                onClick={() => handleResolve(idx, 'keep_both')}
                disabled={isResolving}
                style={{
                  padding: `${theme.spacing.xs} ${theme.spacing.md}`,
                  backgroundColor: theme.colors.surface,
                  color: theme.colors.text,
                  border: `1px solid ${theme.colors.border}`,
                  borderRadius: theme.borderRadius.md,
                  fontSize: theme.typography.sizes.sm,
                  fontWeight: theme.typography.weights.medium,
                  cursor: isResolving ? 'not-allowed' : 'pointer',
                  opacity: isResolving ? 0.6 : 1,
                }}
              >
                {isResolving ? '...' : 'Nechat obojí'}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
