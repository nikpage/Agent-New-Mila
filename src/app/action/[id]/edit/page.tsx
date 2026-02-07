'use client'

import { Suspense, useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { EditForm } from '@/components/action/EditForm'
import { Card } from '@/components/ui/Card'
import { theme } from '@/config/theme'
import type { ActionProposal, ConversationThread, CP } from '@/lib/supabase/types'

interface ActionPageData {
  action: ActionProposal
  conversation: ConversationThread
  cp: CP
}

function EditContent() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const actionId = params.id as string
  const token = searchParams.get('token')

  const [data, setData] = useState<ActionPageData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

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

  async function handleSubmit(formData: { notes: string; dynamicFields: Record<string, string> }) {
    const response = await fetch(`/api/action/${actionId}/draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        notes: formData.notes,
        dynamicFields: formData.dynamicFields
      }),
    })

    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(errorData.error || 'Failed to save draft')
    }

    // Redirect back to action details
    router.push(`/action/${actionId}?token=${token}`)
  }

  function handleCancel() {
    router.push(`/action/${actionId}?token=${token}`)
  }

  if (loading) {
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
        <p style={{ color: theme.colors.textMuted }}>Načítání akce...</p>
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
    <Card style={{ width: '100%', maxWidth: '672px', margin: '0 auto', padding: theme.spacing.lg }}>
      <div style={{ marginBottom: theme.spacing.lg }}>
        <h1 style={{ fontSize: theme.typography.sizes.xxl, fontWeight: theme.typography.weights.bold, color: theme.colors.text, marginBottom: theme.spacing.xs }}>Upravit akci</h1>
        <div style={{ fontSize: theme.typography.sizes.sm, color: theme.colors.textMuted }}>
          <p style={{ fontWeight: theme.typography.weights.semibold }}>{data.cp.name || data.cp.primary_identifier}</p>
          <p>{data.conversation.topic}</p>
        </div>
      </div>

      <EditForm
        action={data.action}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
      />
    </Card>
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

export default function EditPage() {
  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: theme.spacing.md }}>
      <Suspense fallback={<LoadingFallback />}>
        <EditContent />
      </Suspense>
    </main>
  )
}
