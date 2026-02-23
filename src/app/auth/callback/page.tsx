'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { theme } from '@/config/theme'

function CallbackContent() {
  const searchParams = useSearchParams()
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [message, setMessage] = useState('')

  // Guard against React 18 Strict Mode double-invocation.
  // Google authorization codes are single-use — a second POST with the same
  // code fails, and the error would overwrite the first successful result.
  const hasRun = useRef(false)
  useEffect(() => {
    if (hasRun.current) return
    hasRun.current = true
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
    <Card style={{ maxWidth: '448px', width: '100%' }}>
      <CardContent style={{ textAlign: 'center', padding: theme.spacing.xl }}>
        {status === 'loading' && (
          <>
            <div className="animate-spin" style={{
              width: '48px',
              height: '48px',
              border: `2px solid ${theme.colors.primary}`,
              borderTopColor: 'transparent',
              borderRadius: '50%',
              margin: `0 auto ${theme.spacing.md} auto`
            }} />
            <p style={{ color: theme.colors.textMuted }}>Connecting your account...</p>
          </>
        )}

        {status === 'success' && (
          <>
            <div style={{
              width: '64px',
              height: '64px',
              backgroundColor: theme.colors.successBg,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: `0 auto ${theme.spacing.md} auto`
            }}>
              <svg
                style={{ width: '32px', height: '32px', color: theme.colors.success }}
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
            <h2 style={{ fontSize: theme.typography.sizes.xl, fontWeight: theme.typography.weights.semibold, marginBottom: theme.spacing.sm, color: theme.colors.text }}>Connected!</h2>
            <p style={{ color: theme.colors.textMuted, marginBottom: theme.spacing.lg }}>{message}</p>
            <p style={{ fontSize: theme.typography.sizes.sm, color: theme.colors.textMuted }}>
              Mila is now watching your inbox. You can close this window.
            </p>
          </>
        )}

        {status === 'error' && (
          <>
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
            <h2 style={{ fontSize: theme.typography.sizes.xl, fontWeight: theme.typography.weights.semibold, marginBottom: theme.spacing.sm, color: theme.colors.text }}>Connection Failed</h2>
            <p style={{ color: theme.colors.textMuted, marginBottom: theme.spacing.lg }}>{message}</p>
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
    <Card style={{ maxWidth: '448px', width: '100%' }}>
      <CardContent style={{ textAlign: 'center', padding: theme.spacing.xl }}>
        <div className="animate-spin" style={{
          width: '48px',
          height: '48px',
          border: `2px solid ${theme.colors.primary}`,
          borderTopColor: 'transparent',
          borderRadius: '50%',
          margin: `0 auto ${theme.spacing.md} auto`
        }} />
        <p style={{ color: theme.colors.textMuted }}>Loading...</p>
      </CardContent>
    </Card>
  )
}

export default function CallbackPage() {
  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: theme.spacing.md }}>
      <Suspense fallback={<LoadingFallback />}>
        <CallbackContent />
      </Suspense>
    </main>
  )
}
