'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardHeader, CardContent, CardFooter } from '@/components/ui/Card'

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
    <main className="min-h-screen flex items-center justify-center p-4">
      <Card className="max-w-md w-full">
        <CardHeader>
          <h1 className="text-xl font-semibold">Connect Your Google Account</h1>
          <p className="text-sm text-text-muted mt-1">
            Mila needs access to your Gmail and Calendar to manage your communications.
          </p>
        </CardHeader>

        <CardContent className="space-y-4">
          <Input
            label="Email Address"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@example.com"
            error={error || undefined}
          />

          <div className="text-sm text-text-muted space-y-2">
            <p>Mila will be able to:</p>
            <ul className="list-disc list-inside space-y-1 ml-2">
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
            className="w-full"
          >
            Connect with Google
          </Button>
        </CardFooter>
      </Card>
    </main>
  )
}
