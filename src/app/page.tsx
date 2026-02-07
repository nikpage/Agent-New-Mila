/**
 * Mila - Home page
 * This is not a user-facing app, it's an agent.
 * This page shows status and provides OAuth setup.
 */

import { Card } from '@/components/ui/Card'
import { theme } from '@/config/theme'

export default function HomePage() {
  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: theme.spacing.md }}>
      <Card style={{ maxWidth: '448px', width: '100%', padding: theme.spacing.xl, textAlign: 'center' }}>
        <div style={{
          width: '64px',
          height: '64px',
          backgroundColor: '#dbeafe',
          borderRadius: theme.borderRadius.full,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: `0 auto ${theme.spacing.lg} auto`
        }}>
          <svg
            style={{ width: '32px', height: '32px', color: theme.colors.primary }}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
            />
          </svg>
        </div>

        <h1 style={{ fontSize: theme.typography.sizes.xxl, fontWeight: theme.typography.weights.semibold, marginBottom: theme.spacing.sm, color: theme.colors.text }}>Mila</h1>
        <p style={{ color: theme.colors.textMuted, marginBottom: theme.spacing.xl }}>
          Your AI-powered executive assistant
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
          <a
            href="/auth/connect"
            style={{
              display: 'block',
              width: '100%',
              padding: `${theme.spacing.sm} ${theme.spacing.md}`,
              backgroundColor: theme.colors.primary,
              color: theme.colors.textLight,
              borderRadius: theme.borderRadius.md,
              fontWeight: theme.typography.weights.medium,
              textAlign: 'center',
              textDecoration: 'none',
              transition: 'background-color 0.2s'
            }}
          >
            Connect Google Account
          </a>

          <a
            href="/api/health"
            style={{
              display: 'block',
              width: '100%',
              padding: `${theme.spacing.sm} ${theme.spacing.md}`,
              backgroundColor: 'transparent',
              border: `1px solid ${theme.colors.border}`,
              color: theme.colors.text,
              borderRadius: theme.borderRadius.md,
              fontWeight: theme.typography.weights.medium,
              textAlign: 'center',
              textDecoration: 'none',
              transition: 'background-color 0.2s'
            }}
          >
            Check System Status
          </a>
        </div>

        <p style={{ color: theme.colors.textMuted, fontSize: theme.typography.sizes.sm, marginTop: theme.spacing.xl }}>
          Mila manages your decisions, not your emails.
        </p>
      </Card>
    </main>
  )
}
