'use client'

import { useState } from 'react'
import { Input, Textarea } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { theme } from '@/config/theme'
import type { ActionProposal } from '@/lib/supabase/types'

export interface EditFormProps {
  action: ActionProposal
  onSubmit: (data: { notes: string; dynamicFields: Record<string, string> }) => Promise<void>
  onCancel: () => void
}

export function EditForm({ action, onSubmit, onCancel }: EditFormProps) {
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)

  const missingInfo = (action.missing_info as { label: string; value: string | null }[] | null) || []

  // Detect SCHEDULE action with a hold event
  const payload = action.payload as Record<string, unknown> | null
  const payloadLocation = (payload?.location as string) || ''

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      await onSubmit({ notes, dynamicFields })
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
            {typeof payload?.location === 'string' && payload.location && (
              <p style={{
                fontSize: theme.typography.sizes.sm,
                color: theme.colors.textMuted,
                marginTop: theme.spacing.sm,
              }}>
                Místo: {payload.location}
              </p>
            )}
          </div>
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

      {/* Dynamic fields from missing_info */}
      {missingInfo.map((field, index) => (
        <Input
          key={index}
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
