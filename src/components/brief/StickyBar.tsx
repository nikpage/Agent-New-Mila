'use client'

import { useState } from 'react'
import { theme } from '@/config/theme'
import type { StickyBarCTA } from './types'

interface StickyBarProps {
  /** CTAs from the expanded card. Null = show command input */
  ctas: StickyBarCTA[] | null
  onCommand: (command: string) => Promise<void>
}

export function StickyBar({ ctas, onCommand }: StickyBarProps) {
  const [command, setCommand] = useState('')
  const [sending, setSending] = useState(false)
  const [ctaLoading, setCtaLoading] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!command.trim() || sending) return
    setSending(true)
    try {
      await onCommand(command.trim())
      setCommand('')
    } finally {
      setSending(false)
    }
  }

  async function handleCta(cta: StickyBarCTA) {
    if (cta.disabled) return
    setCtaLoading(cta.label)
    try {
      await cta.action()
    } finally {
      setCtaLoading(null)
    }
  }

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: theme.colors.surface,
      borderTop: `1px solid ${theme.colors.border}`,
      boxShadow: '0 -2px 12px rgba(0,0,0,0.06)',
      zIndex: 40,
      paddingBottom: 'env(safe-area-inset-bottom, 0px)',
    }}>
      <div style={{
        maxWidth: '768px',
        margin: '0 auto',
        padding: `${theme.spacing.sm} ${theme.spacing.md}`,
      }}>
        {ctas ? (
          /* ── Card CTAs ─────────────────────────────────────── */
          <div style={{
            display: 'flex',
            gap: theme.spacing.sm,
            alignItems: 'center',
          }}>
            {ctas.map(cta => (
              <button
                key={cta.label}
                onClick={() => handleCta(cta)}
                disabled={cta.disabled || ctaLoading !== null}
                style={{
                  padding: `10px ${theme.spacing.lg}`,
                  backgroundColor: cta.primary
                    ? theme.colors.primary
                    : cta.destructive
                      ? 'transparent'
                      : theme.colors.secondary,
                  color: cta.primary
                    ? 'white'
                    : cta.destructive
                      ? theme.colors.textMuted
                      : theme.colors.text,
                  border: 'none',
                  borderRadius: theme.borderRadius.md,
                  cursor: cta.disabled ? 'not-allowed' : 'pointer',
                  fontWeight: cta.primary ? theme.typography.weights.semibold : theme.typography.weights.medium,
                  fontSize: theme.typography.sizes.base,
                  flex: cta.primary ? 1 : undefined,
                  opacity: ctaLoading === cta.label ? 0.6 : ctaLoading !== null ? 0.8 : 1,
                  transition: 'opacity 0.15s ease, background-color 0.15s ease',
                }}
              >
                {ctaLoading === cta.label ? '...' : cta.label}
              </button>
            ))}
          </div>
        ) : (
          /* ── Command input + icons ─────────────────────────── */
          <form
            onSubmit={handleSubmit}
            style={{
              display: 'flex',
              gap: theme.spacing.sm,
              alignItems: 'center',
            }}
          >
            <input
              type="text"
              value={command}
              onChange={e => setCommand(e.target.value)}
              placeholder="Napište Míle..."
              disabled={sending}
              style={{
                flex: 1,
                padding: `10px ${theme.spacing.md}`,
                border: `1px solid ${theme.colors.border}`,
                borderRadius: theme.borderRadius.lg,
                fontSize: theme.typography.sizes.base,
                color: theme.colors.text,
                backgroundColor: theme.colors.background,
                outline: 'none',
              }}
            />
            {/* Voice notes placeholder */}
            <button
              type="button"
              title="Hlasová poznámka (brzy)"
              style={{
                width: '40px',
                height: '40px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: theme.borderRadius.full,
                border: `1px solid ${theme.colors.border}`,
                backgroundColor: theme.colors.surface,
                color: theme.colors.textMuted,
                cursor: 'default',
                fontSize: '18px',
                flexShrink: 0,
                opacity: 0.5,
              }}
            >
              🎤
            </button>
            {/* Settings */}
            <button
              type="button"
              title="Nastavení"
              style={{
                width: '40px',
                height: '40px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: theme.borderRadius.full,
                border: `1px solid ${theme.colors.border}`,
                backgroundColor: theme.colors.surface,
                color: theme.colors.textMuted,
                cursor: 'pointer',
                fontSize: '18px',
                flexShrink: 0,
              }}
            >
              ⚙
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
