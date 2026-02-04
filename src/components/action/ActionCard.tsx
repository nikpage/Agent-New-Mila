'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Textarea } from '@/components/ui/Input'
import type { ActionProposal, ConversationThread, CP, ConversationSummary } from '@/lib/supabase/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getUrgency(score: number): { label: string; cls: string } {
  if (score >= 80) return { label: 'NOW',      cls: 'bg-red-600 text-white' }
  if (score >= 40) return { label: 'TODAY',    cls: 'bg-orange-500 text-white' }
  if (score >= 15) return { label: 'TOMORROW', cls: 'bg-amber-500 text-white' }
  return                   { label: 'SOON',    cls: 'bg-primary-light text-text-muted' }
}

function daysIgnored(createdAt: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000))
}

const TYPE_LABEL: Record<string, string> = {
  REPLY: 'Reply', SCHEDULE: 'Schedule', WAIT: 'Waiting', FILE: 'Archive', DELEGATE: 'Delegate',
}

const TYPE_VARIANT: Record<string, 'accent' | 'warning' | 'success' | 'default'> = {
  REPLY: 'accent', SCHEDULE: 'warning', WAIT: 'default', FILE: 'success', DELEGATE: 'warning',
}

// ─── Payload shape (from Gemini via planning.ts) ──────────────────────────────

interface MissingInfoField {
  label: string
  placeholder: string
}

interface OriginalProposal {
  proposedResponse?: string | null
  missingInfo?: MissingInfoField[]
}

function getProposal(action: ActionProposal): OriginalProposal | null {
  return (action.payload as { original_proposal?: OriginalProposal })?.original_proposal ?? null
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
  onEdit:        (subject: string, body: string, to?: string) => Promise<void>
  onIllDoIt:     () => Promise<void>
  onToDo:        () => Promise<void>
  onBlacklist?:  () => Promise<void>
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ActionCard({
  action, conversation, cp, recentMessage, participants,
  onDoIt, onEdit, onIllDoIt, onToDo, onBlacklist,
}: ActionCardProps) {
  const [mode, setMode]                   = useState<'view' | 'edit'>('view')
  const [detailOpen, setDetailOpen]       = useState(false)
  const [loading, setLoading]             = useState<string | null>(null)
  const [editSubject, setEditSubject]     = useState(action.draft_subject || '')
  const [editBody,    setEditBody]        = useState(action.draft_body_text || '')
  const [editTo,      setEditTo]          = useState(
    ((action.payload as Record<string, unknown>)?.editedTo as string) || cp.primary_identifier
  )

  const proposal    = getProposal(action)
  const missingInfo = proposal?.missingInfo ?? []
  const [missingValues, setMissingValues] = useState<Record<string, string>>(
    () => Object.fromEntries(missingInfo.map(f => [f.label, '']))
  )

  const summary  = conversation.summary_json as ConversationSummary | null
  const urgency  = getUrgency(action.priority_score)
  const days     = daysIgnored(action.created_at)
  const adjValue = action.dollar_value * (action.offer_multiplier ?? 1)
  const hasMissing = missingInfo.length > 0 && missingInfo.some(f => !missingValues[f.label])
  const canDoIt  = !hasMissing
    && action.action_type === 'REPLY'
    && (mode === 'edit' ? !!editBody : !!action.draft_body_text)

  // loading wrapper
  const run = (key: string, fn: () => Promise<void>) => async () => {
    setLoading(key)
    try { await fn() } finally { setLoading(null) }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
    <div className="card w-full max-w-2xl mx-auto">

      {/* ─── 2.1 HEADER: Identity ──────────────────────────────────── */}
      <div className="px-6 pt-5 pb-3">
        {/* Action-type badge  +  Urgency badge */}
        <div className="flex items-center justify-between mb-3">
          <Badge variant={TYPE_VARIANT[action.action_type] || 'default'}>
            {TYPE_LABEL[action.action_type] || action.action_type}
          </Badge>
          <span className={`inline-block text-xs font-bold tracking-widest px-2.5 py-0.5 rounded ${urgency.cls}`}>
            {urgency.label}
          </span>
        </div>

        {/* CP name  ·  Role */}
        <h2 className="text-lg font-semibold text-text">
          {cp.name || cp.primary_identifier}
          {cp.role && (
            <span className="text-sm font-normal text-text-muted ml-2">· {cp.role}</span>
          )}
        </h2>

        {/* Deal type  ·  Topic */}
        <p className="text-sm text-text-muted mt-0.5">
          {conversation.deal_type
            ? <>{conversation.deal_type} · {conversation.topic}</>
            : conversation.topic
          }
        </p>
      </div>

      {/* ─── 2.2 PRIORITY BLOCK ────────────────────────────────────── */}
      <div className="mx-6 mb-2 p-4 bg-primary-dark rounded-lg flex items-center gap-6">
        {/* Large score */}
        <div className="text-center flex-shrink-0">
          <div className="text-4xl font-bold text-text leading-none">
            {Math.round(action.priority_score)}
          </div>
          <div className="text-xs text-text-muted mt-1">Priority</div>
        </div>

        {/* Score breakdown */}
        <div className="grid grid-cols-2 gap-x-5 gap-y-1 text-xs text-text-muted">
          <span>Value: <span className="text-text font-medium">${adjValue.toLocaleString()}</span></span>
          <span>Urgency: <span className="text-text font-medium">{action.urgency}/10</span></span>
          <span>Pain: <span className="text-text font-medium">{action.pain_factor}/10</span></span>
          <span>Days idle: <span className="text-text font-medium">{days}</span></span>
          {action.weight != null && action.weight !== 0 && (
            <span>Weight: <span className="text-text font-medium">{action.weight}</span></span>
          )}
        </div>
      </div>

      {/* ─── 2.4 CONTEXT BLOCK ─────────────────────────────────────── */}
      <div className="px-6 py-2 space-y-3">

        {/* Why now (rationale) */}
        <div className="p-3 bg-primary-dark rounded-md">
          <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-1">Why now</p>
          <p className="text-sm text-text">{action.rationale}</p>
        </div>

        {/* Conversation snapshot */}
        {summary && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-text-muted uppercase tracking-wide">Conversation snapshot</p>
            <p className="text-sm">
              <span className="text-text-muted">State:</span>{' '}
              <span className="text-text">{summary.currentState}</span>
            </p>
            {summary.risks && summary.risks.length > 0 && (
              <p className="text-sm">
                <span className="text-accent-light">Risk:</span>{' '}
                <span className="text-text">{summary.risks.join(' · ')}</span>
              </p>
            )}
            {summary.nextSteps && summary.nextSteps.length > 0 && (
              <p className="text-sm">
                <span className="text-green-400">Next:</span>{' '}
                <span className="text-text">{summary.nextSteps.join(' · ')}</span>
              </p>
            )}
          </div>
        )}
      </div>

      {/* ─── 2.5 MILA'S PROPOSED RESPONSE ─────────────────────────── */}
      {proposal?.proposedResponse && (
        <div className="px-6 pb-2">
          <div className="p-3 bg-primary-dark rounded-md border border-border">
            <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-1">Mila's proposed response</p>
            <p className="text-sm text-text">{proposal.proposedResponse}</p>
          </div>
        </div>
      )}

      {/* ─── 2.6 DRAFT / EDIT ──────────────────────────────────────── */}
      {(action.action_type === 'REPLY' || action.action_type === 'SCHEDULE') && (
        <div className="px-6 pt-3 pb-2 border-t border-border">
          {mode === 'edit' ? (
            /* Edit form — spec 3.2 */
            <div className="space-y-3">
              <p className="text-xs font-medium text-text-muted uppercase tracking-wide">Edit draft</p>

              {/* Recipients — spec 3.2: "EDIT can modify: Recipients (which CPs)" */}
              <div>
                <label className="text-xs text-text-muted">To</label>
                <input
                  type="text"
                  value={editTo}
                  onChange={e => setEditTo(e.target.value)}
                  className="input mt-1 w-full"
                  placeholder="Recipient…"
                />
              </div>

              {/* Missing-info form — spec 3.2 / wireframe 5.2 */}
              {missingInfo.length > 0 && (
                <div className="p-3 bg-primary-dark rounded-md space-y-2">
                  <p className="text-xs font-medium text-text-muted uppercase tracking-wide">Information needed</p>
                  {missingInfo.map(field => (
                    <div key={field.label}>
                      <label className="text-xs text-text-muted">{field.label}</label>
                      <input
                        type="text"
                        value={missingValues[field.label] || ''}
                        onChange={e => setMissingValues(prev => ({ ...prev, [field.label]: e.target.value }))}
                        className="input mt-1 w-full"
                        placeholder={field.placeholder}
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* Subject */}
              <div>
                <label className="text-xs text-text-muted">Subject</label>
                <input
                  type="text"
                  value={editSubject}
                  onChange={e => setEditSubject(e.target.value)}
                  className="input mt-1 w-full"
                  placeholder="Email subject…"
                />
              </div>

              {/* Body */}
              <div>
                <label className="text-xs text-text-muted">Body</label>
                <Textarea
                  value={editBody}
                  onChange={e => setEditBody(e.target.value)}
                  className="mt-1"
                  rows={6}
                  placeholder="Email body…"
                />
              </div>
            </div>
          ) : (
            /* Draft preview */
            <div>
              <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-1">Draft</p>
              {action.draft_subject && (
                <p className="text-sm font-medium text-text">Subject: {action.draft_subject}</p>
              )}
              {action.draft_body_text ? (
                <p className="text-sm text-text-muted whitespace-pre-wrap mt-1">
                  {action.draft_body_text}
                </p>
              ) : (
                <p className="text-sm text-text-muted italic">
                  No draft yet — tap EDIT to compose.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ─── 3. CTAs ───────────────────────────────────────────────── */}
      <div className="px-6 py-4 border-t border-border flex flex-col gap-3 sm:flex-row sm:justify-between">
        {mode === 'edit' ? (
          /* Edit-mode CTAs: DO IT + TO DO  — spec 3.2 */
          <div className="flex gap-2 w-full">
            <Button
              variant="primary"
              onClick={run('edit-doit', async () => {
                await onEdit(editSubject, editBody, editTo)
                await onDoIt()
              })}
              loading={loading === 'edit-doit'}
              disabled={!canDoIt}
              className="flex-1 sm:flex-none"
            >
              DO IT
            </Button>
            <Button
              variant="secondary"
              onClick={run('edit-todo', async () => {
                await onEdit(editSubject, editBody, editTo)
                await onToDo()
              })}
              loading={loading === 'edit-todo'}
              className="flex-1 sm:flex-none"
            >
              TO DO
            </Button>
          </div>
        ) : (
          /* View-mode CTAs: DO IT + EDIT + I'LL DO IT + Detail  — spec 3.1–3.4, wireframe 5.1 */
          <>
            <div className="flex gap-2 w-full sm:w-auto">
              <Button
                variant="primary"
                onClick={run('doit', onDoIt)}
                loading={loading === 'doit'}
                disabled={!canDoIt}
                title={!canDoIt ? 'Draft required to execute' : undefined}
                className="flex-1 sm:flex-none"
              >
                DO IT
              </Button>
              <Button
                variant="secondary"
                onClick={() => setMode('edit')}
                className="flex-1 sm:flex-none"
              >
                EDIT
              </Button>
              <Button
                variant="outline"
                onClick={run('illdoit', onIllDoIt)}
                loading={loading === 'illdoit'}
                className="flex-1 sm:flex-none"
              >
                I'LL DO IT
              </Button>
              <Button
                variant="ghost"
                onClick={() => setDetailOpen(true)}
                className="flex-1 sm:flex-none text-text-muted text-sm"
              >
                Detail
              </Button>
            </div>

            {onBlacklist && (
              <Button
                variant="ghost"
                onClick={run('blacklist', async () => {
                  if (confirm(`Blacklist ${cp.name || cp.primary_identifier}? No future cards for this contact.`)) {
                    await onBlacklist()
                  }
                })}
                loading={loading === 'blacklist'}
                className="text-text-muted text-sm"
              >
                Blacklist
              </Button>
            )}
          </>
        )}
      </div>
    </div>

    {/* ─── 4. DETAIL MODAL ───────────────────────────────────────── */}
    {detailOpen && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/60" onClick={() => setDetailOpen(false)} />
        <div
          className="card relative w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 space-y-5"
          onClick={e => e.stopPropagation()}
        >
          {/* Header + close */}
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-text">Action Detail</h3>
            <button
              onClick={() => setDetailOpen(false)}
              className="text-text-muted hover:text-text text-xl leading-none"
            >&times;</button>
          </div>

          {/* Most recent message */}
          {recentMessage && (
            <div>
              <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-1">Most recent message</p>
              <p className="text-sm text-text-muted whitespace-pre-wrap">{recentMessage}</p>
            </div>
          )}

          {/* Full conversation context */}
          {summary && (
            <div>
              <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-1">Conversation context</p>
              <p className="text-sm">
                <span className="text-text-muted">State:</span>{' '}
                <span className="text-text">{summary.currentState}</span>
              </p>
              {summary.risks && summary.risks.length > 0 && (
                <p className="text-sm mt-1">
                  <span className="text-accent-light">Risks:</span>{' '}
                  <span className="text-text">{summary.risks.join(', ')}</span>
                </p>
              )}
              {summary.nextSteps && summary.nextSteps.length > 0 && (
                <p className="text-sm mt-1">
                  <span className="text-green-400">Next steps:</span>{' '}
                  <span className="text-text">{summary.nextSteps.join(', ')}</span>
                </p>
              )}
              {summary.keyPoints && summary.keyPoints.length > 0 && (
                <p className="text-sm mt-1">
                  <span className="text-text-muted">Key points:</span>{' '}
                  <span className="text-text">{summary.keyPoints.join(', ')}</span>
                </p>
              )}
            </div>
          )}

          {/* All CPs + roles — spec 4 */}
          <div>
            <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-1">Participants</p>
            {(participants && participants.length > 0
              ? participants
              : [{ name: cp.name, role: cp.role, primary_identifier: cp.primary_identifier }]
            ).map((p, i) => (
              <p key={i} className="text-sm text-text">
                {p.name || p.primary_identifier}
                {p.role && <span className="text-text-muted ml-1">· {p.role}</span>}
              </p>
            ))}
          </div>

          {/* Mila's rationale */}
          <div>
            <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-1">Mila's rationale</p>
            <p className="text-sm text-text">{action.rationale}</p>
          </div>

          {/* Full numeric breakdown — spec 4 */}
          <div>
            <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2">Priority breakdown</p>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <p className="text-text-muted">Value</p>
                <p className="text-text font-medium">${adjValue.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-text-muted">Urgency</p>
                <p className="text-text font-medium">{action.urgency}/10</p>
              </div>
              <div>
                <p className="text-text-muted">Pain</p>
                <p className="text-text font-medium">{action.pain_factor}/10</p>
              </div>
              <div>
                <p className="text-text-muted">Days ignored</p>
                <p className="text-text font-medium">{days}</p>
              </div>
              <div>
                <p className="text-text-muted">Weight</p>
                <p className="text-text font-medium">{action.weight ?? 0}</p>
              </div>
              <div>
                <p className="text-text-muted">Final score</p>
                <p className="text-text font-bold">{Math.round(action.priority_score)}</p>
              </div>
            </div>
          </div>

          {/* EDIT can be entered from here — spec 4 */}
          <Button
            variant="secondary"
            onClick={() => { setDetailOpen(false); setMode('edit') }}
            className="w-full"
          >
            EDIT
          </Button>
        </div>
      </div>
    )}
    </>
  )
}
