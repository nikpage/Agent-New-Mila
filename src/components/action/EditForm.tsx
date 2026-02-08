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
  const [dynamicFields, setDynamicFields] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)

  const missingInfo = (action.missing_info as { label: string; value: string | null }[] | null) || []

  // Detect SCHEDULE action with pre-blocked slots
  const payload = action.payload as Record<string, unknown> | null
  const blockedSlots = payload?.blocked_slots as { id: string; start: string; end: string; location?: string }[] | undefined
  const isScheduleWithSlots = action.action_type === 'SCHEDULE' && blockedSlots && blockedSlots.length > 0

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      await onSubmit({ notes, dynamicFields })
    } finally {
      setLoading(false)
    }
  }

  // Format slot for display
  const formatSlot = (slot: { start: string; end: string; location?: string }, index: number) => {
    const start = new Date(slot.start)
    const end = new Date(slot.end)
    const dateStr = start.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long' })
    const startStr = start.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false })
    const endStr = end.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false })
    return `${index + 1}. ${dateStr}, ${startStr} - ${endStr}`
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>

      {/* Slot selection for SCHEDULE actions with pre-blocked slots */}
      {isScheduleWithSlots && (
        <div>
          <p style={{
            fontSize: theme.typography.sizes.xs,
            fontWeight: theme.typography.weights.medium,
            color: theme.colors.textMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: theme.spacing.sm,
          }}>
            Nabízené termíny
          </p>
          <div style={{
            backgroundColor: theme.colors.secondary,
            borderRadius: theme.borderRadius.md,
            padding: theme.spacing.md,
            marginBottom: theme.spacing.sm,
          }}>
            {blockedSlots!.map((slot, i) => (
              <p key={i} style={{
                fontSize: theme.typography.sizes.sm,
                color: theme.colors.text,
                margin: i === 0 ? 0 : `${theme.spacing.xs} 0 0 0`,
                lineHeight: 1.6,
              }}>
                {formatSlot(slot, i)}
              </p>
            ))}
            {payload?.location && (
              <p style={{
                fontSize: theme.typography.sizes.sm,
                color: theme.colors.textMuted,
                marginTop: theme.spacing.sm,
              }}>
                Místo: {payload.location as string}
              </p>
            )}
          </div>
          <Input
            label="Vyberte termín(y)"
            value={dynamicFields['slotSelection'] || ''}
            onChange={e => setDynamicFields({ ...dynamicFields, slotSelection: e.target.value })}
            placeholder="Číslo (1, 2, 3), 'vše', nebo vlastní čas (např. 'přeplánuj na středu v 16')"
          />
          <p style={{
            fontSize: theme.typography.sizes.xs,
            color: theme.colors.textMuted,
            marginTop: theme.spacing.xs,
          }}>
            Napište čísla termínů k odeslání, &quot;vše&quot; pro všechny, nebo vlastní pokyn k přeplánování.
          </p>
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
