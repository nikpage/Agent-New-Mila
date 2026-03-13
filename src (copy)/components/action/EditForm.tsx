'use client'

import { useState } from 'react'
import { Input, Textarea } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { theme } from '@/config/theme'
import type { ActionProposal } from '@/lib/supabase/types'

export interface EditFormProps {
  action: ActionProposal
  onSubmit: (data: { notes: string; dynamicFields: Record<string, string>; isOnline?: boolean }) => Promise<void>
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
  const [isOnline, setIsOnline] = useState(!!payload?.is_online)

  // Pre-populate dynamic fields from payload (e.g. location field from payload.location)
  const [dynamicFields, setDynamicFields] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
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
      await onSubmit({ notes, dynamicFields, isOnline: isSchedule ? isOnline : undefined })
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

  // Location fields are address-related fields from missing_info
  const locationFields = missingInfo.filter(f => f.label.includes('adresa'))
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

      {/* Online checkbox for SCHEDULE actions */}
      {isSchedule && (
        <label style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.spacing.sm,
          cursor: 'pointer',
          fontSize: theme.typography.sizes.sm,
          color: theme.colors.text,
        }}>
          <input
            type="checkbox"
            checked={isOnline}
            onChange={e => setIsOnline(e.target.checked)}
            style={{ width: '18px', height: '18px', accentColor: theme.colors.primary, cursor: 'pointer' }}
          />
          <span style={{ fontWeight: isOnline ? theme.typography.weights.medium : theme.typography.weights.normal }}>
            Online schůzka (Google Meet)
          </span>
        </label>
      )}

      {/* Location fields — disabled when Online is checked */}
      {isSchedule && locationFields.map((field, index) => (
        <div key={`loc-${index}`}>
          <Input
            label={field.label}
            value={isOnline ? '' : (dynamicFields[field.label] || '')}
            onChange={e => setDynamicFields({ ...dynamicFields, [field.label]: e.target.value })}
            disabled={isOnline}
            style={isOnline ? { opacity: 0.4 } : locationPartial && !dynamicFields[field.label] ? {
              borderColor: theme.colors.warning,
              backgroundColor: theme.colors.warningBg,
            } : undefined}
          />
          {locationPartial && !isOnline && !dynamicFields[field.label] && (
            <p style={{
              fontSize: theme.typography.sizes.xs,
              color: theme.colors.warning,
              marginTop: '4px',
            }}>
              ⚠ Mila nemohla ověřit toto místo. Upřesněte adresu.
            </p>
          )}
        </div>
      ))}

      {/* Show inline location for SCHEDULE actions without an address field in missing_info */}
      {isSchedule && locationFields.length === 0 && payloadLocation && !isOnline && (
        <div style={{
          fontSize: theme.typography.sizes.sm,
          padding: theme.spacing.sm,
          borderRadius: theme.borderRadius.md,
          backgroundColor: locationPartial ? theme.colors.warningBg : theme.colors.secondary,
          border: locationPartial ? `1px solid ${theme.colors.warning}` : 'none',
        }}>
          <span style={{ color: theme.colors.textMuted }}>Místo: </span>
          <span style={{ color: locationPartial ? theme.colors.warning : theme.colors.text, fontWeight: locationPartial ? theme.typography.weights.medium : theme.typography.weights.normal }}>
            {payloadLocation}
          </span>
          {locationPartial && (
            <p style={{ fontSize: theme.typography.sizes.xs, color: theme.colors.warning, marginTop: '4px', marginBottom: 0 }}>
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

      {/* Location fields for non-SCHEDULE actions (rendered normally) */}
      {!isSchedule && locationFields.map((field, index) => (
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
