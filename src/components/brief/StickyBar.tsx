'use client'

import { useState } from 'react'

interface StickyBarProps {
  onCommand: (command: string) => Promise<void>
}

export function StickyBar({ onCommand }: StickyBarProps) {
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

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      background: 'var(--bar)',
      borderTop: '1px solid var(--bar-brd)',
      padding: '10px 16px 16px',
      transition: 'background .3s, border-color .3s',
      zIndex: 40,
      paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
    }}>
      <form
        onSubmit={handleSubmit}
        style={{
          maxWidth: '460px',
          margin: '0 auto',
          display: 'flex',
          gap: '8px',
          alignItems: 'center',
        }}
      >
        {/* Voice button (placeholder) */}
        <button
          type="button"
          style={{
            width: '36px',
            height: '36px',
            borderRadius: '50%',
            background: 'var(--surf)',
            border: '1px solid var(--brd)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            outline: 'none',
            opacity: 0.45,
            transition: 'background .3s',
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--sub)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        </button>

        {/* Text input */}
        <input
          type="text"
          value={command}
          onChange={e => setCommand(e.target.value)}
          placeholder="Napište Mile..."
          disabled={sending}
          style={{
            flex: 1,
            background: 'var(--bg)',
            border: '1px solid var(--brd)',
            borderRadius: '10px',
            padding: '9px 14px',
            fontSize: '13.5px',
            color: 'var(--txt)',
            outline: 'none',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            transition: 'background .3s, border-color .3s, color .3s',
          }}
        />

        {/* Send button */}
        <button
          type="submit"
          disabled={sending || !command.trim()}
          style={{
            width: '36px',
            height: '36px',
            borderRadius: '50%',
            background: 'var(--pbg)',
            border: 'none',
            cursor: sending || !command.trim() ? 'default' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            outline: 'none',
            opacity: sending || !command.trim() ? 0.5 : 1,
            transition: 'transform .08s ease, opacity .2s',
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </form>
    </div>
  )
}
