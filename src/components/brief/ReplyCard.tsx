'use client'

import { useState } from 'react'
import { theme } from '@/config/theme'
import type { BriefAction } from './types'

interface ReplyCardProps {
  action: BriefAction
  token: string
  onExecute: () => Promise<void>
  onConvertTodo: () => Promise<void>
  onRegenerateDraft: (instruction: string) => Promise<{ subject: string; body: string }>
}

export function ReplyCard({ action, token, onExecute, onConvertTodo, onRegenerateDraft }: ReplyCardProps) {
  const [loading, setLoading] = useState<string | null>(null)
  const [draftSubject, setDraftSubject] = useState(action.draft_subject || '')
  const [draftBody, setDraftBody] = useState(action.draft_body_text || '')
  const [draftLoaded, setDraftLoaded] = useState(!!action.draft_body_text)
  const [instruction, setInstruction] = useState('')
  const [regenerating, setRegenerating] = useState(false)

  const summary = action.summaryJson
  const intent = action.intent_cs || action.rationale_cs || action.rationale
  const payload = action.payload as Record<string, unknown> | null
  const channel = (payload?.channel as string) || 'email'

  // Missing info / questions from AI
  const missingInfo = (action.missing_info as { label: string; value: string | null }[] | null) || []
  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const field of missingInfo) {
      if (field.value) initial[field.label] = field.value
    }
    return initial
  })

  // Load draft on-demand if not pre-loaded
  async function loadDraft() {
    setLoading('draft')
    try {
      const res = await fetch(`/api/action/${action.id}/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (res.ok) {
        const data = await res.json()
        setDraftSubject(data.subject || '')
        setDraftBody(data.body || '')
        setDraftLoaded(true)
      }
    } finally {
      setLoading(null)
    }
  }

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

  async function handleSend() {
    setLoading('send')
    try {
      // Save draft edits first
      await fetch(`/api/action/${action.id}/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, subject: draftSubject, body: draftBody }),
      })
      await onExecute()
    } finally {
      setLoading(null)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
      {/* Deal narrative */}
      {summary?.currentState && (
        <div style={{ fontSize: theme.typography.sizes.sm, color: theme.colors.textMuted, lineHeight: 1.6 }}>
          {summary.currentState}
        </div>
      )}

      {/* Questions form — primary content if questions exist */}
      {missingInfo.length > 0 && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: theme.spacing.sm,
          padding: theme.spacing.md,
          backgroundColor: theme.colors.secondary,
          borderRadius: theme.borderRadius.md,
        }}>
          <div style={{
            fontSize: theme.typography.sizes.xs,
            fontWeight: theme.typography.weights.medium,
            color: theme.colors.textMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}>
            Protistrana se ptá
          </div>
          {missingInfo.map((field, i) => (
            <div key={i}>
              <label style={{
                display: 'block',
                fontSize: theme.typography.sizes.sm,
                fontWeight: theme.typography.weights.medium,
                color: theme.colors.text,
                marginBottom: theme.spacing.xs,
              }}>
                {field.label}
              </label>
              <input
                type="text"
                value={answers[field.label] || ''}
                onChange={e => setAnswers({ ...answers, [field.label]: e.target.value })}
                placeholder="Vaše odpověď..."
                style={{
                  width: '100%',
                  padding: `${theme.spacing.sm} ${theme.spacing.md}`,
                  border: `1px solid ${theme.colors.border}`,
                  borderRadius: theme.borderRadius.md,
                  fontSize: theme.typography.sizes.base,
                  color: theme.colors.text,
                  backgroundColor: theme.colors.surface,
                  outline: 'none',
                }}
              />
            </div>
          ))}
        </div>
      )}

      {/* Draft — visible below questions */}
      {!draftLoaded ? (
        <button
          onClick={loadDraft}
          disabled={loading === 'draft'}
          style={{
            padding: theme.spacing.md,
            backgroundColor: theme.colors.secondary,
            border: `1px dashed ${theme.colors.border}`,
            borderRadius: theme.borderRadius.md,
            cursor: 'pointer',
            color: theme.colors.textMuted,
            fontSize: theme.typography.sizes.sm,
            textAlign: 'center',
          }}
        >
          {loading === 'draft' ? 'Generuji koncept...' : 'Zobrazit koncept zprávy'}
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }}>
          <div style={{
            fontSize: theme.typography.sizes.xs,
            fontWeight: theme.typography.weights.medium,
            color: theme.colors.textMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}>
            Koncept {channel === 'whatsapp' ? 'zprávy' : 'emailu'}
          </div>
          {channel !== 'whatsapp' && (
            <input
              type="text"
              value={draftSubject}
              onChange={e => setDraftSubject(e.target.value)}
              style={{
                width: '100%',
                padding: `${theme.spacing.sm} ${theme.spacing.md}`,
                border: `1px solid ${theme.colors.border}`,
                borderRadius: theme.borderRadius.md,
                fontSize: theme.typography.sizes.sm,
                color: theme.colors.text,
                backgroundColor: theme.colors.surface,
                outline: 'none',
              }}
            />
          )}
          <textarea
            value={draftBody}
            onChange={e => setDraftBody(e.target.value)}
            rows={8}
            style={{
              width: '100%',
              padding: theme.spacing.md,
              border: `1px solid ${theme.colors.border}`,
              borderRadius: theme.borderRadius.md,
              fontSize: theme.typography.sizes.base,
              color: theme.colors.text,
              backgroundColor: theme.colors.surface,
              outline: 'none',
              resize: 'vertical',
              lineHeight: 1.6,
              fontFamily: theme.typography.fontFamily,
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
            placeholder='Chceš něco změnit? např. "Připomeň bazén pro děti"'
            onKeyDown={e => e.key === 'Enter' && handleRegenerate()}
            style={{
              flex: 1,
              padding: `${theme.spacing.sm} ${theme.spacing.md}`,
              border: `1px solid ${theme.colors.border}`,
              borderRadius: theme.borderRadius.md,
              fontSize: theme.typography.sizes.sm,
              color: theme.colors.text,
              backgroundColor: theme.colors.surface,
              outline: 'none',
            }}
          />
          <button
            onClick={handleRegenerate}
            disabled={!instruction.trim() || regenerating}
            style={{
              padding: `${theme.spacing.sm} ${theme.spacing.md}`,
              backgroundColor: instruction.trim() ? theme.colors.primary : theme.colors.secondary,
              color: instruction.trim() ? 'white' : theme.colors.textMuted,
              border: 'none',
              borderRadius: theme.borderRadius.md,
              cursor: instruction.trim() ? 'pointer' : 'default',
              fontWeight: theme.typography.weights.medium,
              fontSize: theme.typography.sizes.sm,
              whiteSpace: 'nowrap',
              opacity: regenerating ? 0.6 : 1,
            }}
          >
            {regenerating ? '...' : 'Přepsat'}
          </button>
        </div>
      )}

      {/* CTAs */}
      <div style={{
        display: 'flex',
        gap: theme.spacing.sm,
        paddingTop: theme.spacing.sm,
        borderTop: `1px solid ${theme.colors.border}`,
      }}>
        <button
          onClick={handleSend}
          disabled={loading !== null || !draftBody.trim()}
          style={{
            padding: `${theme.spacing.sm} ${theme.spacing.lg}`,
            backgroundColor: draftBody.trim() ? theme.colors.primary : theme.colors.secondary,
            color: draftBody.trim() ? 'white' : theme.colors.textMuted,
            border: 'none',
            borderRadius: theme.borderRadius.md,
            cursor: draftBody.trim() ? 'pointer' : 'not-allowed',
            fontWeight: theme.typography.weights.medium,
            fontSize: theme.typography.sizes.base,
            opacity: loading === 'send' ? 0.6 : 1,
          }}
        >
          {loading === 'send' ? 'Odesílám...' : 'Odeslat'}
        </button>

        <button
          onClick={async () => { setLoading('todo'); try { await onConvertTodo() } finally { setLoading(null) } }}
          disabled={loading !== null}
          style={{
            padding: `${theme.spacing.sm} ${theme.spacing.lg}`,
            backgroundColor: theme.colors.secondary,
            color: theme.colors.text,
            border: 'none',
            borderRadius: theme.borderRadius.md,
            cursor: 'pointer',
            fontWeight: theme.typography.weights.medium,
            fontSize: theme.typography.sizes.base,
          }}
        >
          Úkol
        </button>
      </div>
    </div>
  )
}
