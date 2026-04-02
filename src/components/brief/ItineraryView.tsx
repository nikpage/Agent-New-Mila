'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { useTheme } from '@/contexts/ThemeContext'
import type { BriefEvent } from './types'

interface ItineraryViewProps {
  todayEvents: BriefEvent[]
  upcomingEvents: BriefEvent[]
  timezone: string
  userId?: string
  token?: string
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

interface ConflictInfo {
  eventId: string
  conflicts: { id: string; title: string; start_time: string; end_time: string }[]
}

/** Item 32: Inline time editing state */
interface TimeEditState {
  eventId: string
  value: string // HH:MM format
}

export function ItineraryView({ todayEvents, upcomingEvents, timezone, userId, token }: ItineraryViewProps) {
  const theme = useTheme()
  // Combine and deduplicate
  const allEventIds = new Set<string>()
  const initialEvents: BriefEvent[] = []
  for (const e of [...todayEvents, ...upcomingEvents]) {
    if (!allEventIds.has(e.id)) {
      allEventIds.add(e.id)
      initialEvents.push(e)
    }
  }

  const [localEvents, setLocalEvents] = useState(initialEvents)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [conflictInfo, setConflictInfo] = useState<ConflictInfo | null>(null)
  const [timeEdit, setTimeEdit] = useState<TimeEditState | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Each pixel of drag = 1 minute
  const PX_PER_MINUTE = 2

  const onDragStart = useCallback((eventId: string, startY: number, originalTime: string) => {
    setDrag({ eventId, startY, currentY: startY, originalTime })
    setConflictInfo(null)
  }, [])

  const onDragMove = useCallback((clientY: number) => {
    if (!drag) return
    setDrag(prev => prev ? { ...prev, currentY: clientY } : null)
  }, [drag])

  /** Persist reschedule to backend */
  const persistReschedule = useCallback(async (eventId: string, newStart: string, newEnd: string) => {
    if (!userId || !token) return
    setSaving(eventId)
    try {
      const res = await fetch(`/api/brief/${userId}/reschedule-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, eventId, newStart, newEnd }),
      })
      if (res.ok) {
        const result = await res.json()
        if (result.conflicts && result.conflicts.length > 0) {
          setConflictInfo({ eventId, conflicts: result.conflicts })
        }
      }
    } catch {
      // Silent — optimistic update already applied
    } finally {
      setSaving(null)
    }
  }, [userId, token])

  const onDragEnd = useCallback(async () => {
    if (!drag) return

    const deltaY = drag.currentY - drag.startY
    const deltaMinutes = snapTo15(Math.round(deltaY / PX_PER_MINUTE))

    if (Math.abs(deltaMinutes) < 15) {
      setDrag(null)
      return
    }

    const originalDate = new Date(drag.originalTime)
    const newDate = new Date(originalDate.getTime() + deltaMinutes * 60_000)
    const newTimeIso = newDate.toISOString()

    const draggedEventId = drag.eventId

    // Compute new end time
    const event = localEvents.find(e => e.id === draggedEventId)
    const duration = event ? new Date(event.end_time).getTime() - new Date(event.start_time).getTime() : 30 * 60_000
    const newEndIso = new Date(newDate.getTime() + duration).toISOString()

    // Commit: update local state immediately (no snap-back)
    setLocalEvents(prev => prev.map(e => {
      if (e.id !== draggedEventId) return e
      return { ...e, start_time: newTimeIso, end_time: newEndIso }
    }))

    setDrag(null)

    // Persist to backend
    await persistReschedule(draggedEventId, newTimeIso, newEndIso)
  }, [drag, localEvents, persistReschedule])

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
    const newEndIso = new Date(newDate.getTime() + duration).toISOString()

    setLocalEvents(prev => prev.map(e => {
      if (e.id !== eventId) return e
      return { ...e, start_time: newTimeIso, end_time: newEndIso }
    }))

    setTimeEdit(null)

    // Persist to backend
    persistReschedule(eventId, newTimeIso, newEndIso)
  }, [localEvents, persistReschedule])

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
              const isSaving = saving === event.id
              const hasConflict = conflictInfo?.eventId === event.id

              // Skip travel buffers
              if (isTravelBuffer) return null

              const dragOffset = isDragging ? drag.currentY - drag.startY : 0

              return (
                <div key={event.id}>
                  <div
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
                      border: `1px solid ${hasConflict ? theme.colors.error : isHold ? theme.colors.warning : theme.colors.border}`,
                      opacity: isSaving ? 0.7 : isHold ? 0.85 : 1,
                      position: 'relative',
                      transform: isDragging ? `translateY(${dragOffset}px)` : 'translateY(0)',
                      transition: isDragging ? 'none' : 'transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94), box-shadow 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
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

                    {/* Saving indicator */}
                    {isSaving && (
                      <span style={{ fontSize: theme.typography.sizes.xs, color: theme.colors.textMuted }}>
                        ...
                      </span>
                    )}

                    {/* Location */}
                    {event.location && !isSaving && (
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

                  {/* Inline conflict warning (no confirmation needed — just info) */}
                  {hasConflict && conflictInfo.conflicts.length > 0 && (
                    <div style={{
                      marginTop: theme.spacing.xs,
                      padding: `${theme.spacing.xs} ${theme.spacing.md}`,
                      fontSize: theme.typography.sizes.xs,
                      color: theme.colors.error,
                      backgroundColor: theme.colors.errorBg,
                      borderRadius: theme.borderRadius.sm,
                      lineHeight: 1.5,
                    }}>
                      {conflictInfo.conflicts.map(c => (
                        <div key={c.id}>
                          Koliduje s: {c.title || 'událost'} ({formatTime(c.start_time, timezone)} – {formatTime(c.end_time, timezone)})
                        </div>
                      ))}
                    </div>
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
