'use client'

import { useState, useEffect } from 'react'
import { theme } from '@/config/theme'
import type { BriefAction } from './types'

type MeetingType = 'address' | 'online' | 'phone'

interface ScheduleCardProps {
  action: BriefAction
  token: string
  onRegenerateDraft: (instruction: string) => Promise<{ subject: string; body: string }>
  onSaveDraft: (data: { meetingType?: string; dynamicFields?: Record<string, string>; notes?: string }) => Promise<void>
}

const MEETING_TYPES: { value: MeetingType; label: string }[] = [
  { value: 'address', label: 'Osobně' },
  { value: 'online', label: 'Online' },
  { value: 'phone', label: 'Telefon' },
]

const DURATION_CHIPS = [10, 30, 60] as const

export function ScheduleCard({ action, token, onRegenerateDraft, onSaveDraft }: ScheduleCardProps) {
  const [loading, setLoading] = useState(false)

  const payload = action.payload as Record<string, unknown> | null
  const holdStart = payload?.start as string | undefined
  const holdEnd = payload?.end as string | undefined
  const hasHold = !!payload?.hold_event_id

  const [meetingType, setMeetingType] = useState<MeetingType>(
    (payload?.meeting_type as MeetingType) || (payload?.is_online ? 'online' : 'address')
  )
  const [location, setLocation] = useState((payload?.location as string) || '')
  const locationPartial = !!payload?.location_partial
  const [duration, setDuration] = useState(() => {
    if (holdStart && holdEnd) {
      return Math.round((new Date(holdEnd).getTime() - new Date(holdStart).getTime()) / 60000)
    }
    return 30
  })
  const [customDuration, setCustomDuration] = useState(false)
  const [isFlexible, setIsFlexible] = useState((action.weight ?? 0) <= 3)
  const [instruction, setInstruction] = useState('')
  const [regenerating, setRegenerating] = useState(false)
  const [draftBody, setDraftBody] = useState(action.draft_body_text || '')
  const [draftLoaded, setDraftLoaded] = useState(!!action.draft_body_text)

  const summary = action.summaryJson

  // Format slot
  const slotText = holdStart && holdEnd ? (() => {
    const tz = 'Europe/Prague'
    const s = new Date(holdStart)
    const e = new Date(holdEnd)
    const dateStr = s.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz })
    const startStr = s.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
    const endStr = e.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
    return `${dateStr}, ${startStr} – ${endStr}`
  })() : null

  // Auto-load draft
  useEffect(() => {
    if (draftLoaded) return
    let cancelled = false
    setLoading(true)
    fetch(`/api/action/${action.id}/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (cancelled || !data) return
        setDraftBody(data.body || '')
        setDraftLoaded(true)
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [action.id, token, draftLoaded])

  async function handleMeetingTypeChange(type: MeetingType) {
    setMeetingType(type)
    await onSaveDraft({ meetingType: type })
  }

  async function handleLocationBlur() {
    if (location.trim()) await onSaveDraft({ dynamicFields: { 'Adresa schůzky': location } })
  }

  async function handleRegenerate() {
    if (!instruction.trim()) return
    setRegenerating(true)
    try {
      const result = await onRegenerateDraft(instruction.trim())
      setDraftBody(result.body)
      setInstruction('')
    } finally {
      setRegenerating(false)
    }
  }

  const chipStyle = (active: boolean) => ({
    padding: `${theme.spacing.sm} ${theme.spacing.md}`,
    backgroundColor: active ? theme.colors.primary : theme.colors.surface,
    color: active ? 'white' : theme.colors.text,
    border: `1.5px solid ${active ? theme.colors.primary : theme.colors.border}`,
    borderRadius: theme.borderRadius.md,
    cursor: 'pointer' as const,
    fontSize: theme.typography.sizes.sm,
    fontWeight: active ? theme.typography.weights.semibold : theme.typography.weights.normal,
    transition: 'all 0.15s ease',
  })

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

      {/* Slot */}
      {slotText && (
        <div style={{
          padding: theme.spacing.md, backgroundColor: theme.colors.background,
          borderRadius: theme.borderRadius.md, fontSize: theme.typography.sizes.sm,
          color: theme.colors.text, fontWeight: theme.typography.weights.medium,
        }}>
          {slotText}
        </div>
      )}

      {/* Meeting type */}
      <div>
        <div style={{
          fontSize: theme.typography.sizes.xs, fontWeight: theme.typography.weights.semibold,
          color: theme.colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em',
          marginBottom: theme.spacing.xs,
        }}>
          Typ schůzky
        </div>
        <div style={{ display: 'flex', gap: theme.spacing.sm }}>
          {MEETING_TYPES.map(mt => (
            <button key={mt.value} onClick={() => handleMeetingTypeChange(mt.value)}
              style={{ ...chipStyle(meetingType === mt.value), flex: 1 }}>
              {mt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Duration */}
      <div>
        <div style={{
          fontSize: theme.typography.sizes.xs, fontWeight: theme.typography.weights.semibold,
          color: theme.colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em',
          marginBottom: theme.spacing.xs,
        }}>
          Délka
        </div>
        <div style={{ display: 'flex', gap: theme.spacing.sm }}>
          {DURATION_CHIPS.map(d => (
            <button key={d} onClick={() => { setDuration(d); setCustomDuration(false); onSaveDraft({ dynamicFields: { duration: String(d) } }) }}
              style={chipStyle(duration === d && !customDuration)}>
              {d} min
            </button>
          ))}
          <button onClick={() => setCustomDuration(true)} style={chipStyle(customDuration)}>
            Jinak
          </button>
        </div>
        {customDuration && (
          <input type="number" min={5} max={480} step={5} value={duration}
            onChange={e => setDuration(parseInt(e.target.value, 10) || 30)}
            onBlur={() => onSaveDraft({ dynamicFields: { duration: String(duration) } })}
            style={{
              marginTop: theme.spacing.sm, width: '80px',
              padding: `${theme.spacing.xs} ${theme.spacing.sm}`,
              border: `1px solid ${theme.colors.border}`, borderRadius: theme.borderRadius.md,
              fontSize: theme.typography.sizes.sm, color: theme.colors.text,
            }}
          />
        )}
      </div>

      {/* Location */}
      {meetingType === 'address' && (
        <input
          type="text" value={location} onChange={e => setLocation(e.target.value)}
          onBlur={handleLocationBlur} placeholder="Adresa schůzky..."
          style={{
            width: '100%', padding: `${theme.spacing.sm} ${theme.spacing.md}`,
            border: `1px solid ${locationPartial && !location ? theme.colors.warning : theme.colors.border}`,
            borderRadius: theme.borderRadius.md, fontSize: theme.typography.sizes.base,
            color: theme.colors.text,
            backgroundColor: locationPartial && !location ? theme.colors.warningBg : theme.colors.surface,
            outline: 'none',
          }}
        />
      )}

      {/* Pevný / Flexibilní */}
      <div style={{ display: 'flex', gap: theme.spacing.sm }}>
        <button onClick={() => { setIsFlexible(false); onSaveDraft({ notes: 'Pevný termín (weight 10)' }) }} style={{ ...chipStyle(!isFlexible), flex: 1 }}>
          Pevný termín
        </button>
        <button onClick={() => { setIsFlexible(true); onSaveDraft({ notes: 'Flexibilní termín (weight 1)' }) }} style={{ ...chipStyle(isFlexible), flex: 1 }}>
          Flexibilní
        </button>
      </div>

      {/* Draft */}
      {!draftLoaded ? (
        <div style={{
          padding: theme.spacing.lg, textAlign: 'center',
          color: theme.colors.textMuted, fontSize: theme.typography.sizes.sm,
        }}>
          {loading ? 'Mila připravuje koncept...' : ''}
        </div>
      ) : (
        <div>
          <div style={{
            fontSize: theme.typography.sizes.xs, fontWeight: theme.typography.weights.semibold,
            color: theme.colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em',
            marginBottom: theme.spacing.xs,
          }}>
            Zpráva pro {action.cpName || 'protistranu'}
          </div>
          <textarea
            value={draftBody} onChange={e => setDraftBody(e.target.value)} rows={5}
            style={{
              width: '100%', padding: theme.spacing.md,
              border: `1px solid ${theme.colors.border}`, borderRadius: theme.borderRadius.md,
              fontSize: theme.typography.sizes.base, color: theme.colors.text,
              backgroundColor: theme.colors.surface, outline: 'none',
              resize: 'vertical', lineHeight: 1.6, fontFamily: theme.typography.fontFamily,
            }}
          />
        </div>
      )}

      {/* Instruction */}
      {draftLoaded && (
        <div style={{ display: 'flex', gap: theme.spacing.sm }}>
          <input
            type="text" value={instruction} onChange={e => setInstruction(e.target.value)}
            placeholder="Změnit koncept..." onKeyDown={e => e.key === 'Enter' && handleRegenerate()}
            style={{
              flex: 1, padding: `${theme.spacing.sm} ${theme.spacing.md}`,
              border: `1px solid ${theme.colors.border}`, borderRadius: theme.borderRadius.md,
              fontSize: theme.typography.sizes.sm, color: theme.colors.text,
              backgroundColor: theme.colors.surface, outline: 'none',
            }}
          />
          <button onClick={handleRegenerate} disabled={!instruction.trim() || regenerating}
            style={{
              padding: `${theme.spacing.sm} ${theme.spacing.md}`,
              backgroundColor: instruction.trim() ? theme.colors.primary : theme.colors.secondary,
              color: instruction.trim() ? 'white' : theme.colors.textMuted,
              border: 'none', borderRadius: theme.borderRadius.md,
              cursor: instruction.trim() ? 'pointer' : 'default',
              fontWeight: theme.typography.weights.medium, fontSize: theme.typography.sizes.sm,
              whiteSpace: 'nowrap', opacity: regenerating ? 0.6 : 1,
            }}>
            {regenerating ? '...' : 'Přepsat'}
          </button>
        </div>
      )}
    </div>
  )
}
