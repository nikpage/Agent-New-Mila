'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTheme } from '@/contexts/ThemeContext'
import type { BriefAction } from './types'

interface ReplyCardProps {
  action: BriefAction
  token: string
  onRegenerateDraft: (instruction: string) => Promise<{ subject: string; body: string }>
  onSaveDraft: (data: { dynamicFields?: Record<string, string> }) => Promise<void>
  onConvertTodo?: (question: string) => Promise<void>
}

/** Item 19: Detect input type from label text */
function inferInputType(label: string): 'year' | 'boolean' | 'text' {
  const lower = label.toLowerCase()
  if (/\b(rok|year|ročník)\b/.test(lower)) return 'year'
  if (/\b(ano\/ne|ano nebo ne|yes\/no|souhlasí|boolean)\b/.test(lower)) return 'boolean'
  return 'text'
}

/** Item 50: Loading skeleton for draft */
function DraftSkeleton() {
  const theme = useTheme()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }}>
      <div style={{
        height: '14px', width: '120px', borderRadius: theme.borderRadius.sm,
        backgroundColor: theme.colors.secondary, animation: 'mila-skeleton-pulse 1.5s ease-in-out infinite',
      }} />
      <div style={{
        height: '38px', width: '100%', borderRadius: theme.borderRadius.md,
        backgroundColor: theme.colors.secondary, animation: 'mila-skeleton-pulse 1.5s ease-in-out infinite',
      }} />
      <div style={{
        height: '120px', width: '100%', borderRadius: theme.borderRadius.md,
        backgroundColor: theme.colors.secondary, animation: 'mila-skeleton-pulse 1.5s ease-in-out infinite',
      }} />
      <style>{`@keyframes mila-skeleton-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
    </div>
  )
}

export function ReplyCard({ action, token, onRegenerateDraft, onSaveDraft, onConvertTodo }: ReplyCardProps) {
  const theme = useTheme()
  const [draftSubject, setDraftSubject] = useState(action.draft_subject || '')
  const [draftBody, setDraftBody] = useState(action.draft_body_text || '')
  const [draftLoaded, setDraftLoaded] = useState(!!action.draft_body_text)
  const [loading, setLoading] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [regenerating, setRegenerating] = useState(false)
  const [todoLoading, setTodoLoading] = useState<string | null>(null)

  const summary = action.summaryJson
  const payload = action.payload as Record<string, unknown> | null
  const channel = (payload?.channel as string) || 'email'

  // Item 23: Last CP message — check summaryJson and payload for message preview
  const lastCpMessage = (payload?.last_cp_message as string) || ((summary as Record<string, unknown> | null)?.lastCpMessage as string) || null

  // Questions from AI
  const missingInfo = (action.missing_info as { label: string; value: string | null }[] | null) || []
  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const field of missingInfo) {
      if (field.value) initial[field.label] = field.value
    }
    return initial
  })

  // Item 22: Debounce draft save when answers change
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveAnswers = useCallback((updated: Record<string, string>) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      onSaveDraft({ dynamicFields: updated })
    }, 800)
  }, [onSaveDraft])

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

  // Item 20: Convert question to TODO
  async function handleConvertTodo(label: string) {
    if (!onConvertTodo) return
    setTodoLoading(label)
    try {
      await onConvertTodo(label)
    } finally {
      setTodoLoading(null)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
      {/* Item 23: Last CP message */}
      {lastCpMessage && (
        <div style={{
          padding: theme.spacing.md,
          backgroundColor: theme.colors.background,
          borderRadius: theme.borderRadius.md,
          borderLeft: `2px solid ${theme.colors.primaryLight}`,
        }}>
          <div style={{
            fontSize: theme.typography.sizes.xs, fontWeight: theme.typography.weights.semibold,
            color: theme.colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em',
            marginBottom: theme.spacing.xs,
          }}>
            Poslední zpráva
          </div>
          <div style={{
            fontSize: theme.typography.sizes.sm, color: theme.colors.text, lineHeight: 1.5,
            display: '-webkit-box', WebkitLineClamp: 4,
            WebkitBoxOrient: 'vertical' as const, overflow: 'hidden',
          }}>
            {lastCpMessage}
          </div>
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
          {missingInfo.map((field, i) => {
            const inputType = inferInputType(field.label)
            return (
              <div key={i}>
                <label style={{
                  display: 'block', fontSize: theme.typography.sizes.sm,
                  fontWeight: theme.typography.weights.medium, color: theme.colors.text,
                  marginBottom: '2px',
                }}>
                  {field.label}
                </label>
                <div style={{ display: 'flex', gap: theme.spacing.sm, alignItems: 'center' }}>
                  {/* Item 19: Smart input types */}
                  {inputType === 'boolean' ? (
                    <div style={{ display: 'flex', gap: theme.spacing.xs, flex: 1 }}>
                      {['Ano', 'Ne'].map(opt => (
                        <button
                          key={opt}
                          onClick={() => {
                            const updated = { ...answers, [field.label]: opt }
                            setAnswers(updated)
                            saveAnswers(updated)
                          }}
                          style={{
                            flex: 1, padding: `${theme.spacing.sm} ${theme.spacing.md}`,
                            backgroundColor: answers[field.label] === opt ? theme.colors.primary : theme.colors.surface,
                            color: answers[field.label] === opt ? 'white' : theme.colors.text,
                            border: `1.5px solid ${answers[field.label] === opt ? theme.colors.primary : theme.colors.border}`,
                            borderRadius: theme.borderRadius.md, cursor: 'pointer',
                            fontSize: theme.typography.sizes.sm, fontWeight: theme.typography.weights.medium,
                            transition: 'all 0.15s ease',
                          }}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <input
                      type={inputType === 'year' ? 'number' : 'text'}
                      min={inputType === 'year' ? 1900 : undefined}
                      max={inputType === 'year' ? 2100 : undefined}
                      value={answers[field.label] || ''}
                      onChange={e => {
                        const updated = { ...answers, [field.label]: e.target.value }
                        setAnswers(updated)
                        // Item 22: auto-save on change
                        saveAnswers(updated)
                      }}
                      onBlur={() => {
                        const updated = { ...answers }
                        if (updated[field.label]) onSaveDraft({ dynamicFields: updated })
                      }}
                      placeholder={inputType === 'year' ? 'Rok...' : 'Vaše odpověď...'}
                      style={{
                        flex: 1, padding: `${theme.spacing.sm} ${theme.spacing.md}`,
                        border: `1px solid ${theme.colors.border}`, borderRadius: theme.borderRadius.md,
                        fontSize: theme.typography.sizes.base, color: theme.colors.text,
                        backgroundColor: theme.colors.surface, outline: 'none',
                      }}
                    />
                  )}
                  {/* Item 20: "Zjistím" button per question */}
                  {onConvertTodo && (
                    <button
                      onClick={() => handleConvertTodo(field.label)}
                      disabled={todoLoading !== null}
                      title="Vytvořit úkol pro zjištění"
                      style={{
                        padding: `${theme.spacing.xs} ${theme.spacing.sm}`,
                        backgroundColor: theme.colors.secondary,
                        color: theme.colors.textMuted,
                        border: `1px solid ${theme.colors.border}`,
                        borderRadius: theme.borderRadius.md,
                        cursor: todoLoading ? 'default' : 'pointer',
                        fontSize: theme.typography.sizes.xs,
                        fontWeight: theme.typography.weights.medium,
                        whiteSpace: 'nowrap',
                        opacity: todoLoading === field.label ? 0.6 : 1,
                        flexShrink: 0,
                      }}
                    >
                      {todoLoading === field.label ? '...' : 'Zjistím'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Draft — Item 50: skeleton loader */}
      {!draftLoaded ? (
        loading ? <DraftSkeleton /> : null
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
