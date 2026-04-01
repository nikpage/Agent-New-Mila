'use client'

import { theme } from '@/config/theme'
import type { BriefEvent } from './types'

interface ItineraryViewProps {
  todayEvents: BriefEvent[]
  upcomingEvents: BriefEvent[]
  timezone: string
}

/** Group events by date string */
function groupByDate(events: BriefEvent[], tz: string): Map<string, BriefEvent[]> {
  const groups = new Map<string, BriefEvent[]>()
  for (const event of events) {
    const date = new Date(event.start_time).toLocaleDateString('cs-CZ', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: tz,
    })
    const group = groups.get(date) || []
    group.push(event)
    groups.set(date, group)
  }
  return groups
}

function formatTime(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString('cs-CZ', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: tz,
  })
}

export function ItineraryView({ todayEvents, upcomingEvents, timezone }: ItineraryViewProps) {
  // Combine and deduplicate
  const allEventIds = new Set<string>()
  const allEvents: BriefEvent[] = []
  for (const e of [...todayEvents, ...upcomingEvents]) {
    if (!allEventIds.has(e.id)) {
      allEventIds.add(e.id)
      allEvents.push(e)
    }
  }

  if (allEvents.length === 0) return null

  const grouped = groupByDate(allEvents, timezone)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
      <div style={{
        fontSize: theme.typography.sizes.xs,
        fontWeight: theme.typography.weights.medium,
        color: theme.colors.textMuted,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
      }}>
        Kalendář
      </div>

      {Array.from(grouped.entries()).map(([dateLabel, events]) => (
        <div key={dateLabel}>
          {/* Day header */}
          <div style={{
            fontSize: theme.typography.sizes.sm,
            fontWeight: theme.typography.weights.semibold,
            color: theme.colors.text,
            marginBottom: theme.spacing.sm,
            textTransform: 'capitalize',
          }}>
            {dateLabel}
          </div>

          {/* Event rows */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
            {events.map(event => {
              const isHold = event.status === 'tentative' || event.event_type === 'hold'
              const isTravelBuffer = event.event_type === 'travel_buffer'

              // Skip travel buffers — shown as annotation
              if (isTravelBuffer) return null

              return (
                <div
                  key={event.id}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: theme.spacing.md,
                    padding: `${theme.spacing.sm} ${theme.spacing.md}`,
                    backgroundColor: isHold ? theme.colors.warningBg : theme.colors.surface,
                    borderRadius: theme.borderRadius.md,
                    border: `1px solid ${isHold ? theme.colors.warning : theme.colors.border}`,
                    opacity: isHold ? 0.85 : 1,
                  }}
                >
                  {/* Travel buffer annotation */}
                  {event.travelMinutes && event.travelMinutes > 0 && (
                    <div style={{
                      position: 'absolute',
                      top: '-16px',
                      left: theme.spacing.md,
                      fontSize: '10px',
                      color: theme.colors.textMuted,
                    }}>
                      {event.travelMinutes} min cesta
                    </div>
                  )}

                  {/* Time */}
                  <span style={{
                    fontSize: theme.typography.sizes.sm,
                    fontWeight: theme.typography.weights.medium,
                    color: theme.colors.text,
                    minWidth: '50px',
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {formatTime(event.start_time, timezone)}
                  </span>

                  {/* Title */}
                  <span style={{
                    fontSize: theme.typography.sizes.sm,
                    color: theme.colors.text,
                    flex: 1,
                  }}>
                    {event.title || 'Bez názvu'}
                    {isHold && (
                      <span style={{
                        fontSize: theme.typography.sizes.xs,
                        color: theme.colors.warning,
                        marginLeft: theme.spacing.sm,
                        fontStyle: 'italic',
                      }}>
                        čeká na potvrzení
                      </span>
                    )}
                  </span>

                  {/* Location */}
                  {event.location && (
                    <span style={{
                      fontSize: theme.typography.sizes.xs,
                      color: theme.colors.textMuted,
                      maxWidth: '150px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {event.location}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
