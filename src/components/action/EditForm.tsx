'use client'

import { useState } from 'react'
import { Input, Textarea } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
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

  const missingInfo = (action.missing_info as { label: string; placeholder: string; value: string | null }[] | null) || []

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      await onSubmit({ notes, dynamicFields })
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
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
          placeholder={field.placeholder}
          value={dynamicFields[field.label] || ''}
          onChange={e => setDynamicFields({ ...dynamicFields, [field.label]: e.target.value })}
        />
      ))}

      <div className="flex gap-2 pt-2">
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
