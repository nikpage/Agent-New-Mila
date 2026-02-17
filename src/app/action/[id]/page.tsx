'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { ActionCard } from '@/components/action/ActionCard'
import { SuccessOverlay } from '@/components/action/SuccessOverlay'
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

function ActionContent() {
  const params = useParams()
  const searchParams = useSearchParams()
  const actionId = params.id as string
  const token = searchParams.get('token')
  const doAction = searchParams.get('do') // 'execute' | 'todo' | 'blacklist' | null

  const [data, setData] = useState<ActionPageData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [executing, setExecuting] = useState(false)
  const [success, setSuccess] = useState<SuccessState>({ show: false, message: '' })
  const autoExecuted = useRef(false)

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

  // Auto-execute when `do` param is present and data is loaded
  useEffect(() => {
    if (!data || !doAction || autoExecuted.current || success.show) return
    if (data.action.status !== 'pending') return

    autoExecuted.current = true

    if (doAction === 'execute') {
      // Check if action can be executed (not disabled)
      const missingInfoFields = (data.action.missing_info as { label: string; value: string | null }[] | null) || []
      const hasUnfilledFields = missingInfoFields.length > 0 && missingInfoFields.some(f => f.value === null || f.value === '')
      const actionPayload = data.action.payload as Record<string, unknown> | null
      const hasBlockedSlots = !!(actionPayload?.blocked_slots && Array.isArray(actionPayload.blocked_slots) && (actionPayload.blocked_slots as unknown[]).length > 0)
      const doItDisabled = hasUnfilledFields && !hasBlockedSlots

      if (doItDisabled) {
        // Can't auto-execute — needs user input, show the card instead
        return
      }
      runAutoAction('execute', handleDoIt)
    } else if (doAction === 'todo') {
      runAutoAction('todo', handleIllDoIt)
    } else if (doAction === 'blacklist') {
      runAutoAction('blacklist', handleBlacklist)
    }
  }, [data, doAction])

  async function runAutoAction(label: string, handler: () => Promise<void>) {
    setExecuting(true)
    try {
      await handler()
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${label} action`)
      setExecuting(false)
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

    setExecuting(false)
    setSuccess({
      show: true,
      message: 'Hotovo!',
      subMessage: 'Akce byla provedena.',
    })
  }

  async function handleEdit(notes: string) {
    const response = await fetch(`/api/action/${actionId}/draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, notes }),
    })

    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(errorData.error || 'Failed to save draft')
    }

    const result = await response.json()

    // Handle cancel commands detected by the API
    if (result.command === 'cancel_all') {
      setSuccess({
        show: true,
        message: 'Vše zrušeno',
        subMessage: `Zrušeno ${result.dismissed} akcí.`,
      })
      return
    }
    if (result.command === 'cancel_this') {
      setSuccess({
        show: true,
        message: 'Zrušeno',
        subMessage: 'Akce byla zrušena.',
      })
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

    setExecuting(false)
    setSuccess({
      show: true,
      message: 'Zrušeno',
      subMessage: 'Akce byla zrušena.',
    })
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

    setExecuting(false)
    setSuccess({
      show: true,
      message: 'Kontakt zablokován',
      subMessage: 'Nebudete již dostávat karty pro tento kontakt.',
    })
  }

  if (loading || executing) {
    const statusMessage = executing ? 'Provádím akci...' : 'Načítání akce...'
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
        <p style={{ color: theme.colors.textMuted }}>{statusMessage}</p>
      </div>
    )
  }

  if (error) {
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
        <p style={{ color: theme.colors.textMuted }}>{error}</p>
      </div>
    )
  }

  if (!data) {
    return (
      <div style={{ textAlign: 'center' }}>
        <p style={{ color: theme.colors.textMuted }}>Akce nenalezena</p>
      </div>
    )
  }

  return (
    <>
      <div className="animate-slide-up" style={{ width: '100%', maxWidth: '672px' }}>
        <ActionCard
          action={data.action}
          conversation={data.conversation}
          cp={data.cp}
          recentMessage={data.recentMessage?.cleaned_text ?? data.recentMessage?.raw_text ?? undefined}
          participants={data.participants}
          onDoIt={handleDoIt}
          onEdit={handleEdit}
          onIllDoIt={handleIllDoIt}
          onBlacklist={handleBlacklist}
        />
      </div>

      {success.show && (
        <SuccessOverlay
          message={success.message}
          subMessage={success.subMessage}
        />
      )}
    </>
  )
}

function LoadingFallback() {
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
      <p style={{ color: theme.colors.textMuted }}>Načítání...</p>
    </div>
  )
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
