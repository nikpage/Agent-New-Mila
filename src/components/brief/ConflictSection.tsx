'use client'

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
  if (unresolvedConflicts.length === 0) return null

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

        return (
          <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
            <div style={{ fontSize: theme.typography.sizes.sm, color: '#991b1b', lineHeight: 1.6 }}>
              Koliduje s: <strong>{conflict.event_title}</strong> ({dateStr}, {timeStr}).{' '}
              {suggestion}
            </div>

            <div style={{ display: 'flex', gap: theme.spacing.sm }}>
              <a
                href={`/action/${actionId}?token=${token}&do=resolve_conflict&conflict_idx=${idx}&action=move_new`}
                style={{
                  padding: `${theme.spacing.xs} ${theme.spacing.md}`,
                  backgroundColor: '#dc2626',
                  color: 'white',
                  borderRadius: theme.borderRadius.md,
                  fontSize: theme.typography.sizes.sm,
                  fontWeight: theme.typography.weights.medium,
                  textDecoration: 'none',
                  display: 'inline-block',
                }}
              >
                Vyřešit kolizi
              </a>
            </div>
          </div>
        )
      })}
    </div>
  )
}
