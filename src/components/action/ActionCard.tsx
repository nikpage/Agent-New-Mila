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

const TYPE_VARIANT: Record<string, 'accent' | 'primary' | 'success' | 'default'> = {
  REPLY: 'primary', SCHEDULE: 'accent', WAIT: 'default', FILE: 'success', DELEGATE: 'accent', CALL: 'primary',
}

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

  const getUrgencyLabel = (urgency: number): string => {
    if (urgency >= 8) return 'TEĎ'
    if (urgency >= 4) return 'Zítra'
    return 'Později'
  }

  const run = (key: string, fn: () => Promise<void>) => async () => {
    setLoading(key)
    try { await fn() } finally { setLoading(null) }
  }

  return (
    <>
    <div className="card w-full max-w-2xl mx-auto bg-surface border-border">

      {/* ─── HEADER ────────────────────────────────────────────────── */}
      <div className="px-6 pt-5 pb-3">
        <div className="flex justify-between items-start">
          <div>
            <h2 className="text-xl font-bold text-primary">
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

      {/* ─── MILA'S INTENT ───── */}
      <div className="px-6 pb-4">
        <p className="text-lg text-primary leading-relaxed whitespace-pre-wrap">
          {intent}
        </p>
      </div>

      {/* ─── DETAILS LINK ────────────────────────────────────────────── */}
      <div className="px-6 pb-4">
        <button
          onClick={() => setDetailOpen(true)}
          className="text-sm text-text-muted hover:text-primary transition-colors flex items-center gap-1.5"
        >
          <span>▸</span> Detaily
        </button>
      </div>

      {/* ─── EDIT PANEL ──── */}
      {editOpen && (
        <div className="mx-6 mb-4 p-4 bg-background rounded-md border border-border">
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

      {/* ─── ACTION CONTROLS ───────────────────────── */}
      <div className="px-6 py-4 flex items-center justify-between border-t border-border">
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

    {/* ─── DETAILS MODAL ────────────── */}
    {detailOpen && (
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
        <div className="absolute inset-0 bg-primary/40 backdrop-blur-sm" onClick={() => setDetailOpen(false)} />
        <div
          className="card relative w-full sm:max-w-lg max-h-[85vh] overflow-y-auto
                     p-6 space-y-5 bg-surface
                     rounded-t-2xl sm:rounded-lg
                     animate-slide-up sm:animate-fade-in"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold text-primary">Detaily</h3>
            <button
              onClick={() => setDetailOpen(false)}
              className="text-text-muted hover:text-primary text-2xl leading-none"
            >&times;</button>
          </div>

          <div>
            <p className="text-xs font-bold text-text-muted uppercase tracking-wide mb-1.5">Proč teď</p>
            <p className="text-sm text-primary">{action.rationale_cs || action.rationale}</p>
          </div>

          {summary && (
            <div>
              <p className="text-xs font-bold text-text-muted uppercase tracking-wide mb-1.5">Přehled konverzace</p>
              <div className="space-y-1 text-sm">
                <p>
                  <span className="text-text-muted">Stav:</span>{' '}
                  <span className="text-primary">{summary.currentState}</span>
                </p>
                {summary.risks?.length > 0 && (
                  <p>
                    <span className="text-accent font-semibold">Riziko:</span>{' '}
                    <span className="text-primary">{summary.risks.join(' · ')}</span>
                  </p>
                )}
                {summary.nextSteps?.length > 0 && (
                  <p>
                    <span className="text-green-600 font-semibold">Další:</span>{' '}
                    <span className="text-primary">{summary.nextSteps.join(' · ')}</span>
                  </p>
                )}
              </div>
            </div>
          )}

          {recentMessage && (
            <div>
              <p className="text-xs font-bold text-text-muted uppercase tracking-wide mb-1.5">
                Poslední zpráva od {cp.name || cp.primary_identifier}
              </p>
              <p className="text-sm text-primary whitespace-pre-wrap bg-background p-3 rounded-md border border-border">{recentMessage}</p>
            </div>
          )}

          <div>
            <p className="text-xs font-bold text-text-muted uppercase tracking-wide mb-2">Hodnocení</p>
            <div className="grid grid-cols-3 gap-x-4 gap-y-3 text-sm">
              <div>
                <p className="text-text-muted">Hodnota</p>
                <p className="text-primary font-semibold">{adjValue.toLocaleString()} Kč</p>
              </div>
              <div>
                <p className="text-text-muted">Naléhavost</p>
                <p className="text-primary font-semibold">{action.urgency}/10</p>
              </div>
              <div>
                <p className="text-text-muted">Bolest</p>
                <p className="text-primary font-semibold">{action.pain_factor}/10</p>
              </div>
              <div>
                <p className="text-text-muted">Dní ignorováno</p>
                <p className="text-primary font-semibold">{days}</p>
              </div>
              <div>
                <p className="text-text-muted">Váha</p>
                <p className="text-primary font-semibold">{action.weight ?? 0}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  )
}

// ─── EMAIL HTML GENERATOR ──────────────────────────────────────────

export function renderActionCardHtml(props: {
  action: ActionProposal
  conversation: ConversationThread
  cp: CP
  actionUrl: string
  editUrl: string
}) {
  const intent = props.action.intent_cs || props.action.rationale_cs || props.action.rationale
  const urgencyLabel = props.action.urgency >= 8 ? 'TEĎ' : props.action.urgency >= 4 ? 'Zítra' : 'Později'
  const typeLabel = TYPE_LABEL[props.action.action_type] || props.action.action_type

  return `
    <div style="background-color: #FFFFFF; border: 1px solid #E2E0D9; border-radius: 8px; font-family: sans-serif; margin-bottom: 24px; overflow: hidden; max-width: 600px;">
      <div style="padding: 24px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td>
              <div style="font-size: 18px; font-weight: bold; color: #1A2744;">
                ${props.cp.name || props.cp.primary_identifier}
              </div>
              <div style="font-size: 14px; color: #64748B; margin-top: 2px;">${props.conversation.topic}</div>
            </td>
            <td align="right" valign="top">
              <span style="background-color: #1A2744; color: #FFFFFF; padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: bold; text-transform: uppercase; margin-right: 4px;">
                ${typeLabel}
              </span>
              <span style="background-color: #6B3D3D; color: #FFFFFF; padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: bold; text-transform: uppercase;">
                ${urgencyLabel}
              </span>
            </td>
          </tr>
        </table>

        <div style="margin-top: 20px; margin-bottom: 24px; font-size: 16px; line-height: 1.6; color: #1A2744;">
          ${intent.replace(/\n/g, '<br>')}
        </div>

        <div style="padding-top: 20px; border-top: 1px solid #E2E0D9;">
          <a href="${props.actionUrl}" style="display: inline-block; background-color: #1A2744; color: #FFFFFF; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 14px; margin-right: 8px;">UDĚLAT</a>
          <a href="${props.editUrl}" style="display: inline-block; background-color: #FFFFFF; color: #1A2744; border: 1px solid #1A2744; padding: 11px 24px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 14px; margin-right: 8px;">UPRAVIT</a>
          <a href="${props.actionUrl}" style="display: inline-block; background-color: transparent; color: #64748B; border: 1px solid #E2E0D9; padding: 11px 24px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 14px;">UDĚLÁM SÁM</a>
        </div>
      </div>
    </div>
  `
}
