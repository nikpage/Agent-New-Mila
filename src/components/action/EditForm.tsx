'use client'

import { useState } from 'react'
import { Input, Textarea } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { theme } from '@/config/theme'
import type { ActionProposal } from '@/lib/supabase/types'

export type MeetingType = 'address' | 'online' | 'phone'

export interface EditFormProps {
  action: ActionProposal
  onSubmit: (data: { notes: string; dynamicFields: Record<string, string>; meetingType?: MeetingType }) => Promise<void>
  onCancel: () => void
}

export function EditForm({ action, onSubmit, onCancel }: EditFormProps) {
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)

  const missingInfo = (action.missing_info as { label: string; value: string | null }[] | null) || []

  // Detect SCHEDULE action with a hold event
  const payload = action.payload as Record<string, unknown> | null
  const payloadLocation = (payload?.location as string) || ''
  const locationPartial = !!payload?.location_partial
  const [meetingType, setMeetingType] = useState<MeetingType>(
    (payload?.meeting_type as MeetingType) || (payload?.is_online ? 'online' : 'address')
  )

  // Fixed key for the always-present address input on SCHEDULE cards
  const ADDRESS_FIELD_KEY = 'Adresa schůzky'

  // Pre-populate dynamic fields from payload (e.g. location field from payload.location)
  const [dynamicFields, setDynamicFields] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    // Always pre-fill the address field from payload.location for SCHEDULE actions
    if (action.action_type === 'SCHEDULE' && payloadLocation) {
      initial[ADDRESS_FIELD_KEY] = payloadLocation
    }
    for (const field of missingInfo) {
      if (field.label.includes('adresa') && payloadLocation) {
        initial[field.label] = payloadLocation
      }
    }
    return initial
  })
  const holdStart = payload?.start as string | undefined
  const holdEnd = payload?.end as string | undefined
  const isScheduleWithHold = action.action_type === 'SCHEDULE' && holdStart && holdEnd
  const isSchedule = action.action_type === 'SCHEDULE'

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      await onSubmit({ notes, dynamicFields, meetingType: isSchedule ? meetingType : undefined })
    } finally {
      setLoading(false)
    }
  }

  // Format the single hold slot for display
  const formatHoldSlot = () => {
    if (!holdStart || !holdEnd) return ''
    const start = new Date(holdStart)
    const end = new Date(holdEnd)
    const dateStr = start.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long' })
    const startStr = start.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false })
    const endStr = end.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false })
    return `${dateStr}, ${startStr} - ${endStr}`
  }

  // For SCHEDULE actions, address is handled by the always-present ADDRESS_FIELD_KEY input.
  // Non-location fields from missing_info are rendered separately below.
  const nonLocationFields = missingInfo.filter(f => !f.label.includes('adresa'))

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>

      {/* Single hold slot display for SCHEDULE actions */}
      {isScheduleWithHold && (
        <div>
          <p style={{
            fontSize: theme.typography.sizes.xs,
            fontWeight: theme.typography.weights.medium,
            color: theme.colors.textMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: theme.spacing.sm,
          }}>
            Navržený termín
          </p>
          <div style={{
            backgroundColor: theme.colors.secondary,
            borderRadius: theme.borderRadius.md,
            padding: theme.spacing.md,
            marginBottom: theme.spacing.sm,
          }}>
            <p style={{
              fontSize: theme.typography.sizes.sm,
              color: theme.colors.text,
              margin: 0,
              lineHeight: 1.6,
            }}>
              {formatHoldSlot()}
            </p>
          </div>
        </div>
      )}

      {/* Meeting type selector for SCHEDULE actions */}
      {isSchedule && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
          <p style={{
            fontSize: theme.typography.sizes.xs,
            fontWeight: theme.typography.weights.medium,
            color: theme.colors.textMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            margin: 0,
          }}>
            Typ schůzky
          </p>
          <div style={{ display: 'flex', gap: theme.spacing.sm }}>
            {([
              { value: 'address' as MeetingType, label: 'Osobně' },
              { value: 'online' as MeetingType, label: 'Online (Meet)' },
              { value: 'phone' as MeetingType, label: 'Telefonát' },
            ]).map(opt => (
              <label key={opt.value} style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                cursor: 'pointer',
                fontSize: theme.typography.sizes.sm,
                color: theme.colors.text,
                fontWeight: meetingType === opt.value ? theme.typography.weights.medium : theme.typography.weights.normal,
              }}>
                <input
                  type="radio"
                  name="meetingType"
                  value={opt.value}
                  checked={meetingType === opt.value}
                  onChange={() => setMeetingType(opt.value)}
                  style={{ width: '16px', height: '16px', accentColor: theme.colors.primary, cursor: 'pointer' }}
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Address field — ALWAYS shown for SCHEDULE actions, disabled when not in-person */}
      {isSchedule && (
        <div>
          <Input
            label={ADDRESS_FIELD_KEY}
            value={meetingType !== 'address' ? '' : (dynamicFields[ADDRESS_FIELD_KEY] || '')}
            onChange={e => setDynamicFields({ ...dynamicFields, [ADDRESS_FIELD_KEY]: e.target.value })}
            disabled={meetingType !== 'address'}
            placeholder={meetingType !== 'address' ? '' : 'např. Dykova 17, Praha 2'}
            style={meetingType !== 'address' ? { opacity: 0.4 } : locationPartial && !dynamicFields[ADDRESS_FIELD_KEY] ? {
              borderColor: theme.colors.warning,
              backgroundColor: theme.colors.warningBg,
            } : undefined}
          />
          {locationPartial && meetingType === 'address' && !dynamicFields[ADDRESS_FIELD_KEY] && (
            <p style={{
              fontSize: theme.typography.sizes.xs,
              color: theme.colors.warning,
              marginTop: '4px',
            }}>
              ⚠ Mila nemohla ověřit toto místo. Upřesněte adresu.
            </p>
          )}
        </div>
      )}

      {/* Persistent field: General notes */}
      <Textarea
        label="Obecné poznámky nebo omezení"
        value={notes}
        onChange={e => setNotes(e.target.value)}
        rows={4}
        placeholder="např. Nezapomeň zmínit, že bazén bude připraven pro jeho děti."
      />

      {/* Non-location dynamic fields from missing_info */}
      {nonLocationFields.map((field, index) => (
        <Input
          key={index}
          label={field.label}
          value={dynamicFields[field.label] || ''}
          onChange={e => setDynamicFields({ ...dynamicFields, [field.label]: e.target.value })}
        />
      ))}

      {/* Location fields for non-SCHEDULE actions (rendered normally from missing_info) */}
      {!isSchedule && missingInfo.filter(f => f.label.includes('adresa')).map((field, index) => (
        <Input
          key={`loc-ns-${index}`}
          label={field.label}
          value={dynamicFields[field.label] || ''}
          onChange={e => setDynamicFields({ ...dynamicFields, [field.label]: e.target.value })}
        />
      ))}

      <div style={{ display: 'flex', gap: theme.spacing.sm, paddingTop: theme.spacing.sm }}>
        <Button
          type="submit"
          variant="primary"
          loading={loading}
        >
          Uložit
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
        >
          Zrušit
        </Button>
      </div>
    </form>
  )
}
