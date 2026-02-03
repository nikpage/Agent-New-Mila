'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader, CardContent, CardFooter } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Textarea } from '@/components/ui/Input'
import type { ActionProposal, ConversationThread, CP, ConversationSummary } from '@/lib/supabase/types'

export interface ActionCardProps {
  action: ActionProposal
  conversation: ConversationThread
  cp: CP
  recentMessage?: string
  onDoIt: () => Promise<void>
  onEdit: (subject: string, body: string) => Promise<void>
  onIllDoIt: () => Promise<void>
  onBlacklist?: () => Promise<void>
}

type Mode = 'view' | 'edit'

const actionTypeLabels: Record<string, string> = {
  REPLY: 'Reply Needed',
  SCHEDULE: 'Schedule Meeting',
  WAIT: 'Waiting on Response',
  FILE: 'Archive',
  DELEGATE: 'Delegate',
}

const actionTypeColors: Record<string, 'accent' | 'warning' | 'success' | 'default'> = {
  REPLY: 'accent',
  SCHEDULE: 'warning',
  WAIT: 'default',
  FILE: 'success',
  DELEGATE: 'warning',
}

export function ActionCard({
  action,
  conversation,
  cp,
  recentMessage,
  onDoIt,
  onEdit,
  onIllDoIt,
  onBlacklist,
}: ActionCardProps) {
  const [mode, setMode] = useState<Mode>('view')
  const [loading, setLoading] = useState<string | null>(null)
  const [editSubject, setEditSubject] = useState(action.draft_subject || '')
  const [editBody, setEditBody] = useState(action.draft_body_text || '')

  const summary = conversation.summary_json as ConversationSummary | null

  const handleDoIt = async () => {
    setLoading('doit')
    try {
      await onDoIt()
    } finally {
      setLoading(null)
    }
  }

  const handleEdit = async () => {
    if (mode === 'view') {
      setMode('edit')
      return
    }

    setLoading('edit')
    try {
      await onEdit(editSubject, editBody)
      setMode('view')
    } finally {
      setLoading(null)
    }
  }

  const handleIllDoIt = async () => {
    setLoading('illdoit')
    try {
      await onIllDoIt()
    } finally {
      setLoading(null)
    }
  }

  const handleBlacklist = async () => {
    if (!onBlacklist) return
    if (!confirm(`Are you sure you want to blacklist ${cp.name || cp.primary_identifier}? You won't receive cards for this contact anymore.`)) {
      return
    }
    setLoading('blacklist')
    try {
      await onBlacklist()
    } finally {
      setLoading(null)
    }
  }

  const canDoIt = action.action_type === 'REPLY' && action.draft_body_text

  return (
    <Card className="w-full max-w-2xl mx-auto">
      {/* Header */}
      <CardHeader className="space-y-2">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant={actionTypeColors[action.action_type] || 'default'}>
                {actionTypeLabels[action.action_type] || action.action_type}
              </Badge>
              <span className="text-sm text-text-muted">
                Priority: {Math.round(action.priority_score)}
              </span>
            </div>
            <h2 className="text-lg font-semibold truncate">
              {cp.name || cp.primary_identifier}
            </h2>
            <p className="text-sm text-text-muted truncate">
              {conversation.topic}
            </p>
          </div>
        </div>
      </CardHeader>

      {/* Content */}
      <CardContent className="space-y-4">
        {/* Rationale */}
        <div className="p-3 bg-primary-dark rounded-md">
          <p className="text-sm text-text">{action.rationale}</p>
        </div>

        {/* Conversation Summary */}
        {summary && (
          <div className="space-y-3">
            <div>
              <h4 className="text-xs font-medium text-text-muted uppercase tracking-wide mb-1">
                Current State
              </h4>
              <p className="text-sm">{summary.currentState}</p>
            </div>

            {summary.risks && summary.risks.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-text-muted uppercase tracking-wide mb-1">
                  Risks
                </h4>
                <ul className="text-sm space-y-1">
                  {summary.risks.map((risk, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="text-accent-light">•</span>
                      {risk}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {summary.nextSteps && summary.nextSteps.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-text-muted uppercase tracking-wide mb-1">
                  Next Steps
                </h4>
                <ul className="text-sm space-y-1">
                  {summary.nextSteps.map((step, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="text-green-400">•</span>
                      {step}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Recent Message Preview */}
        {recentMessage && (
          <div className="border-t border-border pt-4">
            <h4 className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2">
              Recent Message
            </h4>
            <p className="text-sm text-text-muted line-clamp-4 whitespace-pre-wrap">
              {recentMessage}
            </p>
          </div>
        )}

        {/* Draft Section (View or Edit) */}
        {(action.action_type === 'REPLY' || action.action_type === 'SCHEDULE') && (
          <div className="border-t border-border pt-4">
            <h4 className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2">
              {mode === 'edit' ? 'Edit Draft' : 'Prepared Draft'}
            </h4>

            {mode === 'edit' ? (
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-text-muted">Subject</label>
                  <input
                    type="text"
                    value={editSubject}
                    onChange={e => setEditSubject(e.target.value)}
                    className="input mt-1"
                    placeholder="Email subject..."
                  />
                </div>
                <div>
                  <label className="text-xs text-text-muted">Body</label>
                  <Textarea
                    value={editBody}
                    onChange={e => setEditBody(e.target.value)}
                    className="mt-1"
                    rows={6}
                    placeholder="Email body..."
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {action.draft_subject && (
                  <p className="text-sm font-medium">
                    Subject: {action.draft_subject}
                  </p>
                )}
                {action.draft_body_text ? (
                  <p className="text-sm text-text-muted whitespace-pre-wrap">
                    {action.draft_body_text}
                  </p>
                ) : (
                  <p className="text-sm text-text-muted italic">
                    No draft prepared. Click Edit to compose.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>

      {/* Footer with CTAs */}
      <CardFooter className="flex flex-col gap-3 sm:flex-row sm:justify-between">
        <div className="flex gap-2 w-full sm:w-auto">
          {mode === 'edit' ? (
            <>
              <Button
                variant="primary"
                onClick={handleEdit}
                loading={loading === 'edit'}
                className="flex-1 sm:flex-none"
              >
                Save Draft
              </Button>
              <Button
                variant="ghost"
                onClick={() => setMode('view')}
                className="flex-1 sm:flex-none"
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="primary"
                onClick={handleDoIt}
                loading={loading === 'doit'}
                disabled={!canDoIt}
                className="flex-1 sm:flex-none"
                title={!canDoIt ? 'Draft required to send' : undefined}
              >
                Do It
              </Button>
              <Button
                variant="secondary"
                onClick={handleEdit}
                className="flex-1 sm:flex-none"
              >
                Edit
              </Button>
              <Button
                variant="outline"
                onClick={handleIllDoIt}
                loading={loading === 'illdoit'}
                className="flex-1 sm:flex-none"
              >
                I'll Do It
              </Button>
            </>
          )}
        </div>

        {mode === 'view' && onBlacklist && (
          <Button
            variant="ghost"
            onClick={handleBlacklist}
            loading={loading === 'blacklist'}
            className="text-text-muted text-sm"
          >
            Blacklist CP
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}
