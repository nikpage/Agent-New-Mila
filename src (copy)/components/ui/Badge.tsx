'use client'

import { forwardRef, HTMLAttributes, ReactNode } from 'react'
import { theme } from '@/config/theme'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'primary' | 'accent' | 'success' | 'warning' | 'danger'
  children: ReactNode
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ variant = 'default', children, style, ...props }, ref) => {

    const getVariantStyle = () => {
      switch (variant) {
        case 'primary':
          return { backgroundColor: '#dbeafe', color: theme.colors.primary }
        case 'accent':
          return { backgroundColor: '#ffedd5', color: theme.colors.accent }
        case 'success':
          return { backgroundColor: theme.colors.successBg, color: theme.colors.success }
        case 'warning':
          return { backgroundColor: theme.colors.warningBg, color: theme.colors.warning }
        case 'danger':
          return { backgroundColor: theme.colors.errorBg, color: theme.colors.error }
        default:
          return { backgroundColor: theme.colors.secondary, color: theme.colors.textMuted }
      }
    }

    const combinedStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      padding: '2px 8px',
      borderRadius: theme.borderRadius.sm,
      fontSize: theme.typography.sizes.xs,
      fontWeight: theme.typography.weights.medium,
      ...getVariantStyle(),
      ...style,
    }

    return (
      <span ref={ref} style={combinedStyle} {...props}>
        {children}
      </span>
    )
  }
)

Badge.displayName = 'Badge'
