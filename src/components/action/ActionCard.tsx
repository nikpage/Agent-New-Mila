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

// ─── Props ────────────────────────────────────────────────────────────────────

export interface ActionCardProps {
  action:       ActionProposal
  conversation: ConversationThread
  cp:           CP
  recentMessage?: string
  onDoIt:       () => Promise<void>
  onEdit:       (subject: string, body: string) => Promise<void>
  onIllDoIt:    () => Promise<void>
  onToDo:       () => Promise<void>
  onBlacklist?: () => Promise<void>
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ActionCard({
  action, conversation, cp, recentMessage,
  onDoIt, onEdit, onIllDoIt, onToDo, onBlacklist,
}: ActionCardProps) {
  const [mode, setMode]                   = useState<'view' | 'edit'>('view')
  const [loading, setLoading]             = useState<string | null>(null)
  const [editSubject, setEditSubject]     = useState(action.draft_subject || '')
  const [editBody,    setEditBody]        = useState(action.draft_body_text || '')

  const summary  = conversation.summary_json as ConversationSummary | null
  const urgency  = getUrgency(action.priority_score)
  const days     = daysIgnored(action.created_at)
  const adjValue = action.dollar_value * (action.offer_multiplier ?? 1)
  const canDoIt  = action.action_type === 'REPLY'
    && (mode === 'edit' ? !!editBody : !!action.draft_body_text)

  // loading wrapper
  const run = (key: string, fn: () => Promise<void>) => async () => {
    setLoading(key)
    try { await fn() } finally { setLoading(null) }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="card w-full max-w-2xl mx-auto">

      {/* ─── 1. HEADER: Identity ──────────────────────────────────────── */}
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

      {/* ─── 2. PRIORITY BLOCK ────────────────────────────────────────── */}
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

      {/* ─── 3. CONTEXT ───────────────────────────────────────────────── */}
      <div className="px-6 py-2 space-y-4">

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

        {/* Most recent message */}
        {recentMessage && (
          <div className="border-t border-border pt-3">
            <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-1">
              Most recent message
            </p>
            <p className="text-sm text-text-muted line-clamp-4 whitespace-pre-wrap">
              {recentMessage}
            </p>
          </div>
        )}
      </div>

      {/* ─── 4. DRAFT / EDIT ──────────────────────────────────────────── */}
      {(action.action_type === 'REPLY' || action.action_type === 'SCHEDULE') && (
        <div className="px-6 pt-3 pb-2 border-t border-border">
          {mode === 'edit' ? (
            /* Edit form */
            <div className="space-y-3">
              <p className="text-xs font-medium text-text-muted uppercase tracking-wide">Edit draft</p>
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

      {/* ─── 5. CTAs ──────────────────────────────────────────────────── */}
      <div className="px-6 py-4 border-t border-border flex flex-col gap-3 sm:flex-row sm:justify-between">
        {mode === 'edit' ? (
          /* Edit-mode CTAs: DO IT + TO DO */
          <div className="flex gap-2 w-full">
            <Button
              variant="primary"
              onClick={run('edit-doit', async () => {
                await onEdit(editSubject, editBody)
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
                await onEdit(editSubject, editBody)
                await onToDo()
              })}
              loading={loading === 'edit-todo'}
              className="flex-1 sm:flex-none"
            >
              TO DO
            </Button>
          </div>
        ) : (
          /* View-mode CTAs: DO IT + EDIT + I'LL DO IT */
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
  )
}
