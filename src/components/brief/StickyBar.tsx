'use client'

import { useState } from 'react'
import { theme } from '@/config/theme'

interface StickyBarProps {
  /** When null, show command input. When set, show card CTAs. */
  activeCardType: string | null
  onCommand: (command: string) => Promise<void>
}

/**
 * Sticky bottom bar — context-shifts based on state.
 * Card expanded → shows that card's CTAs (handled by card itself for now).
 * No card expanded → text input for Mila commands.
 */
export function StickyBar({ activeCardType, onCommand }: StickyBarProps) {
  const [command, setCommand] = useState('')
  const [sending, setSending] = useState(false)

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

  // When a card is expanded, the card renders its own CTAs
  if (activeCardType) return null

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      padding: `${theme.spacing.sm} ${theme.spacing.md}`,
      paddingBottom: `max(${theme.spacing.sm}, env(safe-area-inset-bottom))`,
      backgroundColor: theme.colors.surface,
      borderTop: `1px solid ${theme.colors.border}`,
      boxShadow: '0 -2px 8px rgba(0,0,0,0.08)',
      zIndex: 40,
    }}>
      <form
        onSubmit={handleSubmit}
        style={{
          display: 'flex',
          gap: theme.spacing.sm,
          maxWidth: '672px',
          margin: '0 auto',
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
            padding: `${theme.spacing.sm} ${theme.spacing.md}`,
            border: `1px solid ${theme.colors.border}`,
            borderRadius: theme.borderRadius.md,
            fontSize: theme.typography.sizes.base,
            color: theme.colors.text,
            backgroundColor: theme.colors.background,
            outline: 'none',
          }}
        />
        <button
          type="submit"
          disabled={!command.trim() || sending}
          style={{
            padding: `${theme.spacing.sm} ${theme.spacing.md}`,
            backgroundColor: command.trim() ? theme.colors.primary : theme.colors.secondary,
            color: command.trim() ? 'white' : theme.colors.textMuted,
            border: 'none',
            borderRadius: theme.borderRadius.md,
            cursor: command.trim() ? 'pointer' : 'default',
            fontWeight: theme.typography.weights.medium,
            fontSize: theme.typography.sizes.sm,
            opacity: sending ? 0.6 : 1,
          }}
        >
          {sending ? '...' : '→'}
        </button>
      </form>
    </div>
  )
}
