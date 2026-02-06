'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Textarea } from '@/components/ui/Input'
import type { ActionProposal, ConversationThread, CP, ConversationSummary } from '@/lib/supabase/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function daysIgnored(createdAt: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000))
}

const TYPE_LABEL: Record<string, string> = {
  REPLY: 'Odpověď', SCHEDULE: 'Schůzka', WAIT: 'Čekat', FILE: 'Úkol', DELEGATE: 'Delegovat', CALL: 'Hovor',
}

const TYPE_VARIANT: Record<string, 'accent' | 'warning' | 'success' | 'default'> = {
  REPLY: 'accent', SCHEDULE: 'warning', WAIT: 'default', FILE: 'success', DELEGATE: 'warning', CALL: 'accent',
}

// ─── Intent extraction ────────────────────────────────────────────────────────
// Primary source: intent_cs (Mila's plan summary in Czech)
// Fallback: rationale_cs, then rationale

function getIntent(action: ActionProposal): string {
  return action.intent_cs || action.rationale_cs || action.rationale
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
  participants?: Participant[]       // available for future contexts; not rendered on card surface
  onDoIt:        () => Promise<void>
  onEdit:        (notes: string) => Promise<void>
  onIllDoIt:     () => Promise<void>
  onToDo?:       () => Promise<void> // kept optional for backward compat; not used by this card
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
    <div className="card w-full max-w-2xl mx-auto">

      {/* ─── HEADER ────────────────────────────────────────────────── */}
      <div className="px-6 pt-5 pb-3">
        <div className="flex justify-between items-start">
          <div>
            <h2 className="text-lg font-semibold text-text">
              {cp.name || cp.primary_identifier}
              {cp.role && <span className="text-sm font-normal text-text-muted ml-2">· {cp.role}</span>}
            </h2>
            <p className="text-sm text-text-muted mt-0.5">
              {conversation.topic}
            </p>
          </div>
          <div className="flex gap-2">
            <Badge variant={TYPE_VARIANT[action.action_type] || 'default'}>
              {TYPE_LABEL[action.action_type] || action.action_type}
            </Badge>
            <Badge variant="accent">
              {getUrgencyLabel(action.urgency)}
            </Badge>
          </div>
        </div>
      </div>

      {/* ─── MILA'S INTENT (primary text — the heart of the card) ───── */}
      <div className="px-6 pb-4">
        <p className="text-base text-text leading-relaxed">
          {intent}
        </p>
      </div>

      {/* ─── DETAILS LINK ────────────────────────────────────────────── */}
      <div className="px-6 pb-4">
        <button
          onClick={() => setDetailOpen(true)}
          className="text-sm text-text-muted hover:text-text transition-colors flex items-center gap-1.5"
        >
          <span>▸</span> Detaily
        </button>
      </div>

      {/* ─── EDIT PANEL (notes / constraints only — no draft here) ──── */}
      {editOpen && (
        <div className="mx-6 mb-2 p-4 bg-primary-dark rounded-md border border-border">
          <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2">
            Přidat poznámky nebo omezení
          </p>
          <Textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={3}
            placeholder="např. Nezapomeň zmínit, že bazén bude připraven pro jeho děti."
          />
          <div className="flex gap-2 mt-3">
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

      {/* ─── ACTION CONTROLS (decision layer) ───────────────────────── */}
      <div className="px-6 py-4 flex items-center justify-between">
        <div className="flex gap-2">
          <Button variant="primary"  onClick={run('doit', onDoIt)}      loading={loading === 'doit'}>
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
            className="text-text-muted"
          >
            Zablokovat CP
          </Button>
        )}
      </div>
    </div>

    {/* ─── DETAILS MODAL (desktop) / SLIDE-UP (mobile) ────────────── */}
    {detailOpen && (
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
        {/* Backdrop */}
        <div className="absolute inset-0 bg-black/60" onClick={() => setDetailOpen(false)} />

        {/* Panel */}
        <div
          className="card relative w-full sm:max-w-lg max-h-[85vh] overflow-y-auto
                     p-6 space-y-5
                     rounded-t-2xl sm:rounded-lg
                     animate-slide-up sm:animate-fade-in"
          onClick={e => e.stopPropagation()}
        >
          {/* Title + close */}
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-text">Detaily</h3>
            <button
              onClick={() => setDetailOpen(false)}
              className="text-text-muted hover:text-text text-xl leading-none"
            >&times;</button>
          </div>

          {/* Why now */}
          <div>
            <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-1.5">Proč teď</p>
            <p className="text-sm text-text">{action.rationale_cs || action.rationale}</p>
          </div>

          {/* Conversation snapshot */}
          {summary && (
            <div>
              <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-1.5">Přehled konverzace</p>
              <div className="space-y-1 text-sm">
                <p>
                  <span className="text-text-muted">Stav:</span>{' '}
                  <span className="text-text">{summary.currentState}</span>
                </p>
                {summary.risks?.length > 0 && (
                  <p>
                    <span className="text-accent-light">Riziko:</span>{' '}
                    <span className="text-text">{summary.risks.join(' · ')}</span>
                  </p>
                )}
                {summary.nextSteps?.length > 0 && (
                  <p>
                    <span className="text-green-400">Další:</span>{' '}
                    <span className="text-text">{summary.nextSteps.join(' · ')}</span>
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Last message from CP — full text, verbatim */}
          {recentMessage && (
            <div>
              <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-1.5">
                Poslední zpráva od {cp.name || cp.primary_identifier}
              </p>
              <p className="text-sm text-text whitespace-pre-wrap">{recentMessage}</p>
            </div>
          )}

          {/* Scoring breakdown */}
          <div>
            <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2">Hodnocení</p>
            <div className="grid grid-cols-3 gap-x-4 gap-y-3 text-sm">
              <div>
                <p className="text-text-muted">Hodnota</p>
                <p className="text-text font-medium">{adjValue.toLocaleString()} Kč</p>
              </div>
              <div>
                <p className="text-text-muted">Naléhavost</p>
                <p className="text-text font-medium">{action.urgency}/10</p>
              </div>
              <div>
                <p className="text-text-muted">Bolest</p>
                <p className="text-text font-medium">{action.pain_factor}/10</p>
              </div>
              <div>
                <p className="text-text-muted">Dní ignorováno</p>
                <p className="text-text font-medium">{days}</p>
              </div>
              <div>
                <p className="text-text-muted">Váha</p>
                <p className="text-text font-medium">{action.weight ?? 0}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
