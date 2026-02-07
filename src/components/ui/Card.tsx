'use client'

import { forwardRef, HTMLAttributes, ReactNode, useState } from 'react'
import { theme } from '@/config/theme'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  hover?: boolean
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ children, hover = false, style, ...props }, ref) => {
    const [isHovered, setIsHovered] = useState(false)

    const baseStyle = {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borderRadius.lg,
      border: `1px solid ${theme.colors.border}`,
      boxShadow: isHovered && hover ? theme.shadows.hover : theme.shadows.card,
      transition: 'all 0.2s ease',
      cursor: hover ? 'pointer' : 'default',
      ...style,
    }

    return (
      <div
        ref={ref}
        style={baseStyle}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        {...props}
      >
        {children}
      </div>
    )
  }
)

Card.displayName = 'Card'

export interface CardHeaderProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

export const CardHeader = forwardRef<HTMLDivElement, CardHeaderProps>(
  ({ children, style, ...props }, ref) => {
    return (
      <div
        ref={ref}
        style={{
          padding: `${theme.spacing.md} ${theme.spacing.lg}`,
          borderBottom: `1px solid ${theme.colors.border}`,
          ...style
        }}
        {...props}
      >
        {children}
      </div>
    )
  }
)

CardHeader.displayName = 'CardHeader'

export interface CardContentProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

export const CardContent = forwardRef<HTMLDivElement, CardContentProps>(
  ({ children, style, ...props }, ref) => {
    return (
      <div
        ref={ref}
        style={{
          padding: `${theme.spacing.md} ${theme.spacing.lg}`,
          ...style
        }}
        {...props}
      >
        {children}
      </div>
    )
  }
)

CardContent.displayName = 'CardContent'

export interface CardFooterProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

export const CardFooter = forwardRef<HTMLDivElement, CardFooterProps>(
  ({ children, style, ...props }, ref) => {
    return (
      <div
        ref={ref}
        style={{
          padding: `${theme.spacing.md} ${theme.spacing.lg}`,
          borderTop: `1px solid ${theme.colors.border}`,
          ...style
        }}
        {...props}
      >
        {children}
      </div>
    )
  }
)

CardFooter.displayName = 'CardFooter'
