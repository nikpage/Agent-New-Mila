'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { ActionCard } from '@/components/action/ActionCard'
import { SuccessOverlay } from '@/components/action/SuccessOverlay'
import { Button } from '@/components/ui/Button'
import { Input, Textarea } from '@/components/ui/Input'
import { Card } from '@/components/ui/Card'
import { theme } from '@/config/theme'
import type { ActionProposal, ConversationThread, CP, Message } from '@/lib/supabase/types'

interface ActionPageData {
  action: ActionProposal
  conversation: ConversationThread
  cp: CP
  recentMessage?: Message
  participants?: { name: string | null; role: string | null; primary_identifier: string }[]
}

type SuccessState = {
  show: boolean
  message: string
  subMessage?: string
}

// ─── Shared: loading spinner ────────────────────────────────────────────────

function Spinner({ message }: { message: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div className="animate-spin" style={{
        width: '32px',
        height: '32px',
        border: `2px solid ${theme.colors.primary}`,
        borderTopColor: 'transparent',
        borderRadius: '50%',
        margin: `0 auto ${theme.spacing.md} auto`
      }} />
      <p style={{ color: theme.colors.textMuted }}>{message}</p>
    </div>
  )
}

// ─── Shared: error display ──────────────────────────────────────────────────

function ErrorDisplay({ message }: { message: string }) {
  return (
    <div style={{ textAlign: 'center', maxWidth: '448px' }}>
      <div style={{
        width: '64px',
        height: '64px',
        backgroundColor: theme.colors.errorBg,
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        margin: `0 auto ${theme.spacing.md} auto`
      }}>
        <svg
          style={{ width: '32px', height: '32px', color: theme.colors.error }}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </div>
      <h2 style={{ fontSize: theme.typography.sizes.xl, fontWeight: theme.typography.weights.semibold, marginBottom: theme.spacing.sm, color: theme.colors.text }}>Chyba</h2>
      <p style={{ color: theme.colors.textMuted }}>{message}</p>
    </div>
  )
}

// ─── Draft Review View (for ?do=execute) ────────────────────────────────────
// Shows the AI-generated draft in editable fields. User reviews, edits, sends.

function DraftReviewView({ actionId, token }: { actionId: string; token: string }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [success, setSuccess] = useState<SuccessState>({ show: false, message: '' })
  // If action is not REPLY, redirect to DirectExecuteView (handles old URLs without &type=)
  const [redirectToDirectExecute, setRedirectToDirectExecute] = useState(false)

  const [actionType, setActionType] = useState<string>('REPLY')
  const [cpName, setCpName] = useState('')
  const [topic, setTopic] = useState('')
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')

  useEffect(() => {
    async function load() {
      try {
        // Single call — draft POST returns action metadata alongside the draft
        const draftRes = await fetch(`/api/action/${actionId}/draft`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        if (!draftRes.ok) {
          const err = await draftRes.json()
          throw new Error(err.error || 'Failed to generate draft')
        }
        const data = await draftRes.json()

        // Only TODO/other non-communication actions skip draft review
        if (data.action?.action_type !== 'REPLY' && data.action?.action_type !== 'SCHEDULE') {
          setRedirectToDirectExecute(true)
          setLoading(false)
          return
        }

        // No status block — user can always re-edit and re-send

        setActionType(data.action?.action_type || 'REPLY')
        setCpName(data.cp?.name || data.cp?.primary_identifier || '')
        setTopic(data.conversation?.topic || '')
        setTo(data.to || '')
        setSubject(data.subject || '')
        setBody(data.body || '')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load draft')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [actionId, token])

  async function handleSend() {
    setSending(true)
    try {
      // Save any edits first
      const saveRes = await fetch(`/api/action/${actionId}/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, subject, body, to }),
      })
      if (!saveRes.ok) {
        const err = await saveRes.json()
        throw new Error(err.error || 'Failed to save draft')
      }

      // Execute the action
      const execRes = await fetch(`/api/action/${actionId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (!execRes.ok) {
        const err = await execRes.json()
        throw new Error(err.error || 'Failed to execute action')
      }

      setSuccess({
        show: true,
        message: 'Odesláno!',
        subMessage: actionType === 'SCHEDULE'
          ? `Pozvánka odeslána pro ${cpName}.`
          : `Zpráva odeslána pro ${cpName}.`,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send')
      setSending(false)
    }
  }

  if (success.show) {
    return <SuccessOverlay message={success.message} subMessage={success.subMessage} />
  }

  if (loading) return <Spinner message="Připravuji koncept..." />
  if (error) return <ErrorDisplay message={error} />

  // Non-REPLY action detected after loading — render DirectExecuteView instead of email form
  if (redirectToDirectExecute) {
    return <DirectExecuteView actionId={actionId} token={token} />
  }

  return (
    <Card style={{ width: '100%', maxWidth: '672px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ padding: `${theme.spacing.lg} ${theme.spacing.lg} ${theme.spacing.sm}` }}>
        <p style={{ fontSize: theme.typography.sizes.xs, fontWeight: theme.typography.weights.medium, color: theme.colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {actionType === 'SCHEDULE' ? 'Koncept pozvánky' : 'Koncept zprávy'}
        </p>
        <h2 style={{ fontSize: theme.typography.sizes.lg, fontWeight: theme.typography.weights.semibold, color: theme.colors.text, marginTop: theme.spacing.xs }}>
          {cpName}
        </h2>
        {topic && (
          <p style={{ fontSize: theme.typography.sizes.sm, color: theme.colors.textMuted, marginTop: '2px' }}>{topic}</p>
        )}
      </div>

      {/* Editable fields */}
      <div style={{ padding: `0 ${theme.spacing.lg} ${theme.spacing.md}`, display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
        <Input
          label="Komu"
          value={to}
          onChange={e => setTo(e.target.value)}
        />
        <Input
          label="Předmět"
          value={subject}
          onChange={e => setSubject(e.target.value)}
        />
        <Textarea
          label="Zpráva"
          value={body}
          onChange={e => setBody(e.target.value)}
          rows={12}
        />
      </div>

      {/* Send / cancel */}
      <div style={{
        padding: `${theme.spacing.md} ${theme.spacing.lg}`,
        display: 'flex',
        gap: theme.spacing.sm,
        borderTop: `1px solid ${theme.colors.border}`
      }}>
        <Button
          variant="primary"
          onClick={handleSend}
          loading={sending}
          disabled={!body.trim()}
        >
          {actionType === 'SCHEDULE' ? 'Odeslat pozvánku' : 'Odeslat'}
        </Button>
      </div>
    </Card>
  )
}

// ─── Quick Action View (for ?do=todo, ?do=blacklist) ────────────────────────
// Auto-executes immediately, shows minimal Done page.

function QuickActionView({ actionId, token, doAction }: { actionId: string; token: string; doAction: 'todo' | 'blacklist' }) {
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<SuccessState>({ show: false, message: '' })
  const executed = useRef(false)

  useEffect(() => {
    if (executed.current) return
    executed.current = true

    async function run() {
      try {
        const endpoint = doAction === 'todo' ? 'todo' : 'blacklist'
        const response = await fetch(`/api/action/${actionId}/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })

        if (!response.ok) {
          const err = await response.json()
          throw new Error(err.error || 'Failed to execute action')
        }

        if (doAction === 'todo') {
          setSuccess({ show: true, message: 'Hotovo', subMessage: 'Přidáno do vašich úkolů.' })
        } else {
          setSuccess({ show: true, message: 'Kontakt zablokován', subMessage: 'Nebudete již dostávat karty pro tento kontakt.' })
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed')
      }
    }
    run()
  }, [actionId, token, doAction])

  if (success.show) {
    return <SuccessOverlay message={success.message} subMessage={success.subMessage} />
  }

  if (error) return <ErrorDisplay message={error} />

  return <Spinner message="Provádím akci..." />
}

// ─── Direct Execute View (for SCHEDULE/TODO ?do=execute) ────────────────────
// Loads action, shows confirmation with intent, then executes directly (no email draft).

function DirectExecuteView({ actionId, token }: { actionId: string; token: string }) {
  const [loading, setLoading] = useState(true)
  const [executing, setExecuting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<SuccessState>({ show: false, message: '' })
  const [actionData, setActionData] = useState<ActionPageData | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const actionRes = await fetch(`/api/action/${actionId}?token=${token}`)
        if (!actionRes.ok) {
          const err = await actionRes.json()
          throw new Error(err.error || 'Failed to load action')
        }
        const data = await actionRes.json() as ActionPageData
        // No status block — user can always re-open and update actions
        setActionData(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load action')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [actionId, token])

  async function handleConfirm() {
    setExecuting(true)
    try {
      const execRes = await fetch(`/api/action/${actionId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (!execRes.ok) {
        const err = await execRes.json()
        throw new Error(err.error || 'Failed to execute action')
      }

      const actionType = actionData?.action.action_type
      if (actionType === 'SCHEDULE') {
        setSuccess({
          show: true,
          message: 'Schůzka potvrzena!',
          subMessage: `Pozvánka odeslána pro ${actionData?.cp.name || actionData?.cp.primary_identifier || 'kontakt'}.`,
        })
      } else {
        setSuccess({
          show: true,
          message: 'Hotovo!',
          subMessage: 'Úkol splněn.',
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to execute')
      setExecuting(false)
    }
  }

  if (success.show) {
    return <SuccessOverlay message={success.message} subMessage={success.subMessage} />
  }
  if (loading) return <Spinner message="Načítání..." />
  if (error) return <ErrorDisplay message={error} />
  if (!actionData) return <ErrorDisplay message="Akce nenalezena" />

  const { action, cp, conversation } = actionData
  const rawIntent = action.intent_cs || action.rationale_cs || action.rationale || ''
  // Strip "Termín: ..." line — the template renders slot time separately from payload
  const intent = rawIntent.replace(/\n*Termín:.*$/m, '').trim()
  const cpName = cp.name || cp.primary_identifier
  const typeLabel = action.action_type === 'SCHEDULE' ? 'Schůzka' : 'Úkol'
  const isCompleted = action.status === 'completed'

  // Completed SCHEDULE actions — show "sent" state with edit option
  if (isCompleted && action.action_type === 'SCHEDULE') {
    return <CompletedScheduleView actionId={actionId} token={token} actionData={actionData} />
  }

  return (
    <Card style={{ width: '100%', maxWidth: '672px', margin: '0 auto' }}>
      <div style={{ padding: `${theme.spacing.lg} ${theme.spacing.lg} ${theme.spacing.sm}` }}>
        <p style={{ fontSize: theme.typography.sizes.xs, fontWeight: theme.typography.weights.medium, color: theme.colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {typeLabel}
        </p>
        <h2 style={{ fontSize: theme.typography.sizes.lg, fontWeight: theme.typography.weights.semibold, color: theme.colors.text, marginTop: theme.spacing.xs }}>
          {cpName}
        </h2>
        {conversation.topic && (
          <p style={{ fontSize: theme.typography.sizes.sm, color: theme.colors.textMuted, marginTop: '2px' }}>{conversation.topic}</p>
        )}
      </div>

      <div style={{ padding: `0 ${theme.spacing.lg} ${theme.spacing.md}`, fontSize: theme.typography.sizes.base, color: theme.colors.text, lineHeight: '1.625', whiteSpace: 'pre-wrap' }}>
        {intent}
      </div>

      {action.action_type === 'SCHEDULE' && (() => {
        const payload = action.payload as Record<string, unknown> | null
        const location = payload?.location as string | null
        const locationPartial = !!payload?.location_partial
        const isOnline = !!payload?.is_online
        const mt = (payload?.meeting_type as string) || (isOnline ? 'online' : 'address')
        const cpPhone = payload?.cp_phone as string | null
        // Build slot text from hold start/end
        let cardSlotText: string | null = null
        if (payload?.start && payload?.end) {
          const tz = 'Europe/Prague'
          const s = new Date(payload.start as string)
          const e = new Date(payload.end as string)
          const dateStr = s.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz })
          const startStr = s.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
          const endStr = e.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
          cardSlotText = `${dateStr}, ${startStr} - ${endStr}`
        }
        return (
          <div style={{ padding: `0 ${theme.spacing.lg} ${theme.spacing.sm}`, fontSize: theme.typography.sizes.sm }}>
            {cardSlotText && <><span style={{ color: theme.colors.textMuted }}>Termín: </span><span style={{ color: theme.colors.text, fontWeight: 500 }}>{cardSlotText}</span><br/></>}
            {mt === 'online'
              ? <><span style={{ color: theme.colors.textMuted }}>Typ: </span><span style={{ color: theme.colors.success, fontWeight: 500 }}>Online (Google Meet)</span></>
              : mt === 'phone'
                ? <><span style={{ color: theme.colors.textMuted }}>Typ: </span><span style={{ color: theme.colors.success, fontWeight: 500 }}>Telefonát</span>{cpPhone && <><br/><span style={{ color: theme.colors.textMuted }}>Tel: </span><span style={{ color: theme.colors.text, fontWeight: 500 }}>{cpPhone}</span></>}</>
                : <><span style={{ color: theme.colors.textMuted }}>Místo: </span>
                    {location
                      ? locationPartial
                        ? <span style={{ color: theme.colors.warning, fontWeight: 500 }}>{location} — ⚠ upřesněte přes UPRAVIT</span>
                        : <span style={{ color: theme.colors.text }}>{location}</span>
                      : <span style={{ color: theme.colors.accent }}>Chybí</span>
                    }</>
            }
          </div>
        )
      })()}

      {/* Conflict warning banner */}
      {action.action_type === 'SCHEDULE' && (() => {
        const payload = action.payload as Record<string, unknown> | null
        const conflicts = payload?.conflicts as { event_title: string; recommendation: string }[] | undefined
        if (!conflicts || conflicts.length === 0) return null
        return (
          <div style={{
            margin: `0 ${theme.spacing.lg} ${theme.spacing.sm}`,
            padding: `${theme.spacing.sm} ${theme.spacing.md}`,
            backgroundColor: '#fef2f2',
            border: '2px solid #dc2626',
            borderRadius: '8px',
          }}>
            <div style={{ fontSize: theme.typography.sizes.sm, fontWeight: 700, color: '#dc2626', marginBottom: '6px' }}>
              ⚠ KOLIZE V KALENDÁŘI
            </div>
            {conflicts.map((c, i) => (
              <div key={i} style={{ fontSize: theme.typography.sizes.sm, color: '#991b1b', marginBottom: '4px' }}>
                <strong>{c.event_title}</strong> — {c.recommendation === 'move_existing' ? 'Mila navrhuje přesunout' : 'nelze přesunout'}
              </div>
            ))}
            <div style={{ fontSize: theme.typography.sizes.xs, color: '#991b1b', marginTop: '6px' }}>
              Zkontrolujte přes UPRAVIT nebo tento termín odmítněte.
            </div>
          </div>
        )
      })()}

      <div style={{
        padding: `${theme.spacing.md} ${theme.spacing.lg}`,
        display: 'flex',
        gap: theme.spacing.sm,
        borderTop: `1px solid ${theme.colors.border}`
      }}>
        <Button
          variant="primary"
          onClick={handleConfirm}
          loading={executing}
        >
          {action.action_type === 'SCHEDULE' ? 'Potvrdit a odeslat pozvánku' : 'Splněno'}
        </Button>
      </div>
    </Card>
  )
}

// ─── Completed Schedule View — invite already sent, user can edit via Mila ──

function CompletedScheduleView({ actionId, token, actionData }: { actionId: string; token: string; actionData: ActionPageData }) {
  const [editOpen, setEditOpen] = useState(false)
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState<SuccessState>({ show: false, message: '' })
  const [error, setError] = useState<string | null>(null)

  const { action, cp, conversation } = actionData
  const payload = action.payload as Record<string, unknown> | null
  const location = payload?.location as string | null
  const isOnline = !!payload?.is_online
  const holdStart = payload?.start as string | undefined
  const holdEnd = payload?.end as string | undefined
  const cpName = cp.name || cp.primary_identifier

  const formatSlot = () => {
    if (!holdStart || !holdEnd) return null
    const start = new Date(holdStart)
    const end = new Date(holdEnd)
    const dateStr = start.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long' })
    const startStr = start.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false })
    const endStr = end.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false })
    return `${dateStr}, ${startStr} - ${endStr}`
  }

  async function handleUpdateInvite() {
    setSaving(true)
    try {
      // Save edit notes, then re-execute to update the calendar event
      const saveRes = await fetch(`/api/action/${actionId}/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, notes }),
      })
      if (!saveRes.ok) {
        const err = await saveRes.json()
        throw new Error(err.error || 'Failed to save changes')
      }

      const execRes = await fetch(`/api/action/${actionId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, update: true }),
      })
      if (!execRes.ok) {
        const err = await execRes.json()
        throw new Error(err.error || 'Failed to update invite')
      }

      setSuccess({
        show: true,
        message: 'Pozvánka aktualizována!',
        subMessage: `Aktualizovaná pozvánka odeslána pro ${cpName}.`,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update')
      setSaving(false)
    }
  }

  if (success.show) {
    return <SuccessOverlay message={success.message} subMessage={success.subMessage} />
  }
  if (error) return <ErrorDisplay message={error} />

  const slot = formatSlot()

  return (
    <Card style={{ width: '100%', maxWidth: '672px', margin: '0 auto' }}>
      <div style={{ padding: `${theme.spacing.lg} ${theme.spacing.lg} ${theme.spacing.sm}` }}>
        <div style={{
          display: 'inline-block',
          padding: '4px 12px',
          backgroundColor: theme.colors.successBg,
          color: theme.colors.success,
          borderRadius: theme.borderRadius.md,
          fontSize: theme.typography.sizes.xs,
          fontWeight: theme.typography.weights.medium,
          marginBottom: theme.spacing.sm,
        }}>
          Pozvánka odeslána
        </div>
        <h2 style={{ fontSize: theme.typography.sizes.lg, fontWeight: theme.typography.weights.semibold, color: theme.colors.text }}>
          {cpName}
        </h2>
        {conversation.topic && (
          <p style={{ fontSize: theme.typography.sizes.sm, color: theme.colors.textMuted, marginTop: '2px' }}>{conversation.topic}</p>
        )}
      </div>

      {/* Current invite details */}
      <div style={{ padding: `0 ${theme.spacing.lg} ${theme.spacing.md}`, display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }}>
        {slot && (
          <div style={{ fontSize: theme.typography.sizes.sm }}>
            <span style={{ color: theme.colors.textMuted }}>Termín: </span>
            <span style={{ color: theme.colors.text }}>{slot}</span>
          </div>
        )}
        <div style={{ fontSize: theme.typography.sizes.sm }}>
          {(() => {
            const mt = (payload?.meeting_type as string) || (isOnline ? 'online' : 'address')
            if (mt === 'online') return <><span style={{ color: theme.colors.textMuted }}>Typ: </span><span style={{ color: theme.colors.success, fontWeight: 500 }}>Online (Google Meet)</span></>
            if (mt === 'phone') return <><span style={{ color: theme.colors.textMuted }}>Typ: </span><span style={{ color: theme.colors.success, fontWeight: 500 }}>Telefonát</span></>
            return <><span style={{ color: theme.colors.textMuted }}>Místo: </span>{location ? <span style={{ color: theme.colors.text }}>{location}</span> : <span style={{ color: theme.colors.textMuted }}>Neuvedeno</span>}</>
          })()}
        </div>
      </div>

      {/* Edit section */}
      {editOpen ? (
        <div style={{
          margin: `0 ${theme.spacing.lg} ${theme.spacing.md}`,
          padding: theme.spacing.md,
          backgroundColor: theme.colors.secondary,
          borderRadius: theme.borderRadius.md,
          border: `1px solid ${theme.colors.border}`,
        }}>
          <p style={{
            fontSize: theme.typography.sizes.xs,
            fontWeight: theme.typography.weights.medium,
            color: theme.colors.textMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: theme.spacing.sm,
          }}>
            Co chcete změnit?
          </p>
          <Textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={3}
            placeholder={'např. "Přesuň na 14:00" nebo "Změň místo na Kavárna Slavia"'}
          />
          <div style={{ display: 'flex', gap: theme.spacing.sm, marginTop: theme.spacing.sm }}>
            <Button
              variant="primary"
              size="sm"
              onClick={handleUpdateInvite}
              loading={saving}
              disabled={!notes.trim()}
            >
              Aktualizovat pozvánku
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
      ) : null}

      <div style={{
        padding: `${theme.spacing.md} ${theme.spacing.lg}`,
        borderTop: `1px solid ${theme.colors.border}`,
      }}>
        <Button
          variant="secondary"
          onClick={() => setEditOpen(!editOpen)}
        >
          Upravit pozvánku
        </Button>
      </div>
    </Card>
  )
}

// ─── Conflict Resolve View (for ?do=resolve_conflict) ───────────────────────
// Unified conflict solver: toggle which event to move, pick slots, set duration/mode.

type MeetingMode = 'address' | 'online' | 'phone'
type TargetEvent = 'new' | 'existing'

interface ConflictResolutionData {
  action: string
  conflict: { event_title: string; event_start: string; event_end: string }
  draft: { subject: string; body: string } | null
  summary: string
  existingEvent: { title: string; time: string; cpName: string | null; hasGuests: boolean; durationMinutes?: number }
  newEvent?: { title: string | null; durationMinutes: number | null; start: string | null; end: string | null; cpName: string | null }
  altSlot: { time: string; start: string; end: string } | null
  availableSlots?: { start: string; end: string; label: string; busy?: boolean }[]
  recommendation?: 'move_existing' | 'suggest_alternate'
}

function ConflictResolveView({ actionId, token }: { actionId: string; token: string }) {
  const searchParams = useSearchParams()
  // Legacy: action param from old email buttons still works, but defaults to unified view
  const legacyAction = searchParams.get('action') || ''
  const conflictIdx = searchParams.get('conflict_idx') || '0'

  const [loading, setLoading] = useState(true)
  const [executing, setExecuting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<SuccessState>({ show: false, message: '' })

  const [resolutionData, setResolutionData] = useState<ConflictResolutionData | null>(null)

  // Which event the user is manipulating
  const [targetEvent, setTargetEvent] = useState<TargetEvent>('new')
  // Resolution action — derived from target + user choices
  const [resolutionAction, setResolutionAction] = useState<string>(legacyAction || 'move_new')

  // Slot picker
  const [selectedSlot, setSelectedSlot] = useState<{ start: string; end: string } | null>(null)

  // Duration slider (5-60 min, 5 min increments)
  const [duration, setDuration] = useState<number>(30)

  // Force into booked slot
  const [forceIntoSlot, setForceIntoSlot] = useState(false)

  // Meeting mode
  const [meetingMode, setMeetingMode] = useState<MeetingMode>('address')
  const [locationText, setLocationText] = useState('')

  // Draft (for notification emails)
  const [draftSubject, setDraftSubject] = useState('')
  const [draftBody, setDraftBody] = useState('')

  // Fetch slots when target/duration/force changes
  const [slotsLoading, setSlotsLoading] = useState(false)

  useEffect(() => {
    async function load() {
      try {
        // Always use 'resolve' action for the unified view — backend returns all data
        const apiAction = legacyAction || 'move_new'
        const res = await fetch(
          `/api/action/${actionId}/resolve-conflict?token=${token}&action=${apiAction}&conflict_idx=${conflictIdx}&unified=1`
        )
        if (!res.ok) {
          const err = await res.json()
          if (err.resolved) {
            setSuccess({ show: true, message: 'Kolize vyřešena', subMessage: 'Konflikt již byl vyřešen.' })
            setLoading(false)
            return
          }
          throw new Error(err.error || 'Failed to load conflict details')
        }
        const data: ConflictResolutionData = await res.json()
        setResolutionData(data)

        // Set initial target based on recommendation
        if (data.recommendation === 'move_existing') {
          setTargetEvent('existing')
          setResolutionAction('reschedule_existing')
        } else {
          setTargetEvent('new')
          setResolutionAction('move_new')
        }

        // Set initial duration from the event being moved
        const initDuration = data.recommendation === 'move_existing'
          ? (data.existingEvent?.durationMinutes || 30)
          : (data.newEvent?.durationMinutes || 30)
        setDuration(Math.min(60, Math.max(5, Math.round(initDuration / 5) * 5)))

        if (data.draft) {
          setDraftSubject(data.draft.subject)
          setDraftBody(data.draft.body)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [actionId, token, legacyAction, conflictIdx])

  // Refetch slots when duration or forceIntoSlot changes
  const prevFetchRef = useRef({ duration: 0, force: false, target: '' as TargetEvent })
  useEffect(() => {
    if (!resolutionData) return
    const prev = prevFetchRef.current
    if (prev.duration === duration && prev.force === forceIntoSlot && prev.target === targetEvent) return
    prevFetchRef.current = { duration, force: forceIntoSlot, target: targetEvent }

    async function refetchSlots() {
      setSlotsLoading(true)
      try {
        const res = await fetch(
          `/api/action/${actionId}/resolve-conflict?token=${token}&action=move_new&conflict_idx=${conflictIdx}&unified=1&duration=${duration}&force=${forceIntoSlot ? '1' : '0'}&target=${targetEvent}`
        )
        if (res.ok) {
          const data = await res.json()
          setResolutionData(prev => prev ? { ...prev, availableSlots: data.availableSlots } : prev)
          setSelectedSlot(null)
        }
      } catch { /* keep existing slots */ }
      finally { setSlotsLoading(false) }
    }
    refetchSlots()
  }, [duration, forceIntoSlot, targetEvent, actionId, token, conflictIdx, resolutionData])

  function handleTargetToggle(target: TargetEvent) {
    setTargetEvent(target)
    setSelectedSlot(null)
    if (target === 'new') {
      setResolutionAction('move_new')
      setDuration(Math.min(60, Math.max(5, Math.round((resolutionData?.newEvent?.durationMinutes || 30) / 5) * 5)))
    } else {
      setResolutionAction('reschedule_existing')
      setDuration(Math.min(60, Math.max(5, Math.round((resolutionData?.existingEvent?.durationMinutes || 30) / 5) * 5)))
    }
  }

  async function handleConfirm() {
    // Determine final action
    let finalAction = resolutionAction
    if (finalAction === 'move_new' && !selectedSlot && !forceIntoSlot) {
      setError('Vyberte nový termín ze seznamu.')
      return
    }
    if (finalAction === 'reschedule_existing' && !selectedSlot && !resolutionData?.altSlot) {
      setError('Vyberte nový termín ze seznamu.')
      return
    }

    setExecuting(true)
    setError(null)
    try {
      const res = await fetch(`/api/action/${actionId}/resolve-conflict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          action: finalAction,
          conflict_idx: parseInt(conflictIdx, 10),
          edited_draft: resolutionData?.draft ? { subject: draftSubject, body: draftBody } : undefined,
          selected_slot: selectedSlot || undefined,
          new_duration: duration,
          existing_duration: targetEvent === 'existing' ? duration : undefined,
          force_into_slot: forceIntoSlot,
          meeting_mode: meetingMode,
          location: meetingMode === 'address' ? locationText : undefined,
          target_event: targetEvent,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to resolve conflict')
      }
      const result = await res.json()

      if (finalAction === 'keep_both') {
        setSuccess({
          show: true,
          message: 'Kolize ponechána',
          subMessage: 'Obě schůzky zůstávají — můžete nyní kliknout UDĚLAT.',
        })
      } else if (finalAction === 'cancel_existing') {
        setSuccess({
          show: true,
          message: 'Zrušeno a potvrzeno!',
          subMessage: 'Stávající schůzka zrušena, nová potvrzena.',
        })
      } else {
        setSuccess({
          show: true,
          message: 'Přesunuto!',
          subMessage: result.newSlot
            ? 'Schůzka přesunuta na nový termín.'
            : 'Schůzka byla přesunuta.',
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve')
      setExecuting(false)
    }
  }

  if (success.show) {
    return <SuccessOverlay message={success.message} subMessage={success.subMessage} />
  }
  if (loading) return <Spinner message="Načítání konfliktu..." />
  if (error && !resolutionData) return <ErrorDisplay message={error} />
  if (!resolutionData) return <ErrorDisplay message="Data nenalezena" />

  const existingTitle = resolutionData.existingEvent.title
  const newTitle = resolutionData.newEvent?.title || resolutionData.newEvent?.cpName || 'Nová schůzka'
  const movingLabel = targetEvent === 'new' ? newTitle : existingTitle
  const stayingLabel = targetEvent === 'new' ? existingTitle : newTitle

  // Duration slider marks
  const durationMarks = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60]

  // Meeting mode options
  const modeOptions: { value: MeetingMode; label: string; icon: string }[] = [
    { value: 'address', label: 'Osobně', icon: '📍' },
    { value: 'online', label: 'Online', icon: '💻' },
    { value: 'phone', label: 'Telefonát', icon: '📞' },
  ]

  const slots = resolutionData.availableSlots || []

  return (
    <Card style={{ width: '100%', maxWidth: '720px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ padding: `${theme.spacing.lg} ${theme.spacing.lg} ${theme.spacing.sm}` }}>
        <p style={{
          fontSize: theme.typography.sizes.xs,
          fontWeight: theme.typography.weights.medium,
          color: '#dc2626',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}>
          ⚠ Kolize v kalendáři
        </p>
        <h2 style={{
          fontSize: theme.typography.sizes.xl,
          fontWeight: theme.typography.weights.semibold,
          color: theme.colors.text,
          marginTop: theme.spacing.xs,
        }}>
          Vyřešit kolizi
        </h2>
      </div>

      {/* Two event cards side by side */}
      <div style={{
        display: 'flex',
        gap: theme.spacing.md,
        padding: `0 ${theme.spacing.lg} ${theme.spacing.md}`,
      }}>
        {/* Existing event */}
        <div style={{
          flex: 1,
          padding: theme.spacing.md,
          backgroundColor: targetEvent === 'existing' ? '#fef2f2' : theme.colors.secondary,
          borderRadius: theme.borderRadius.md,
          border: `2px solid ${targetEvent === 'existing' ? '#dc2626' : theme.colors.border}`,
          opacity: targetEvent === 'existing' ? 1 : 0.7,
        }}>
          <div style={{ fontSize: theme.typography.sizes.xs, fontWeight: 700, color: '#991b1b', textTransform: 'uppercase', marginBottom: '4px' }}>
            Stávající
          </div>
          <div style={{ fontSize: theme.typography.sizes.sm, fontWeight: 600, color: theme.colors.text }}>
            {existingTitle}
          </div>
          <div style={{ fontSize: theme.typography.sizes.sm, color: theme.colors.textMuted }}>
            {resolutionData.existingEvent.time}
          </div>
          {resolutionData.existingEvent.cpName && (
            <div style={{ fontSize: theme.typography.sizes.xs, color: theme.colors.textMuted }}>
              {resolutionData.existingEvent.cpName}
            </div>
          )}
          {resolutionData.existingEvent.durationMinutes && (
            <div style={{ fontSize: theme.typography.sizes.xs, color: theme.colors.textMuted, marginTop: '2px' }}>
              {resolutionData.existingEvent.durationMinutes} min
            </div>
          )}
        </div>

        {/* New event */}
        <div style={{
          flex: 1,
          padding: theme.spacing.md,
          backgroundColor: targetEvent === 'new' ? '#eff6ff' : theme.colors.secondary,
          borderRadius: theme.borderRadius.md,
          border: `2px solid ${targetEvent === 'new' ? '#1e40af' : theme.colors.border}`,
          opacity: targetEvent === 'new' ? 1 : 0.7,
        }}>
          <div style={{ fontSize: theme.typography.sizes.xs, fontWeight: 700, color: '#1e40af', textTransform: 'uppercase', marginBottom: '4px' }}>
            Nová (tato)
          </div>
          <div style={{ fontSize: theme.typography.sizes.sm, fontWeight: 600, color: theme.colors.text }}>
            {newTitle}
          </div>
          {resolutionData.newEvent?.start && (
            <div style={{ fontSize: theme.typography.sizes.sm, color: theme.colors.textMuted }}>
              {new Date(resolutionData.newEvent.start).toLocaleString('cs-CZ', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Prague' })}
            </div>
          )}
          {resolutionData.newEvent?.cpName && (
            <div style={{ fontSize: theme.typography.sizes.xs, color: theme.colors.textMuted }}>
              {resolutionData.newEvent.cpName}
            </div>
          )}
          {resolutionData.newEvent?.durationMinutes && (
            <div style={{ fontSize: theme.typography.sizes.xs, color: theme.colors.textMuted, marginTop: '2px' }}>
              {resolutionData.newEvent.durationMinutes} min
            </div>
          )}
        </div>
      </div>

      {/* Toggle: which event to move */}
      <div style={{ padding: `0 ${theme.spacing.lg} ${theme.spacing.md}` }}>
        <div style={{ fontSize: theme.typography.sizes.xs, fontWeight: theme.typography.weights.medium, color: theme.colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
          Kterou schůzku přesunout?
        </div>
        <div style={{ display: 'flex', gap: theme.spacing.sm }}>
          <button
            onClick={() => handleTargetToggle('new')}
            style={{
              flex: 1,
              padding: '10px',
              backgroundColor: targetEvent === 'new' ? theme.colors.primary : theme.colors.surface,
              color: targetEvent === 'new' ? 'white' : theme.colors.text,
              border: `2px solid ${targetEvent === 'new' ? theme.colors.primary : theme.colors.border}`,
              borderRadius: theme.borderRadius.md,
              cursor: 'pointer',
              fontSize: theme.typography.sizes.sm,
              fontWeight: targetEvent === 'new' ? theme.typography.weights.semibold : theme.typography.weights.normal,
              transition: 'all 0.15s ease',
            }}
          >
            Přesunout novou
          </button>
          <button
            onClick={() => handleTargetToggle('existing')}
            style={{
              flex: 1,
              padding: '10px',
              backgroundColor: targetEvent === 'existing' ? '#dc2626' : theme.colors.surface,
              color: targetEvent === 'existing' ? 'white' : theme.colors.text,
              border: `2px solid ${targetEvent === 'existing' ? '#dc2626' : theme.colors.border}`,
              borderRadius: theme.borderRadius.md,
              cursor: 'pointer',
              fontSize: theme.typography.sizes.sm,
              fontWeight: targetEvent === 'existing' ? theme.typography.weights.semibold : theme.typography.weights.normal,
              transition: 'all 0.15s ease',
            }}
          >
            Přesunout stávající
          </button>
          <button
            onClick={() => { setResolutionAction('keep_both'); setTargetEvent('new') }}
            style={{
              padding: '10px 14px',
              backgroundColor: resolutionAction === 'keep_both' ? '#16a34a' : theme.colors.surface,
              color: resolutionAction === 'keep_both' ? 'white' : theme.colors.text,
              border: `2px solid ${resolutionAction === 'keep_both' ? '#16a34a' : theme.colors.border}`,
              borderRadius: theme.borderRadius.md,
              cursor: 'pointer',
              fontSize: theme.typography.sizes.sm,
              fontWeight: resolutionAction === 'keep_both' ? theme.typography.weights.semibold : theme.typography.weights.normal,
              transition: 'all 0.15s ease',
            }}
          >
            Ponechat obojí
          </button>
          {resolutionData.existingEvent.hasGuests && (
            <button
              onClick={() => setResolutionAction('cancel_existing')}
              style={{
                padding: '10px 14px',
                backgroundColor: resolutionAction === 'cancel_existing' ? '#991b1b' : theme.colors.surface,
                color: resolutionAction === 'cancel_existing' ? 'white' : theme.colors.text,
                border: `2px solid ${resolutionAction === 'cancel_existing' ? '#991b1b' : theme.colors.border}`,
                borderRadius: theme.borderRadius.md,
                cursor: 'pointer',
                fontSize: theme.typography.sizes.sm,
                fontWeight: resolutionAction === 'cancel_existing' ? theme.typography.weights.semibold : theme.typography.weights.normal,
                transition: 'all 0.15s ease',
              }}
            >
              Zrušit stávající
            </button>
          )}
        </div>
      </div>

      {/* Duration slider */}
      {resolutionAction !== 'keep_both' && resolutionAction !== 'cancel_existing' && (
        <div style={{ padding: `0 ${theme.spacing.lg} ${theme.spacing.md}` }}>
          <div style={{ fontSize: theme.typography.sizes.xs, fontWeight: theme.typography.weights.medium, color: theme.colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
            Délka schůzky: <strong style={{ color: theme.colors.text, fontSize: theme.typography.sizes.sm }}>{duration} min</strong>
          </div>
          <input
            type="range"
            min={5}
            max={60}
            step={5}
            value={duration}
            onChange={e => setDuration(parseInt(e.target.value, 10))}
            style={{
              width: '100%',
              height: '6px',
              cursor: 'pointer',
              accentColor: theme.colors.primary,
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
            {[5, 15, 30, 45, 60].map(m => (
              <span key={m} style={{ fontSize: '10px', color: theme.colors.textMuted }}>{m}m</span>
            ))}
          </div>
        </div>
      )}

      {/* Meeting mode */}
      {resolutionAction !== 'keep_both' && resolutionAction !== 'cancel_existing' && (
        <div style={{ padding: `0 ${theme.spacing.lg} ${theme.spacing.md}` }}>
          <div style={{ fontSize: theme.typography.sizes.xs, fontWeight: theme.typography.weights.medium, color: theme.colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
            Typ schůzky
          </div>
          <div style={{ display: 'flex', gap: theme.spacing.sm }}>
            {modeOptions.map(opt => (
              <button
                key={opt.value}
                onClick={() => setMeetingMode(opt.value)}
                style={{
                  flex: 1,
                  padding: '8px',
                  backgroundColor: meetingMode === opt.value ? theme.colors.primary : theme.colors.surface,
                  color: meetingMode === opt.value ? 'white' : theme.colors.text,
                  border: `2px solid ${meetingMode === opt.value ? theme.colors.primary : theme.colors.border}`,
                  borderRadius: theme.borderRadius.md,
                  cursor: 'pointer',
                  fontSize: theme.typography.sizes.sm,
                  fontWeight: meetingMode === opt.value ? theme.typography.weights.semibold : theme.typography.weights.normal,
                  transition: 'all 0.15s ease',
                }}
              >
                {opt.icon} {opt.label}
              </button>
            ))}
          </div>
          {meetingMode === 'address' && (
            <div style={{ marginTop: theme.spacing.sm }}>
              <Input
                label="Místo"
                value={locationText}
                onChange={e => setLocationText(e.target.value)}
                placeholder="Adresa schůzky..."
              />
            </div>
          )}
        </div>
      )}

      {/* Force into booked slots toggle */}
      {resolutionAction !== 'keep_both' && resolutionAction !== 'cancel_existing' && (
        <div style={{ padding: `0 ${theme.spacing.lg} ${theme.spacing.md}` }}>
          <label style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.spacing.sm,
            cursor: 'pointer',
            fontSize: theme.typography.sizes.sm,
            color: theme.colors.text,
          }}>
            <input
              type="checkbox"
              checked={forceIntoSlot}
              onChange={e => setForceIntoSlot(e.target.checked)}
              style={{ width: '18px', height: '18px', accentColor: theme.colors.primary, cursor: 'pointer' }}
            />
            <span>
              Zobrazit i obsazené termíny
              <span style={{ fontSize: theme.typography.sizes.xs, color: theme.colors.textMuted, marginLeft: '4px' }}>
                (krátký hovor během jiné schůzky)
              </span>
            </span>
          </label>
        </div>
      )}

      {/* Slot picker — 2 column grid */}
      {resolutionAction !== 'keep_both' && resolutionAction !== 'cancel_existing' && (
        <div style={{ padding: `0 ${theme.spacing.lg} ${theme.spacing.md}` }}>
          <div style={{ fontSize: theme.typography.sizes.xs, fontWeight: theme.typography.weights.medium, color: theme.colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
            Vyberte nový termín pro &quot;{movingLabel}&quot;
            {slotsLoading && <span style={{ marginLeft: '8px', fontSize: '11px', color: theme.colors.primary }}>načítám…</span>}
          </div>
          <div style={{ fontSize: theme.typography.sizes.xs, color: theme.colors.textMuted, marginBottom: '8px' }}>
            &quot;{stayingLabel}&quot; zůstane beze změny.
          </div>
          {slots.length > 0 ? (
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: theme.spacing.xs,
            }}>
              {slots.map((slot, idx) => {
                const isSelected = selectedSlot?.start === slot.start && selectedSlot?.end === slot.end
                const isBusy = slot.busy
                return (
                  <button
                    key={idx}
                    onClick={() => setSelectedSlot({ start: slot.start, end: slot.end })}
                    style={{
                      padding: '8px 12px',
                      backgroundColor: isSelected
                        ? theme.colors.primary
                        : isBusy
                          ? '#fef2f2'
                          : theme.colors.surface,
                      color: isSelected ? 'white' : isBusy ? '#991b1b' : theme.colors.text,
                      border: `2px solid ${isSelected ? theme.colors.primary : isBusy ? '#fecaca' : theme.colors.border}`,
                      borderRadius: theme.borderRadius.md,
                      cursor: 'pointer',
                      fontSize: theme.typography.sizes.sm,
                      fontWeight: isSelected ? theme.typography.weights.semibold : theme.typography.weights.normal,
                      textAlign: 'left',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    {slot.label}
                    {isBusy && <span style={{ fontSize: '10px', marginLeft: '4px' }}>⚠</span>}
                  </button>
                )
              })}
            </div>
          ) : (
            <div style={{
              padding: theme.spacing.md,
              backgroundColor: '#fef2f2',
              borderRadius: theme.borderRadius.md,
              color: '#991b1b',
              fontSize: theme.typography.sizes.sm,
            }}>
              Žádné volné termíny v následujících 14 dnech.
            </div>
          )}
        </div>
      )}

      {/* Editable draft (only if existing event has guests/CP and we're moving/cancelling it) */}
      {resolutionData.draft && (resolutionAction === 'reschedule_existing' || resolutionAction === 'cancel_existing') && (
        <div style={{ padding: `0 ${theme.spacing.lg} ${theme.spacing.md}`, display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
          <div style={{
            fontSize: theme.typography.sizes.xs,
            fontWeight: theme.typography.weights.medium,
            color: theme.colors.textMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}>
            Zpráva pro {resolutionData.existingEvent.cpName || 'účastníky'}
          </div>
          <Input
            label="Předmět"
            value={draftSubject}
            onChange={e => setDraftSubject(e.target.value)}
          />
          <Textarea
            label="Zpráva"
            value={draftBody}
            onChange={e => setDraftBody(e.target.value)}
            rows={6}
          />
        </div>
      )}

      {/* Error display */}
      {error && (
        <div style={{
          margin: `0 ${theme.spacing.lg} ${theme.spacing.md}`,
          padding: theme.spacing.md,
          backgroundColor: '#fef2f2',
          borderRadius: theme.borderRadius.md,
          color: '#991b1b',
          fontSize: theme.typography.sizes.sm,
        }}>
          {error}
        </div>
      )}

      {/* Confirm button */}
      <div style={{
        padding: `${theme.spacing.md} ${theme.spacing.lg}`,
        display: 'flex',
        gap: theme.spacing.sm,
        borderTop: `1px solid ${theme.colors.border}`,
      }}>
        <Button
          variant="primary"
          onClick={handleConfirm}
          loading={executing}
          disabled={
            (resolutionAction !== 'keep_both' && resolutionAction !== 'cancel_existing' && !selectedSlot)
          }
        >
          {resolutionAction === 'keep_both'
            ? 'Ponechat obojí'
            : resolutionAction === 'cancel_existing'
              ? 'Zrušit stávající'
              : 'Potvrdit přesun'}
        </Button>
      </div>
    </Card>
  )
}

// ─── Detail View (no ?do param — DETAILY link from email) ───────────────────
// This is the only case where showing the full card makes sense.

function DetailView({ actionId, token, initialDetailOpen }: { actionId: string; token: string; initialDetailOpen?: boolean }) {
  const [data, setData] = useState<ActionPageData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [success, setSuccess] = useState<SuccessState>({ show: false, message: '' })

  useEffect(() => {
    loadAction()
  }, [actionId, token])

  async function loadAction() {
    try {
      const response = await fetch(`/api/action/${actionId}?token=${token}`)
      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to load action')
      }
      const result = await response.json()
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load action')
    } finally {
      setLoading(false)
    }
  }

  async function handleDoIt() {
    const response = await fetch(`/api/action/${actionId}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(errorData.error || 'Failed to execute action')
    }
    setSuccess({ show: true, message: 'Hotovo!', subMessage: 'Akce byla provedena.' })
  }

  async function handleEdit(editData: { notes: string; dynamicFields?: Record<string, string>; meetingType?: string }) {
    // Send both meetingType and derived isOnline for backward compatibility
    const isOnline = editData.meetingType === 'online' ? true : editData.meetingType ? false : undefined
    const response = await fetch(`/api/action/${actionId}/draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, notes: editData.notes, dynamicFields: editData.dynamicFields, isOnline, meetingType: editData.meetingType }),
    })
    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(errorData.error || 'Failed to save draft')
    }
    const result = await response.json()
    if (result.command === 'cancel_all') {
      setSuccess({ show: true, message: 'Vše zrušeno', subMessage: `Zrušeno ${result.dismissed} akcí.` })
      return
    }
    if (result.command === 'cancel_this') {
      setSuccess({ show: true, message: 'Zrušeno', subMessage: 'Akce byla zrušena.' })
      return
    }
    await loadAction()
  }

  async function handleIllDoIt() {
    const response = await fetch(`/api/action/${actionId}/todo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(errorData.error || 'Failed to create todo')
    }
    setSuccess({ show: true, message: 'Hotovo', subMessage: 'Přidáno do vašich úkolů.' })
  }

  async function handleBlacklist() {
    const response = await fetch(`/api/action/${actionId}/blacklist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(errorData.error || 'Failed to blacklist')
    }
    setSuccess({ show: true, message: 'Kontakt zablokován', subMessage: 'Nebudete již dostávat karty pro tento kontakt.' })
  }

  if (loading) return <Spinner message="Načítání akce..." />
  if (error) return <ErrorDisplay message={error} />
  if (!data) return <p style={{ color: theme.colors.textMuted, textAlign: 'center' }}>Akce nenalezena</p>

  return (
    <>
      <div className="animate-slide-up" style={{ width: '100%', maxWidth: '672px' }}>
        <ActionCard
          action={data.action}
          conversation={data.conversation}
          cp={data.cp}
          recentMessage={data.recentMessage?.cleaned_text ?? data.recentMessage?.raw_text ?? undefined}
          participants={data.participants}
          initialDetailOpen={initialDetailOpen}
          onDoIt={handleDoIt}
          onEdit={handleEdit}
          onIllDoIt={handleIllDoIt}
          onBlacklist={handleBlacklist}
        />
      </div>

      {success.show && (
        <SuccessOverlay message={success.message} subMessage={success.subMessage} />
      )}
    </>
  )
}

// ─── Router ─────────────────────────────────────────────────────────────────

function ActionContent() {
  const params = useParams()
  const searchParams = useSearchParams()
  const actionId = params.id as string
  const token = searchParams.get('token')
  const doAction = searchParams.get('do')
  const view = searchParams.get('view')

  if (!token) {
    return <ErrorDisplay message="Chybí autorizační token." />
  }

  // ?do=execute → Route by action type
  // REPLY: Draft review page (editable draft, confirm to send)
  // SCHEDULE/TODO: Direct execute (no email draft — calendar invite or mark done)
  if (doAction === 'execute') {
    const actionType = searchParams.get('type')
    if (actionType === 'SCHEDULE' || actionType === 'TODO') {
      return <DirectExecuteView actionId={actionId} token={token} />
    }
    // No type param (old URLs) or REPLY → email draft review
    // DraftReviewView also detects non-REPLY types and redirects to DirectExecuteView
    return <DraftReviewView actionId={actionId} token={token} />
  }

  // ?do=resolve_conflict → Conflict resolution page
  if (doAction === 'resolve_conflict') {
    return <ConflictResolveView actionId={actionId} token={token} />
  }

  // ?do=todo or ?do=blacklist → Auto-execute, minimal Done page
  if (doAction === 'todo' || doAction === 'blacklist') {
    return <QuickActionView actionId={actionId} token={token} doAction={doAction} />
  }

  // No ?do → Detail view (DETAILY link from email, shows full card)
  return <DetailView actionId={actionId} token={token} initialDetailOpen={view === 'details'} />
}

function LoadingFallback() {
  return <Spinner message="Načítání..." />
}

export default function ActionPage() {
  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: theme.spacing.md }}>
      <Suspense fallback={<LoadingFallback />}>
        <ActionContent />
      </Suspense>
    </main>
  )
}
