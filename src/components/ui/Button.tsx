'use client'

import { forwardRef, ButtonHTMLAttributes, ReactNode, useState } from 'react'
import { theme } from '@/config/theme'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  icon?: ReactNode
  children: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      icon,
      children,
      style,
      disabled,
      ...props
    },
    ref
  ) => {
    const [isHovered, setIsHovered] = useState(false)
    const [isActive, setIsActive] = useState(false)

    // Size styles
    const sizeStyles = {
      sm: { padding: `${theme.spacing.xs} ${theme.spacing.md}`, fontSize: theme.typography.sizes.sm },
      md: { padding: `${theme.spacing.sm} ${theme.spacing.md}`, fontSize: theme.typography.sizes.base },
      lg: { padding: `${theme.spacing.md} ${theme.spacing.lg}`, fontSize: theme.typography.sizes.lg },
    }

    // Variant styles
    const getVariantStyle = () => {
      switch (variant) {
        case 'primary':
          return {
            backgroundColor: isHovered ? theme.colors.primaryLight : theme.colors.primary,
            color: theme.colors.textLight,
            border: 'none',
          }
        case 'secondary':
          return {
            backgroundColor: isHovered ? theme.colors.secondaryHover : theme.colors.secondary,
            color: theme.colors.text,
            border: 'none',
          }
        case 'ghost':
          return {
            backgroundColor: isHovered ? theme.colors.secondary : 'transparent',
            color: isHovered ? theme.colors.primary : theme.colors.textMuted,
            border: 'none',
          }
        case 'outline':
          return {
            backgroundColor: isHovered ? theme.colors.secondary : 'transparent',
            color: theme.colors.text,
            border: `1px solid ${theme.colors.border}`,
          }
        case 'danger':
          return {
            backgroundColor: isHovered ? '#fee2e2' : '#fef2f2',
            color: theme.colors.error,
            border: `1px solid ${theme.colors.error}`,
          }
        default:
          return {}
      }
    }

    const combinedStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: theme.borderRadius.md,
      fontWeight: theme.typography.weights.medium,
      cursor: disabled || loading ? 'not-allowed' : 'pointer',
      opacity: disabled || loading ? 0.6 : 1,
      transform: isActive && !disabled ? 'scale(0.98)' : 'scale(1)',
      transition: 'all 0.1s ease',
      outline: 'none',
      ...sizeStyles[size],
      ...getVariantStyle(),
      ...style,
    }

    return (
      <button
        ref={ref}
        style={combinedStyle}
        disabled={disabled || loading}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => { setIsHovered(false); setIsActive(false) }}
        onMouseDown={() => setIsActive(true)}
        onMouseUp={() => setIsActive(false)}
        {...props}
      >
        {loading ? (
          <svg
            className="animate-spin"
            style={{ marginRight: theme.spacing.sm, height: '16px', width: '16px' }}
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              style={{ opacity: 0.25 }}
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              style={{ opacity: 0.75 }}
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        ) : icon ? (
          <span style={{ marginRight: theme.spacing.sm, display: 'flex' }}>{icon}</span>
        ) : null}
        {children}
      </button>
    )
  }
)

Button.displayName = 'Button'
