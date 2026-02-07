'use client'

import { forwardRef, InputHTMLAttributes, TextareaHTMLAttributes, ReactNode, useState } from 'react'
import { theme } from '@/config/theme'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  icon?: ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, icon, style, id, ...props }, ref) => {
    const inputId = id || label?.toLowerCase().replace(/\s/g, '-')
    const [isFocused, setIsFocused] = useState(false)

    const containerStyle = {
      width: '100%',
      marginBottom: theme.spacing.md,
    }

    const labelStyle = {
      display: 'block',
      fontSize: theme.typography.sizes.sm,
      fontWeight: theme.typography.weights.medium,
      color: theme.colors.textMuted,
      marginBottom: theme.spacing.xs,
    }

    const inputWrapperStyle = {
      position: 'relative' as const,
    }

    const inputStyle = {
      width: '100%',
      padding: `${theme.spacing.sm} ${theme.spacing.md}`,
      paddingLeft: icon ? '40px' : theme.spacing.md,
      backgroundColor: theme.colors.surface,
      border: `1px solid ${error ? theme.colors.error : isFocused ? theme.colors.primary : theme.colors.border}`,
      borderRadius: theme.borderRadius.md,
      color: theme.colors.text,
      fontSize: theme.typography.sizes.base,
      outline: 'none',
      boxShadow: isFocused ? `0 0 0 2px ${error ? '#fecaca' : '#bfdbfe'}` : 'none',
      transition: 'all 0.15s ease',
      ...style,
    }

    const iconStyle = {
      position: 'absolute' as const,
      top: '50%',
      left: theme.spacing.sm,
      transform: 'translateY(-50%)',
      color: theme.colors.textMuted,
      pointerEvents: 'none' as const,
      display: 'flex',
    }

    const errorStyle = {
      marginTop: theme.spacing.xs,
      fontSize: theme.typography.sizes.sm,
      color: theme.colors.error,
    }

    return (
      <div style={containerStyle}>
        {label && (
          <label htmlFor={inputId} style={labelStyle}>
            {label}
          </label>
        )}
        <div style={inputWrapperStyle}>
          {icon && <div style={iconStyle}>{icon}</div>}
          <input
            ref={ref}
            id={inputId}
            style={inputStyle}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            {...props}
          />
        </div>
        {error && <p style={errorStyle}>{error}</p>}
      </div>
    )
  }
)

Input.displayName = 'Input'

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  error?: string
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, style, id, ...props }, ref) => {
    const inputId = id || label?.toLowerCase().replace(/\s/g, '-')
    const [isFocused, setIsFocused] = useState(false)

    const containerStyle = {
      width: '100%',
      marginBottom: theme.spacing.md,
    }

    const labelStyle = {
      display: 'block',
      fontSize: theme.typography.sizes.sm,
      fontWeight: theme.typography.weights.medium,
      color: theme.colors.textMuted,
      marginBottom: theme.spacing.xs,
    }

    const inputStyle = {
      width: '100%',
      padding: `${theme.spacing.sm} ${theme.spacing.md}`,
      backgroundColor: theme.colors.surface,
      border: `1px solid ${error ? theme.colors.error : isFocused ? theme.colors.primary : theme.colors.border}`,
      borderRadius: theme.borderRadius.md,
      color: theme.colors.text,
      fontSize: theme.typography.sizes.base,
      outline: 'none',
      boxShadow: isFocused ? `0 0 0 2px ${error ? '#fecaca' : '#bfdbfe'}` : 'none',
      transition: 'all 0.15s ease',
      resize: 'vertical' as const,
      minHeight: '100px',
      fontFamily: theme.typography.fontFamily,
      ...style,
    }

    const errorStyle = {
      marginTop: theme.spacing.xs,
      fontSize: theme.typography.sizes.sm,
      color: theme.colors.error,
    }

    return (
      <div style={containerStyle}>
        {label && (
          <label htmlFor={inputId} style={labelStyle}>
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          id={inputId}
          style={inputStyle}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          {...props}
        />
        {error && <p style={errorStyle}>{error}</p>}
      </div>
    )
  }
)

Textarea.displayName = 'Textarea'
