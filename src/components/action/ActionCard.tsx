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

export interface Participant {
  name: string | null
  role: string | null
  primary_identifier: string
}

export interface ActionCardProps {
  action: ActionProposal
  conversation: ConversationThread
  cp: CP
  recentMessage?: string
  participants?: Participant[]
  onDoIt: () => Promise<void>
  onEdit: (notes: string) => Promise<void>
  onIllDoIt: () => Promise<void>
  onBlacklist?: () => Promise<void>
}

/**
 * SINGLE SOURCE OF TRUTH TEMPLATE
 * This function returns the HTML structure used for both Web and Email.
 */
export function getActionCardTemplate(params: {
  cpName: string
  cpRole?: string | null
  topic: string
  typeLabel: string
  urgencyLabel: string
  intent: string
  actionUrl?: string
  editUrl?: string
  isEmail: boolean
}) {
  const { cpName, cpRole, topic, typeLabel, urgencyLabel, intent, actionUrl, editUrl, isEmail } = params

  return `
    <div style="background-color: #FFFFFF; border: 1px solid #E2E0D9; border-radius: 8px; font-family: sans-serif; margin-bottom: 24px; overflow: hidden; max-width: 600px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
      <div style="padding: 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 16px;">
          <tr>
            <td>
              <div style="font-size: 20px; font-weight: bold; color: #1A2744;">
                ${cpName}${cpRole ? `<span style="font-size: 14px; font-weight: normal; color: #64748B; margin-left: 8px;">· ${cpRole}</span>` : ''}
              </div>
              <div style="font-size: 14px; color: #64748B; margin-top: 2px;">${topic}</div>
            </td>
            <td align="right" valign="top" style="white-space: nowrap;">
              <span style="background-color: #1A2744; color: #FFFFFF; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: bold; text-transform: uppercase; margin-right: 4px;">${typeLabel}</span>
              <span style="background-color: #6B3D3D; color: #FFFFFF; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: bold; text-transform: uppercase;">${urgencyLabel}</span>
            </td>
          </tr>
        </table>
        <div style="font-size: 18px; line-height: 1.6; color: #1A2744; margin-bottom: 24px; white-space: pre-wrap;">${intent}</div>
        ${isEmail ? `
          <div style="padding-top: 20px; border-top: 1px solid #E2E0D9;">
            <a href="${actionUrl}" style="display: inline-block; background-color: #1A2744; color: #FFFFFF; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 14px; margin-right: 8px;">UDĚLAT</a>
            <a href="${editUrl}" style="display: inline-block; background-color: #FFFFFF; color: #1A2744; border: 1px solid #1A2744; padding: 11px 24px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 14px; margin-right: 8px;">UPRAVIT</a>
            <a href="${actionUrl}" style="display: inline-block; background-color: transparent; color: #64748B; border: 1px solid #E2E0D9; padding: 11px 24px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 14px;">UDĚLÁM SÁM</a>
          </div>
        ` : ''}
      </div>
    </div>
  `
}

export function ActionCard({ action, conversation, cp, recentMessage, participants, onDoIt, onEdit, onIllDoIt, onBlacklist }: ActionCardProps) {
  const [editOpen, setEditOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState<string | null>(null)

  const summary = conversation.summary_json as ConversationSummary | null
  const days = daysIgnored(action.created_at)
  const adjValue = action.dollar_value * (action.offer_multiplier ?? 1)
  const intent = action.intent_cs || action.rationale_cs || action.rationale
  const urgencyLabel = action.urgency >= 8 ? 'TEĎ' : action.urgency >= 4 ? 'Zítra' : 'Později'

  const run = (key: string, fn: () => Promise<void>) => async () => {
    setLoading(key)
    try { await fn() } finally { setLoading(null) }
  }

  return (
    <>
      <div className="w-full max-w-2xl mx-auto">
        <div dangerouslySetInnerHTML={{ __html: getActionCardTemplate({
          cpName: cp.name || cp.primary_identifier,
          cpRole: cp.role,
          topic: conversation.topic,
          typeLabel: TYPE_LABEL[action.action_type] || action.action_type,
          urgencyLabel,
          intent,
          isEmail: false
        }) }} />

        <div className="px-6 pb-6 -mt-10">
          <button onClick={() => setDetailOpen(true)} className="text-sm text-text-muted hover:text-primary mb-4 block">▸ Detaily</button>

          {editOpen && (
            <div className="mb-4 p-4 bg-background rounded-md border border-border">
              <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2">Přidat poznámky nebo omezení</p>
              <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="např. Nezapomeň zmínit, že bazén bude připraven pro jeho děti." />
              <div className="flex gap-2 mt-3">
                <Button variant="primary" size="sm" onClick={run('edit-submit', () => onEdit(notes))} loading={loading === 'edit-submit'}>Odeslat</Button>
                <Button variant="ghost" size="sm" onClick={() => setEditOpen(false)}>Zrušit</Button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between pt-4 border-t border-border">
            <div className="flex gap-2">
              <Button variant="primary" onClick={run('doit', onDoIt)} loading={loading === 'doit'}>UDĚLAT</Button>
              <Button variant="secondary" onClick={() => setEditOpen(!editOpen)}>UPRAVIT</Button>
              <Button variant="outline" onClick={run('illdoit', onIllDoIt)} loading={loading === 'illdoit'}>UDĚLÁM SÁM</Button>
            </div>
            {onBlacklist && <button onClick={onBlacklist} className="text-xs text-text-muted hover:text-accent">Zablokovat CP</button>}
          </div>
        </div>
      </div>

      {detailOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-primary/20 backdrop-blur-sm" onClick={() => setDetailOpen(false)} />
          <div className="card relative w-full max-w-lg p-6 space-y-5 animate-fade-in bg-surface">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-bold text-primary">Detaily</h3>
              <button onClick={() => setDetailOpen(false)} className="text-text-muted hover:text-primary text-2xl leading-none">&times;</button>
            </div>

            <div>
              <p className="text-xs font-bold text-text-muted uppercase tracking-wide mb-1.5">Proč teď</p>
              <p className="text-sm text-primary">{action.rationale_cs || action.rationale}</p>
            </div>

            {summary && (
              <div>
                <p className="text-xs font-bold text-text-muted uppercase tracking-wide mb-1.5">Přehled konverzace</p>
                <div className="space-y-1 text-sm">
                  <p><span className="text-text-muted">Stav:</span> <span className="text-primary">{summary.currentState}</span></p>
                  {summary.risks?.length > 0 && <p><span className="text-accent font-bold">Riziko:</span> <span className="text-primary">{summary.risks.join(' · ')}</span></p>}
                  {summary.nextSteps?.length > 0 && <p><span className="text-green-600 font-bold">Další:</span> <span className="text-primary">{summary.nextSteps.join(' · ')}</span></p>}
                </div>
              </div>
            )}

            {recentMessage && (
              <div>
                <p className="text-xs font-bold text-text-muted uppercase tracking-wide mb-1.5">Poslední zpráva</p>
                <p className="text-sm text-primary whitespace-pre-wrap bg-background p-3 rounded border border-border">{recentMessage}</p>
              </div>
            )}

            <div>
              <p className="text-xs font-bold text-text-muted uppercase tracking-wide mb-2">Hodnocení</p>
              <div className="grid grid-cols-3 gap-x-4 gap-y-3 text-sm">
                <div><p className="text-text-muted">Hodnota</p><p className="text-primary font-bold">{adjValue.toLocaleString()} Kč</p></div>
                <div><p className="text-text-muted">Naléhavost</p><p className="text-primary font-bold">{action.urgency}/10</p></div>
                <div><p className="text-text-muted">Bolest</p><p className="text-primary font-bold">{action.pain_factor}/10</p></div>
                <div><p className="text-text-muted">Dní ignorováno</p><p className="text-primary font-bold">{days}</p></div>
                <div><p className="text-text-muted">Váha</p><p className="text-primary font-bold">{action.weight ?? 0}</p></div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
