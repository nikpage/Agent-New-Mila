'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'

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
    // Try to close the window/tab
    try {
      window.close()
    } catch {
      // If we can't close, redirect to a blank page or call onClose
      if (onClose) {
        onClose()
      }
    }
  }

  return (
    <div className="fixed inset-0 bg-background/95 flex items-center justify-center z-50 animate-fade-in">
      <div className="text-center p-8 max-w-md">
        {/* Success icon */}
        <div className="w-20 h-20 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
          <svg
            className="w-10 h-10 text-green-400"
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

        <h2 className="text-2xl font-semibold mb-2">{message}</h2>

        {subMessage && (
          <p className="text-text-muted mb-6">{subMessage}</p>
        )}

        <p className="text-sm text-text-muted mb-4">
          This window will close in {countdown} seconds
        </p>

        <Button variant="outline" onClick={handleClose}>
          Close Now
        </Button>
      </div>
    </div>
  )
}
