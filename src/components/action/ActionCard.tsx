'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Textarea } from '@/components/ui/Input'
import { Card } from '@/components/ui/Card'
import { TYPE_LABEL, TYPE_VARIANT } from './action-card-template'
import { theme } from '@/config/theme'
import type { ActionProposal, ConversationThread, CP, ConversationSummary } from '@/lib/supabase/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function daysIgnored(createdAt: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000))
}

function getIntent(action: ActionProposal): string {
  return action.intent_cs || action.rationale_cs || action.rationale
}

/**
 * Render intent text with bulleted lists.
 * Lines starting with "N." or "- " become <li> items; everything else is <p>.
 */
function renderIntent(text: string) {
  const lines = text.split('\n')
  const blocks: { type: 'text' | 'list'; lines: string[] }[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    const isListItem = /^\d+\.\s/.test(trimmed) || trimmed.startsWith('- ')
    const cleaned = isListItem ? trimmed.replace(/^\d+\.\s*/, '').replace(/^-\s*/, '') : trimmed

    if (isListItem) {
      const last = blocks[blocks.length - 1]
      if (last && last.type === 'list') {
        last.lines.push(cleaned)
      } else {
        blocks.push({ type: 'list', lines: [cleaned] })
      }
    } else if (trimmed.length > 0) {
      const last = blocks[blocks.length - 1]
      if (last && last.type === 'text') {
        last.lines.push(trimmed)
      } else {
        blocks.push({ type: 'text', lines: [trimmed] })
      }
    }
  }

  return blocks.map((block, i) => {
    if (block.type === 'list') {
      return (
        <ul key={i} style={{ margin: '8px 0', paddingLeft: '20px', listStyleType: 'disc' }}>
          {block.lines.map((item, j) => (
            <li key={j} style={{ marginBottom: '4px' }}>{item}</li>
          ))}
        </ul>
      )
    }
    return (
      <p key={i} style={{ margin: '4px 0' }}>{block.lines.join(' ')}</p>
    )
  })
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface Participant {
  name: string | null
  role: string | null
  primary_identifier: string
}

export interface ActionCardProps {
  action:        ActionProposal
  conversation:  ConversationThread
  cp:            CP
  recentMessage?: string
  participants?: Participant[]
  onDoIt:        () => Promise<void>
  onEdit:        (notes: string) => Promise<void>
  onIllDoIt:     () => Promise<void>
  onToDo?:       () => Promise<void>
  onBlacklist?:  () => Promise<void>
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ActionCard({
  action, conversation, cp, recentMessage,
  onDoIt, onEdit, onIllDoIt, onBlacklist,
}: ActionCardProps) {
  const [editOpen, setEditOpen]     = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [notes, setNotes]           = useState('')
  const [loading, setLoading]       = useState<string | null>(null)

  const summary  = conversation.summary_json as ConversationSummary | null
  const days     = daysIgnored(action.created_at)
  const adjValue = action.dollar_value * (action.offer_multiplier ?? 1)
  const intent   = getIntent(action)

  // Determine if UDĚLAT should be disabled:
  // Disabled when there are unfilled missing_info fields, UNLESS action has pre-blocked slots ready
  const missingInfoFields = (action.missing_info as { label: string; value: string | null }[] | null) || []
  const hasUnfilledFields = missingInfoFields.length > 0 && missingInfoFields.some(f => f.value === null || f.value === '')
  const actionPayload = action.payload as Record<string, unknown> | null
  const hasBlockedSlots = !!(actionPayload?.blocked_slots && Array.isArray(actionPayload.blocked_slots) && (actionPayload.blocked_slots as unknown[]).length > 0)
  const doItDisabled = hasUnfilledFields && !hasBlockedSlots

  const getUrgencyLabel = (urgency: number): string => {
    if (urgency >= 8) return 'TEĎ'
    if (urgency >= 4) return 'Zítra'
    return 'Později'
  }

  const run = (key: string, fn: () => Promise<void>) => async () => {
    setLoading(key)
    try { await fn() } finally { setLoading(null) }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
    <Card style={{ width: '100%', maxWidth: '672px', margin: '0 auto' }}>

      {/* ─── HEADER ────────────────────────────────────────────────── */}
      <div style={{ padding: `${theme.spacing.lg} ${theme.spacing.lg} ${theme.spacing.sm}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h2 style={{ fontSize: theme.typography.sizes.lg, fontWeight: theme.typography.weights.semibold, color: theme.colors.text }}>
              {cp.name || cp.primary_identifier}
              {cp.role && <span style={{ fontSize: theme.typography.sizes.sm, fontWeight: theme.typography.weights.normal, color: theme.colors.textMuted, marginLeft: theme.spacing.sm }}>· {cp.role}</span>}
            </h2>
            <p style={{ fontSize: theme.typography.sizes.sm, color: theme.colors.textMuted, marginTop: '2px' }}>
              {conversation.topic}
            </p>
          </div>
          <div style={{ display: 'flex', gap: theme.spacing.sm }}>
            <Badge variant={TYPE_VARIANT[action.action_type] || 'default'}>
              {TYPE_LABEL[action.action_type] || action.action_type}
            </Badge>
            <Badge variant="accent">
              {getUrgencyLabel(action.urgency)}
            </Badge>
          </div>
        </div>
      </div>

      {/* ─── MILA'S INTENT ─────────────────────────────────────────── */}
      <div style={{ padding: `0 ${theme.spacing.lg} ${theme.spacing.md}`, fontSize: theme.typography.sizes.base, color: theme.colors.text, lineHeight: 1.6 }}>
        {renderIntent(intent)}
      </div>

      {/* ─── DETAILS LINK ────────────────────────────────────────────── */}
      <div style={{ padding: `0 ${theme.spacing.lg} ${theme.spacing.md}` }}>
        <button
          onClick={() => setDetailOpen(true)}
          style={{
            fontSize: theme.typography.sizes.sm,
            color: theme.colors.textMuted,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: 0
          }}
        >
          <span>▸</span> Detaily
        </button>
      </div>

      {/* ─── EDIT PANEL ────────────────────────────────────────────── */}
      {editOpen && (
        <div style={{
          margin: `0 ${theme.spacing.lg} ${theme.spacing.sm}`,
          padding: theme.spacing.md,
          backgroundColor: theme.colors.secondary,
          borderRadius: theme.borderRadius.md,
          border: `1px solid ${theme.colors.border}`
        }}>
          <p style={{ fontSize: theme.typography.sizes.xs, fontWeight: theme.typography.weights.medium, color: theme.colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: theme.spacing.sm }}>
            Přidat poznámky nebo omezení
          </p>
          <Textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={3}
            placeholder="např. Nezapomeň zmínit, že bazén bude připraven pro jeho děti."
          />
          <div style={{ display: 'flex', gap: theme.spacing.sm, marginTop: theme.spacing.sm }}>
            <Button
              variant="primary"
              size="sm"
              onClick={run('edit-submit', async () => {
                await onEdit(notes)
                setEditOpen(false)
                setNotes('')
              })}
              loading={loading === 'edit-submit'}
              disabled={!notes.trim()}
            >
              Odeslat
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setEditOpen(false); setNotes('') }}
            >
              Zrušit
            </Button>
          </div>
        </div>
      )}

      {/* ─── ACTION CONTROLS ───────────────────────────────────────── */}
      <div style={{
        padding: `${theme.spacing.md} ${theme.spacing.lg}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderTop: `1px solid ${theme.colors.border}`
      }}>
        <div style={{ display: 'flex', gap: theme.spacing.sm }}>
          <Button
            variant={doItDisabled ? 'secondary' : 'primary'}
            onClick={run('doit', onDoIt)}
            loading={loading === 'doit'}
            disabled={doItDisabled}
            title={doItDisabled ? 'Nejdříve vyplňte požadované údaje přes UPRAVIT' : undefined}
            style={doItDisabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
          >
            UDĚLAT
          </Button>
          <Button variant="secondary" onClick={() => setEditOpen(!editOpen)}>
            UPRAVIT
          </Button>
          <Button variant="outline"  onClick={run('illdoit', onIllDoIt)} loading={loading === 'illdoit'}>
            UDĚLÁM SÁM
          </Button>
        </div>

        {onBlacklist && (
          <Button
            variant="ghost"
            size="sm"
            onClick={run('blacklist', async () => {
              if (confirm(`Zablokovat ${cp.name || cp.primary_identifier}? Nebudete dostávat další karty pro tento kontakt.`)) {
                await onBlacklist()
              }
            })}
            loading={loading === 'blacklist'}
            style={{ color: theme.colors.textMuted }}
          >
            Zablokovat CP
          </Button>
        )}
      </div>
    </Card>

    {/* ─── DETAILS MODAL ───────────────────────────────────────────── */}
    {detailOpen && (
      <div style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: theme.spacing.md
      }}>
        {/* Backdrop */}
        <div
          style={{ position: 'absolute', inset: 0, backgroundColor: theme.colors.overlay }}
          onClick={() => setDetailOpen(false)}
        />

        {/* Panel */}
        <div
          className="animate-fade-in"
          style={{
            position: 'relative',
            width: '100%',
            maxWidth: '512px',
            maxHeight: '85vh',
            overflowY: 'auto',
            padding: theme.spacing.lg,
            backgroundColor: theme.colors.surface,
            borderRadius: theme.borderRadius.lg,
            boxShadow: theme.shadows.modal,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.spacing.lg
          }}
          onClick={e => e.stopPropagation()}
        >
          {/* Title + close */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3 style={{ fontSize: theme.typography.sizes.base, fontWeight: theme.typography.weights.semibold, color: theme.colors.text }}>Detaily</h3>
            <button
              onClick={() => setDetailOpen(false)}
              style={{ fontSize: theme.typography.sizes.xl, color: theme.colors.textMuted, background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}
            >&times;</button>
          </div>

          {/* Why now */}
          <div>
            <p style={{ fontSize: theme.typography.sizes.xs, fontWeight: theme.typography.weights.medium, color: theme.colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: theme.spacing.xs }}>Proč teď</p>
            <p style={{ fontSize: theme.typography.sizes.sm, color: theme.colors.text }}>{action.rationale_cs || action.rationale}</p>
          </div>

          {/* Conversation snapshot */}
          {summary && (
            <div>
              <p style={{ fontSize: theme.typography.sizes.xs, fontWeight: theme.typography.weights.medium, color: theme.colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: theme.spacing.xs }}>Přehled konverzace</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: theme.typography.sizes.sm }}>
                <p>
                  <span style={{ color: theme.colors.textMuted }}>Stav:</span>{' '}
                  <span style={{ color: theme.colors.text }}>{summary.currentState}</span>
                </p>
                {summary.risks?.length > 0 && (
                  <p>
                    <span style={{ color: theme.colors.accent }}>Riziko:</span>{' '}
                    <span style={{ color: theme.colors.text }}>{summary.risks.join(' · ')}</span>
                  </p>
                )}
                {summary.nextSteps?.length > 0 && (
                  <p>
                    <span style={{ color: theme.colors.success }}>Další:</span>{' '}
                    <span style={{ color: theme.colors.text }}>{summary.nextSteps.join(' · ')}</span>
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Last message from CP */}
          {recentMessage && (
            <div>
              <p style={{ fontSize: theme.typography.sizes.xs, fontWeight: theme.typography.weights.medium, color: theme.colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: theme.spacing.xs }}>
                Poslední zpráva od {cp.name || cp.primary_identifier}
              </p>
              <p style={{ fontSize: theme.typography.sizes.sm, color: theme.colors.text, whiteSpace: 'pre-wrap' }}>{recentMessage}</p>
            </div>
          )}

          {/* Scoring breakdown */}
          <div>
            <p style={{ fontSize: theme.typography.sizes.xs, fontWeight: theme.typography.weights.medium, color: theme.colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: theme.spacing.sm }}>Hodnocení</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: `${theme.spacing.sm} ${theme.spacing.md}`, fontSize: theme.typography.sizes.sm }}>
              <div>
                <p style={{ color: theme.colors.textMuted }}>Hodnota</p>
                <p style={{ color: theme.colors.text, fontWeight: theme.typography.weights.medium }}>{adjValue.toLocaleString()} Kč</p>
              </div>
              <div>
                <p style={{ color: theme.colors.textMuted }}>Naléhavost</p>
                <p style={{ color: theme.colors.text, fontWeight: theme.typography.weights.medium }}>{action.urgency}/10</p>
              </div>
              <div>
                <p style={{ color: theme.colors.textMuted }}>Bolest</p>
                <p style={{ color: theme.colors.text, fontWeight: theme.typography.weights.medium }}>{action.pain_factor}/10</p>
              </div>
              <div>
                <p style={{ color: theme.colors.textMuted }}>Dní ignorováno</p>
                <p style={{ color: theme.colors.text, fontWeight: theme.typography.weights.medium }}>{days}</p>
              </div>
              <div>
                <p style={{ color: theme.colors.textMuted }}>Váha</p>
                <p style={{ color: theme.colors.text, fontWeight: theme.typography.weights.medium }}>{action.weight ?? 0}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
