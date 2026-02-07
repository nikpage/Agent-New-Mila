'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardHeader, CardContent, CardFooter } from '@/components/ui/Card'
import { theme } from '@/config/theme'

export default function ConnectPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleConnect() {
    if (!email) {
      setError('Please enter your email address')
      return
    }

    setLoading(true)
    setError(null)

    try {
      // Call API to initiate OAuth flow
      const response = await fetch('/api/auth/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to initiate connection')
      }

      const { authUrl } = await response.json()

      // Redirect to Google OAuth
      window.location.href = authUrl
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
      setLoading(false)
    }
  }

  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: theme.spacing.md }}>
      <Card style={{ maxWidth: '448px', width: '100%' }}>
        <CardHeader>
          <h1 style={{ fontSize: theme.typography.sizes.xl, fontWeight: theme.typography.weights.semibold, color: theme.colors.text }}>Connect Your Google Account</h1>
          <p style={{ fontSize: theme.typography.sizes.sm, color: theme.colors.textMuted, marginTop: theme.spacing.xs }}>
            Mila needs access to your Gmail and Calendar to manage your communications.
          </p>
        </CardHeader>

        <CardContent style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
          <Input
            label="Email Address"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@example.com"
            error={error || undefined}
          />

          <div style={{ fontSize: theme.typography.sizes.sm, color: theme.colors.textMuted }}>
            <p style={{ marginBottom: theme.spacing.xs }}>Mila will be able to:</p>
            <ul style={{ listStyleType: 'disc', listStylePosition: 'inside', paddingLeft: theme.spacing.sm }}>
              <li>Read your emails to understand conversations</li>
              <li>Send emails on your behalf (only when you approve)</li>
              <li>Read your calendar to check availability</li>
              <li>Create calendar events (only when you approve)</li>
            </ul>
          </div>
        </CardContent>

        <CardFooter>
          <Button
            variant="primary"
            onClick={handleConnect}
            loading={loading}
            style={{ width: '100%' }}
          >
            Connect with Google
          </Button>
        </CardFooter>
      </Card>
    </main>
  )
}
