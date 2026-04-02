'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
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

/** Snap minutes to 15-min grid */
function snapTo15(minutes: number): number {
  return Math.round(minutes / 15) * 15
}

interface DragState {
  eventId: string
  startY: number
  currentY: number
  originalTime: string
}

interface ConsequenceReview {
  eventId: string
  newTime: string
  message: string | null
  loading: boolean
}

/** Item 32: Inline time editing state */
interface TimeEditState {
  eventId: string
  value: string // HH:MM format
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

  const [localEvents, setLocalEvents] = useState(allEvents)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [consequence, setConsequence] = useState<ConsequenceReview | null>(null)
  const [timeEdit, setTimeEdit] = useState<TimeEditState | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Each pixel of drag = 1 minute (adjustable)
  const PX_PER_MINUTE = 2

  const onDragStart = useCallback((eventId: string, startY: number, originalTime: string) => {
    setDrag({ eventId, startY, currentY: startY, originalTime })
    setConsequence(null)
  }, [])

  const onDragMove = useCallback((clientY: number) => {
    if (!drag) return
    setDrag(prev => prev ? { ...prev, currentY: clientY } : null)
  }, [drag])

  const onDragEnd = useCallback(async () => {
    if (!drag) return

    const deltaY = drag.currentY - drag.startY
    const deltaMinutes = snapTo15(Math.round(deltaY / PX_PER_MINUTE))

    if (Math.abs(deltaMinutes) < 15) {
      // Too small — cancel
      setDrag(null)
      return
    }

    const originalDate = new Date(drag.originalTime)
    const newDate = new Date(originalDate.getTime() + deltaMinutes * 60_000)
    const newTimeIso = newDate.toISOString()

    // Optimistically update the event position
    setLocalEvents(prev => prev.map(e => {
      if (e.id !== drag.eventId) return e
      const duration = new Date(e.end_time).getTime() - new Date(e.start_time).getTime()
      return { ...e, start_time: newTimeIso, end_time: new Date(newDate.getTime() + duration).toISOString() }
    }))

    // Show consequence review loading
    setConsequence({
      eventId: drag.eventId,
      newTime: newTimeIso,
      message: null,
      loading: true,
    })

    const draggedEventId = drag.eventId
    setDrag(null)

    // TODO: Call consequence review API when backend is built
    // For now, show the consequence prompt directly
    const evt = allEvents.find(e => e.id === draggedEventId)
    const timeStr = formatTime(newTimeIso, timezone)
    setConsequence({
      eventId: draggedEventId,
      newTime: newTimeIso,
      message: `Přesunout "${evt?.title || 'událost'}" na ${timeStr}?`,
      loading: false,
    })
  }, [drag, allEvents, timezone])

  const confirmReschedule = useCallback(() => {
    // TODO: Call backend to persist + notify CPs
    setConsequence(null)
  }, [])

  const cancelReschedule = useCallback(() => {
    // Revert to original events
    setLocalEvents(allEvents)
    setConsequence(null)
  }, [allEvents])

  // Item 32: Handle time edit confirmation
  const handleTimeEditConfirm = useCallback((eventId: string, newTimeValue: string) => {
    const event = localEvents.find(e => e.id === eventId)
    if (!event) { setTimeEdit(null); return }

    const [hours, minutes] = newTimeValue.split(':').map(Number)
    const originalDate = new Date(event.start_time)
    const newDate = new Date(originalDate)
    newDate.setHours(hours, minutes, 0, 0)
    const newTimeIso = newDate.toISOString()
    const duration = new Date(event.end_time).getTime() - new Date(event.start_time).getTime()

    setLocalEvents(prev => prev.map(e => {
      if (e.id !== eventId) return e
      return { ...e, start_time: newTimeIso, end_time: new Date(newDate.getTime() + duration).toISOString() }
    }))

    const timeStr = formatTime(newTimeIso, timezone)
    setConsequence({
      eventId,
      newTime: newTimeIso,
      message: `Přesunout "${event.title || 'událost'}" na ${timeStr}?`,
      loading: false,
    })
    setTimeEdit(null)
  }, [localEvents, timezone])

  const onMouseDown = useCallback((eventId: string, clientY: number, originalTime: string) => {
    onDragStart(eventId, clientY, originalTime)
  }, [onDragStart])

  // Global mouse listeners for desktop drag
  useEffect(() => {
    if (!drag) return
    const handleMove = (e: MouseEvent) => {
      e.preventDefault()
      onDragMove(e.clientY)
    }
    const handleUp = () => {
      onDragEnd()
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [drag, onDragMove, onDragEnd])

  if (localEvents.length === 0) return null

  const grouped = groupByDate(localEvents, timezone)

  return (
    <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
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
              const isDragging = drag?.eventId === event.id

              // Skip travel buffers — shown as annotation
              if (isTravelBuffer) return null

              const dragOffset = isDragging ? drag.currentY - drag.startY : 0

              return (
                <div
                  key={event.id}
                  onTouchStart={e => {
                    const touch = e.touches[0]
                    onDragStart(event.id, touch.clientY, event.start_time)
                  }}
                  onTouchMove={e => {
                    if (drag?.eventId === event.id) {
                      e.preventDefault()
                      onDragMove(e.touches[0].clientY)
                    }
                  }}
                  onTouchEnd={() => {
                    if (drag?.eventId === event.id) onDragEnd()
                  }}
                  onMouseDown={(e: React.MouseEvent) => {
                    e.preventDefault()
                    onMouseDown(event.id, e.clientY, event.start_time)
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: theme.spacing.md,
                    padding: `${theme.spacing.sm} ${theme.spacing.md}`,
                    backgroundColor: isHold ? theme.colors.warningBg : theme.colors.surface,
                    borderRadius: theme.borderRadius.md,
                    border: `1px solid ${isHold ? theme.colors.warning : theme.colors.border}`,
                    opacity: isHold ? 0.85 : 1,
                    position: 'relative',
                    transform: isDragging ? `translateY(${dragOffset}px)` : 'translateY(0)',
                    transition: isDragging ? 'none' : 'transform 0.3s ease, box-shadow 0.2s ease',
                    boxShadow: isDragging ? '0 8px 24px rgba(0,0,0,0.15)' : 'none',
                    zIndex: isDragging ? 10 : 1,
                    cursor: 'grab',
                    touchAction: 'none',
                    userSelect: 'none',
                  }}
                >
                  {/* Travel buffer annotation */}
                  {event.travelMinutes && event.travelMinutes > 0 && (
                    <div style={{
                      position: 'absolute',
                      top: '-18px',
                      left: theme.spacing.md,
                      fontSize: '11px',
                      color: theme.colors.textMuted,
                      fontStyle: 'italic',
                    }}>
                      {event.travelMinutes} min cesta
                    </div>
                  )}

                  {/* Drag handle indicator */}
                  <span style={{
                    fontSize: '10px',
                    color: theme.colors.textMuted,
                    opacity: 0.4,
                    flexShrink: 0,
                    lineHeight: 1,
                  }}>
                    ⋮⋮
                  </span>

                  {/* Time — Item 32: tap to edit */}
                  {timeEdit?.eventId === event.id ? (
                    <input
                      type="time"
                      value={timeEdit.value}
                      onChange={e => setTimeEdit({ ...timeEdit, value: e.target.value })}
                      onBlur={() => handleTimeEditConfirm(event.id, timeEdit.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleTimeEditConfirm(event.id, timeEdit.value) }}
                      autoFocus
                      style={{
                        width: '70px', minWidth: '50px',
                        fontSize: theme.typography.sizes.sm,
                        fontWeight: theme.typography.weights.medium,
                        color: theme.colors.primary,
                        border: `1px solid ${theme.colors.primary}`,
                        borderRadius: theme.borderRadius.sm,
                        padding: '2px 4px',
                        fontVariantNumeric: 'tabular-nums',
                        outline: 'none',
                      }}
                    />
                  ) : (
                    <span
                      onClick={e => {
                        e.stopPropagation()
                        setTimeEdit({ eventId: event.id, value: formatTime(event.start_time, timezone) })
                      }}
                      style={{
                        fontSize: theme.typography.sizes.sm,
                        fontWeight: theme.typography.weights.medium,
                        color: theme.colors.text,
                        minWidth: '50px',
                        fontVariantNumeric: 'tabular-nums',
                        cursor: 'text',
                        borderBottom: `1px dashed ${theme.colors.border}`,
                      }}
                    >
                      {formatTime(event.start_time, timezone)}
                    </span>
                  )}

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

      {/* Consequence review overlay */}
      {consequence && (
        <div style={{
          padding: theme.spacing.md,
          backgroundColor: theme.colors.secondary,
          borderRadius: theme.borderRadius.md,
          border: `1px solid ${theme.colors.border}`,
          marginTop: theme.spacing.sm,
        }}>
          {consequence.loading ? (
            <div style={{ fontSize: theme.typography.sizes.sm, color: theme.colors.textMuted, textAlign: 'center' }}>
              Mila kontroluje dopady...
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }}>
              <div style={{ fontSize: theme.typography.sizes.sm, color: theme.colors.text, lineHeight: 1.6 }}>
                {consequence.message}
              </div>
              <div style={{ display: 'flex', gap: theme.spacing.sm }}>
                <button
                  onClick={confirmReschedule}
                  style={{
                    padding: `${theme.spacing.sm} ${theme.spacing.md}`,
                    backgroundColor: theme.colors.primary,
                    color: 'white',
                    border: 'none',
                    borderRadius: theme.borderRadius.md,
                    cursor: 'pointer',
                    fontSize: theme.typography.sizes.sm,
                    fontWeight: theme.typography.weights.medium,
                  }}
                >
                  Potvrdit změny
                </button>
                <button
                  onClick={cancelReschedule}
                  style={{
                    padding: `${theme.spacing.sm} ${theme.spacing.md}`,
                    backgroundColor: theme.colors.surface,
                    color: theme.colors.text,
                    border: `1px solid ${theme.colors.border}`,
                    borderRadius: theme.borderRadius.md,
                    cursor: 'pointer',
                    fontSize: theme.typography.sizes.sm,
                    fontWeight: theme.typography.weights.medium,
                  }}
                >
                  Zpět
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
