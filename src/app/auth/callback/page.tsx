'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'

function CallbackContent() {
  const searchParams = useSearchParams()
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [message, setMessage] = useState('')

  useEffect(() => {
    handleCallback()
  }, [])

  async function handleCallback() {
    const code = searchParams.get('code')
    const state = searchParams.get('state')
    const error = searchParams.get('error')

    if (error) {
      setStatus('error')
      setMessage(`Google authentication failed: ${error}`)
      return
    }

    if (!code || !state) {
      setStatus('error')
      setMessage('Missing authorization code or state')
      return
    }

    try {
      const response = await fetch('/api/auth/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, state }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to complete authentication')
      }

      setStatus('success')
      setMessage('Your Google account has been connected successfully!')
    } catch (err) {
      setStatus('error')
      setMessage(err instanceof Error ? err.message : 'An error occurred')
    }
  }

  return (
    <Card className="max-w-md w-full">
      <CardContent className="text-center py-8">
        {status === 'loading' && (
          <>
            <div className="w-12 h-12 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-text-muted">Connecting your account...</p>
          </>
        )}

        {status === 'success' && (
          <>
            <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-8 h-8 text-green-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <h2 className="text-xl font-semibold mb-2">Connected!</h2>
            <p className="text-text-muted mb-6">{message}</p>
            <p className="text-sm text-text-muted">
              Mila is now watching your inbox. You can close this window.
            </p>
          </>
        )}

        {status === 'error' && (
          <>
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
            <h2 className="text-xl font-semibold mb-2">Connection Failed</h2>
            <p className="text-text-muted mb-6">{message}</p>
            <Button variant="primary" onClick={() => window.location.href = '/auth/connect'}>
              Try Again
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function LoadingFallback() {
  return (
    <Card className="max-w-md w-full">
      <CardContent className="text-center py-8">
        <div className="w-12 h-12 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p className="text-text-muted">Loading...</p>
      </CardContent>
    </Card>
  )
}

export default function CallbackPage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <Suspense fallback={<LoadingFallback />}>
        <CallbackContent />
      </Suspense>
    </main>
  )
}
