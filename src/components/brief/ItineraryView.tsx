'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import type { BriefEvent } from './types'

interface ItineraryViewProps {
  todayEvents: BriefEvent[]
  upcomingEvents: BriefEvent[]
  timezone: string
  userId?: string
  token?: string
}

function formatTime(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString('cs-CZ', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: tz,
  })
}

export function ItineraryView({ todayEvents, upcomingEvents, timezone, userId, token }: ItineraryViewProps) {
  // Combine and deduplicate
  const allEventIds = new Set<string>()
  const initialEvents: BriefEvent[] = []
  for (const e of [...todayEvents, ...upcomingEvents]) {
    if (!allEventIds.has(e.id)) {
      allEventIds.add(e.id)
      initialEvents.push(e)
    }
  }

  // Filter out travel buffers, keep only today's events for the "Dnes" section
  const todayOnly = initialEvents.filter(e => {
    if (e.event_type === 'travel_buffer') return false
    const eventDate = new Date(e.start_time).toDateString()
    const today = new Date().toDateString()
    return eventDate === today
  })

  const [localEvents, setLocalEvents] = useState(todayOnly)
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  /** Persist reschedule to backend */
  const persistReschedule = useCallback(async (eventId: string, newStart: string, newEnd: string) => {
    if (!userId || !token) return
    setSaving(eventId)
    try {
      await fetch(`/api/brief/${userId}/reschedule-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, eventId, newStart, newEnd }),
      })
    } catch {
      // Silent — optimistic update already applied
    } finally {
      setSaving(null)
    }
  }, [userId, token])

  // HTML5 drag-and-drop handlers
  const handleDragStart = useCallback((idx: number) => {
    setDraggedIdx(idx)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault()
    if (draggedIdx !== null && draggedIdx !== idx) {
      setDragOverIdx(idx)
    }
  }, [draggedIdx])

  const handleDragLeave = useCallback(() => {
    setDragOverIdx(null)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent, targetIdx: number) => {
    e.preventDefault()
    setDragOverIdx(null)
    if (draggedIdx === null || draggedIdx === targetIdx) return

    const newEvents = [...localEvents]
    const [moved] = newEvents.splice(draggedIdx, 1)
    newEvents.splice(targetIdx, 0, moved)

    // Recalculate time for the moved event based on its new neighbor
    const neighbor = newEvents[targetIdx > 0 ? targetIdx - 1 : targetIdx + 1]
    if (neighbor && moved) {
      const moveDuration = new Date(moved.end_time).getTime() - new Date(moved.start_time).getTime()
      // Place after the previous event (or at the previous event's start if first)
      const newStart = targetIdx > 0
        ? new Date(neighbor.end_time)
        : new Date(neighbor.start_time)
      // If placing before the first event, shift back by duration
      if (targetIdx === 0 && newEvents.length > 1) {
        const firstStart = new Date(newEvents[1].start_time)
        newStart.setTime(firstStart.getTime() - moveDuration - 15 * 60000) // 15 min gap
      }
      const newEnd = new Date(newStart.getTime() + moveDuration)

      moved.start_time = newStart.toISOString()
      moved.end_time = newEnd.toISOString()

      persistReschedule(moved.id, moved.start_time, moved.end_time)
    }

    setLocalEvents(newEvents)
  }, [draggedIdx, localEvents, persistReschedule])

  const handleDragEnd = useCallback(() => {
    setDraggedIdx(null)
    setDragOverIdx(null)
  }, [])

  // Touch-based drag for mobile
  const touchStartY = useRef(0)
  const [touchDrag, setTouchDrag] = useState<{ idx: number; deltaY: number } | null>(null)

  const handleTouchStart = useCallback((idx: number, e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY
    setTouchDrag({ idx, deltaY: 0 })
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchDrag) return
    const dy = e.touches[0].clientY - touchStartY.current
    setTouchDrag(prev => prev ? { ...prev, deltaY: dy } : null)
  }, [touchDrag])

  const handleTouchEnd = useCallback(() => {
    if (!touchDrag) return
    const { idx, deltaY } = touchDrag
    const rowHeight = 50 // approximate
    const moveBy = Math.round(deltaY / rowHeight)
    if (moveBy !== 0) {
      const newIdx = Math.max(0, Math.min(localEvents.length - 1, idx + moveBy))
      if (newIdx !== idx) {
        const newEvents = [...localEvents]
        const [moved] = newEvents.splice(idx, 1)
        newEvents.splice(newIdx, 0, moved)

        // Recalculate time for the moved event
        const neighbor = newEvents[newIdx > 0 ? newIdx - 1 : newIdx + 1]
        if (neighbor && moved) {
          const moveDuration = new Date(moved.end_time).getTime() - new Date(moved.start_time).getTime()
          const newStart = newIdx > 0
            ? new Date(neighbor.end_time)
            : new Date(new Date(newEvents[1]?.start_time || neighbor.start_time).getTime() - moveDuration - 15 * 60000)
          const newEnd = new Date(newStart.getTime() + moveDuration)
          moved.start_time = newStart.toISOString()
          moved.end_time = newEnd.toISOString()
          persistReschedule(moved.id, moved.start_time, moved.end_time)
        }

        setLocalEvents(newEvents)
      }
    }
    setTouchDrag(null)
  }, [touchDrag, localEvents, persistReschedule])

  if (localEvents.length === 0) return null

  return (
    <div style={{ marginTop: '24px' }}>
      <div style={{
        fontSize: '11px',
        fontWeight: 600,
        letterSpacing: '0.09em',
        textTransform: 'uppercase',
        color: 'var(--sub)',
        margin: '0 0 10px 2px',
      }}>
        Dnes
      </div>

      <div>
        {localEvents.map((event, idx) => {
          const isHold = event.status === 'tentative' || event.event_type === 'hold'
          const isBusy = !isHold && event.title && !event.title.toLowerCase().includes('volno')
          const isMilaAdded = event.cpName !== undefined && event.cpName !== null
          const isDragging = draggedIdx === idx
          const isDragOver = dragOverIdx === idx
          const isSaving = saving === event.id
          const isTouchDragging = touchDrag?.idx === idx

          return (
            <div
              key={event.id}
              draggable
              onDragStart={() => handleDragStart(idx)}
              onDragOver={(e) => handleDragOver(e, idx)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, idx)}
              onDragEnd={handleDragEnd}
              onTouchStart={(e) => handleTouchStart(idx, e)}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              style={{
                display: 'flex',
                gap: '12px',
                padding: '10px 4px',
                borderBottom: idx < localEvents.length - 1 ? '1px solid var(--brd)' : 'none',
                alignItems: 'flex-start',
                cursor: 'grab',
                borderRadius: '8px',
                transition: 'background .15s, padding .15s',
                opacity: isDragging ? 0.35 : isSaving ? 0.7 : 1,
                background: isDragOver ? 'var(--surf-h)' : 'transparent',
                paddingLeft: isDragOver ? '8px' : '4px',
                paddingRight: isDragOver ? '8px' : '4px',
                transform: isTouchDragging ? `translateY(${touchDrag!.deltaY}px)` : undefined,
              }}
            >
              {/* Time */}
              <div style={{
                fontSize: '11px',
                fontWeight: 600,
                color: 'var(--sub)',
                width: '40px',
                flexShrink: 0,
                paddingTop: '2px',
                letterSpacing: '0.02em',
              }}>
                {formatTime(event.start_time, timezone)}
              </div>

              {/* Status dot — accent for busy events, border for free, hold gets muted */}
              <div style={{
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                background: isHold ? 'var(--sub)' : isBusy ? 'var(--acc)' : 'var(--brd)',
                flexShrink: 0,
                marginTop: '5px',
                transition: 'background .3s',
              }} />

              {/* Content */}
              <div style={{
                fontSize: '13.5px',
                color: 'var(--txt)',
                lineHeight: 1.4,
                flex: 1,
              }}>
                {event.title || 'Volno'}
                {(event.cpName || event.location || isHold) && (
                  <span style={{
                    display: 'block',
                    fontSize: '12px',
                    color: 'var(--sub)',
                    marginTop: '2px',
                  }}>
                    {isHold ? 'Čeká na potvrzení' : event.cpName || event.location || ''}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
