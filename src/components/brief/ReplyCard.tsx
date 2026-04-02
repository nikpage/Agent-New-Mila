'use client'

import { useState, useEffect } from 'react'
import { theme } from '@/config/theme'
import type { BriefAction } from './types'

interface ReplyCardProps {
  action: BriefAction
  token: string
  onRegenerateDraft: (instruction: string) => Promise<{ subject: string; body: string }>
}

export function ReplyCard({ action, token, onRegenerateDraft }: ReplyCardProps) {
  const [draftSubject, setDraftSubject] = useState(action.draft_subject || '')
  const [draftBody, setDraftBody] = useState(action.draft_body_text || '')
  const [draftLoaded, setDraftLoaded] = useState(!!action.draft_body_text)
  const [loading, setLoading] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [regenerating, setRegenerating] = useState(false)

  const summary = action.summaryJson
  const payload = action.payload as Record<string, unknown> | null
  const channel = (payload?.channel as string) || 'email'

  // Questions from AI
  const missingInfo = (action.missing_info as { label: string; value: string | null }[] | null) || []
  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const field of missingInfo) {
      if (field.value) initial[field.label] = field.value
    }
    return initial
  })

  // Auto-load draft on mount
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
        setDraftSubject(data.subject || '')
        setDraftBody(data.body || '')
        setDraftLoaded(true)
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [action.id, token, draftLoaded])

  async function handleRegenerate() {
    if (!instruction.trim()) return
    setRegenerating(true)
    try {
      const result = await onRegenerateDraft(instruction.trim())
      setDraftSubject(result.subject)
      setDraftBody(result.body)
      setInstruction('')
    } finally {
      setRegenerating(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
      {/* Deal context — compact */}
      {summary?.currentState && (
        <div style={{
          fontSize: theme.typography.sizes.sm,
          color: theme.colors.textMuted,
          lineHeight: 1.6,
          borderLeft: `2px solid ${theme.colors.border}`,
          paddingLeft: theme.spacing.md,
        }}>
          {summary.currentState}
        </div>
      )}

      {/* Questions form */}
      {missingInfo.length > 0 && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: theme.spacing.sm,
          padding: theme.spacing.md,
          backgroundColor: theme.colors.background,
          borderRadius: theme.borderRadius.md,
        }}>
          <div style={{
            fontSize: theme.typography.sizes.xs, fontWeight: theme.typography.weights.semibold,
            color: theme.colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>
            Protistrana se ptá
          </div>
          {missingInfo.map((field, i) => (
            <div key={i}>
              <label style={{
                display: 'block', fontSize: theme.typography.sizes.sm,
                fontWeight: theme.typography.weights.medium, color: theme.colors.text,
                marginBottom: '2px',
              }}>
                {field.label}
              </label>
              <input
                type="text"
                value={answers[field.label] || ''}
                onChange={e => setAnswers({ ...answers, [field.label]: e.target.value })}
                placeholder="Vaše odpověď..."
                style={{
                  width: '100%', padding: `${theme.spacing.sm} ${theme.spacing.md}`,
                  border: `1px solid ${theme.colors.border}`, borderRadius: theme.borderRadius.md,
                  fontSize: theme.typography.sizes.base, color: theme.colors.text,
                  backgroundColor: theme.colors.surface, outline: 'none',
                }}
              />
            </div>
          ))}
        </div>
      )}

      {/* Draft */}
      {!draftLoaded ? (
        <div style={{
          padding: theme.spacing.lg, textAlign: 'center',
          color: theme.colors.textMuted, fontSize: theme.typography.sizes.sm,
        }}>
          {loading ? 'Mila připravuje koncept...' : ''}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }}>
          <div style={{
            fontSize: theme.typography.sizes.xs, fontWeight: theme.typography.weights.semibold,
            color: theme.colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>
            Koncept {channel === 'whatsapp' ? 'zprávy' : 'emailu'}
          </div>
          {channel !== 'whatsapp' && (
            <input
              type="text"
              value={draftSubject}
              onChange={e => setDraftSubject(e.target.value)}
              style={{
                width: '100%', padding: `${theme.spacing.sm} ${theme.spacing.md}`,
                border: `1px solid ${theme.colors.border}`, borderRadius: theme.borderRadius.md,
                fontSize: theme.typography.sizes.sm, color: theme.colors.text,
                backgroundColor: theme.colors.surface, outline: 'none',
              }}
            />
          )}
          <textarea
            value={draftBody}
            onChange={e => setDraftBody(e.target.value)}
            rows={6}
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

      {/* Instruction field */}
      {draftLoaded && (
        <div style={{ display: 'flex', gap: theme.spacing.sm }}>
          <input
            type="text"
            value={instruction}
            onChange={e => setInstruction(e.target.value)}
            placeholder="Změnit koncept..."
            onKeyDown={e => e.key === 'Enter' && handleRegenerate()}
            style={{
              flex: 1, padding: `${theme.spacing.sm} ${theme.spacing.md}`,
              border: `1px solid ${theme.colors.border}`, borderRadius: theme.borderRadius.md,
              fontSize: theme.typography.sizes.sm, color: theme.colors.text,
              backgroundColor: theme.colors.surface, outline: 'none',
            }}
          />
          <button
            onClick={handleRegenerate}
            disabled={!instruction.trim() || regenerating}
            style={{
              padding: `${theme.spacing.sm} ${theme.spacing.md}`,
              backgroundColor: instruction.trim() ? theme.colors.primary : theme.colors.secondary,
              color: instruction.trim() ? 'white' : theme.colors.textMuted,
              border: 'none', borderRadius: theme.borderRadius.md,
              cursor: instruction.trim() ? 'pointer' : 'default',
              fontWeight: theme.typography.weights.medium, fontSize: theme.typography.sizes.sm,
              whiteSpace: 'nowrap', opacity: regenerating ? 0.6 : 1,
            }}
          >
            {regenerating ? '...' : 'Přepsat'}
          </button>
        </div>
      )}
    </div>
  )
}
