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

  const [cpName, setCpName] = useState('')
  const [topic, setTopic] = useState('')
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')

  useEffect(() => {
    async function load() {
      try {
        // Load action data for context (CP name, topic)
        const actionRes = await fetch(`/api/action/${actionId}?token=${token}`)
        if (!actionRes.ok) {
          const err = await actionRes.json()
          throw new Error(err.error || 'Failed to load action')
        }
        const actionData = await actionRes.json() as ActionPageData
        setCpName(actionData.cp.name || actionData.cp.primary_identifier)
        setTopic(actionData.conversation.topic || '')

        // Check if action is still executable
        if (actionData.action.status !== 'pending' && actionData.action.status !== 'approved') {
          throw new Error('Tato akce již byla provedena.')
        }

        // Generate draft
        const draftRes = await fetch(`/api/action/${actionId}/draft`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        if (!draftRes.ok) {
          const err = await draftRes.json()
          throw new Error(err.error || 'Failed to generate draft')
        }
        const draft = await draftRes.json()
        setTo(draft.to || '')
        setSubject(draft.subject || '')
        setBody(draft.body || '')
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
        subMessage: `Zpráva odeslána pro ${cpName}.`,
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

  return (
    <Card style={{ width: '100%', maxWidth: '672px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ padding: `${theme.spacing.lg} ${theme.spacing.lg} ${theme.spacing.sm}` }}>
        <p style={{ fontSize: theme.typography.sizes.xs, fontWeight: theme.typography.weights.medium, color: theme.colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Koncept zprávy
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
          Odeslat
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

  async function handleEdit(editData: { notes: string; dynamicFields?: Record<string, string> }) {
    const response = await fetch(`/api/action/${actionId}/draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, notes: editData.notes, dynamicFields: editData.dynamicFields }),
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

  // ?do=execute → Draft review page (editable draft, confirm to send)
  if (doAction === 'execute') {
    return <DraftReviewView actionId={actionId} token={token} />
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
