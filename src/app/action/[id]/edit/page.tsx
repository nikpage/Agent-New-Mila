'use client'

import { Suspense, useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { EditForm } from '@/components/action/EditForm'
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
      <div className="text-center">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p className="text-text-muted">Načítání akce...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-center max-w-md">
        <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg
            className="w-8 h-8 text-red-400"
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
        <h2 className="text-xl font-semibold mb-2">Chyba</h2>
        <p className="text-text-muted">{error}</p>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="text-center">
        <p className="text-text-muted">Akce nenalezena</p>
      </div>
    )
  }

  return (
    <div className="card w-full max-w-2xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text mb-2">Upravit akci</h1>
        <div className="text-sm text-text-muted">
          <p className="font-semibold">{data.cp.name || data.cp.primary_identifier}</p>
          <p>{data.conversation.topic}</p>
        </div>
      </div>

      <EditForm
        action={data.action}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
      />
    </div>
  )
}

function LoadingFallback() {
  return (
    <div className="text-center">
      <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-4" />
      <p className="text-text-muted">Načítání...</p>
    </div>
  )
}

export default function EditPage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <Suspense fallback={<LoadingFallback />}>
        <EditContent />
      </Suspense>
    </main>
  )
}
