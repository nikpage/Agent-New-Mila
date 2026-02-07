'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { theme } from '@/config/theme'

interface SuccessOverlayProps {
  message: string
  subMessage?: string
  autoCloseSeconds?: number
  onClose?: () => void
}

export function SuccessOverlay({
  message,
  subMessage,
  autoCloseSeconds = 3,
  onClose,
}: SuccessOverlayProps) {
  const [countdown, setCountdown] = useState(autoCloseSeconds)

  useEffect(() => {
    if (countdown <= 0) {
      handleClose()
      return
    }

    const timer = setTimeout(() => {
      setCountdown(c => c - 1)
    }, 1000)

    return () => clearTimeout(timer)
  }, [countdown])

  const handleClose = () => {
    try {
      window.close()
    } catch {
      if (onClose) {
        onClose()
      }
    }
  }

  return (
    <div
      className="animate-fade-in"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: theme.colors.background,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50
      }}
    >
      <div style={{ textAlign: 'center', padding: theme.spacing.xl, maxWidth: '448px' }}>
        {/* Success icon */}
        <div style={{
          width: '80px',
          height: '80px',
          backgroundColor: theme.colors.successBg,
          borderRadius: theme.borderRadius.full,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: `0 auto ${theme.spacing.lg} auto`
        }}>
          <svg
            style={{ width: '40px', height: '40px', color: theme.colors.success }}
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

        <h2 style={{ fontSize: theme.typography.sizes.xxl, fontWeight: theme.typography.weights.semibold, marginBottom: theme.spacing.sm, color: theme.colors.text }}>
          {message}
        </h2>

        {subMessage && (
          <p style={{ color: theme.colors.textMuted, marginBottom: theme.spacing.lg }}>{subMessage}</p>
        )}

        <p style={{ fontSize: theme.typography.sizes.sm, color: theme.colors.textMuted, marginBottom: theme.spacing.md }}>
          This window will close in {countdown} seconds
        </p>

        <Button variant="outline" onClick={handleClose}>
          Close Now
        </Button>
      </div>
    </div>
  )
}
