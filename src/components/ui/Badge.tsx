'use client'

import { forwardRef, HTMLAttributes, ReactNode } from 'react'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'primary' | 'accent' | 'success' | 'warning' | 'danger'
  children: ReactNode
}

const variants = {
  default: 'badge bg-primary-light/50 text-text-muted',
  primary: 'badge-primary',
  accent: 'badge-accent',
  success: 'badge-success',
  warning: 'badge-warning',
  danger: 'badge-danger',
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ variant = 'default', children, className = '', ...props }, ref) => {
    return (
      <span ref={ref} className={`${variants[variant]} ${className}`} {...props}>
        {children}
      </span>
    )
  }
)

Badge.displayName = 'Badge'
