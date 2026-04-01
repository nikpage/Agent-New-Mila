'use client'

import { useRef, useEffect, useState, useCallback } from 'react'
import { theme } from '@/config/theme'
import { ReplyCard } from './ReplyCard'
import { ScheduleCard } from './ScheduleCard'
import { TodoCard } from './TodoCard'
import { ConflictSection } from './ConflictSection'
import type { BriefAction } from './types'
import type { ConflictCardData } from '@/components/action/action-card-template'

interface BriefCardProps {
  action: BriefAction
  token: string
  expanded: boolean
  onToggle: () => void
  onExecute: () => Promise<void>
  onConvertTodo: () => Promise<void>
  onDismiss: () => Promise<void>
  onPostpone: (postponeTo: string) => Promise<void>
  onRegenerateDraft: (instruction: string) => Promise<{ subject: string; body: string }>
  onSaveDraft: (data: { meetingType?: string; dynamicFields?: Record<string, string>; notes?: string }) => Promise<void>
  /** Card has been acted on (done/sent) */
  done?: boolean
}

function getUrgencySignal(urgency: number): string {
  if (urgency >= 10) return '🔥🔥🔥 '
  if (urgency >= 9) return '🔥 '
  return ''
}

export function BriefCard({
  action, token, expanded, onToggle,
  onExecute, onConvertTodo, onDismiss, onPostpone,
  onRegenerateDraft, onSaveDraft, done,
}: BriefCardProps) {
  const headline = action.headline || action.cpName || 'Akce'
  const story = action.story || action.intent_cs || action.rationale_cs || action.rationale
  const urgencySignal = getUrgencySignal(action.urgency)

  const payload = action.payload as Record<string, unknown> | null
  const conflicts = (payload?.conflicts as ConflictCardData[]) || []
  const hasConflicts = conflicts.filter(c => !(c as Record<string, unknown>).resolved).length > 0

  // Animate expanded content height
  const contentRef = useRef<HTMLDivElement>(null)
  const [contentHeight, setContentHeight] = useState<number>(0)
  const [animating, setAnimating] = useState(false)

  useEffect(() => {
    if (expanded && contentRef.current) {
      // Measure the natural height
      const h = contentRef.current.scrollHeight
      setContentHeight(h)
      setAnimating(true)
      const timer = setTimeout(() => setAnimating(false), 300)
      return () => clearTimeout(timer)
    } else {
      setAnimating(true)
      setContentHeight(0)
      const timer = setTimeout(() => setAnimating(false), 300)
      return () => clearTimeout(timer)
    }
  }, [expanded])

  // Re-measure when content changes (draft loads, etc.)
  useEffect(() => {
    if (expanded && contentRef.current) {
      const observer = new ResizeObserver(() => {
        if (contentRef.current && !animating) {
          setContentHeight(contentRef.current.scrollHeight)
        }
      })
      observer.observe(contentRef.current)
      return () => observer.disconnect()
    }
  }, [expanded, animating])

  // Swipe gesture state (collapsed cards only)
  const swipeRef = useRef<HTMLDivElement>(null)
  const touchStartX = useRef(0)
  const touchStartY = useRef(0)
  const [swipeX, setSwipeX] = useState(0)
  const [swiping, setSwiping] = useState(false)
  const [swipedAway, setSwipedAway] = useState(false)
  const SWIPE_THRESHOLD = 100

  const primaryCta = action.action_type === 'REPLY' ? 'Odeslat'
    : action.action_type === 'SCHEDULE' ? 'Potvrdit'
    : 'Hotovo'

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (expanded) return
    touchStartX.current = e.touches[0].clientX
    touchStartY.current = e.touches[0].clientY
    setSwiping(false)
  }, [expanded])

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (expanded) return
    const dx = e.touches[0].clientX - touchStartX.current
    const dy = e.touches[0].clientY - touchStartY.current
    // Only swipe if horizontal movement > vertical (prevent scroll hijack)
    if (!swiping && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      setSwiping(true)
    }
    if (swiping) {
      e.preventDefault()
      setSwipeX(dx)
    }
  }, [expanded, swiping])

  const onTouchEnd = useCallback(async () => {
    if (expanded || !swiping) {
      setSwipeX(0)
      setSwiping(false)
      return
    }
    if (swipeX > SWIPE_THRESHOLD) {
      // Swipe right — primary action
      setSwipedAway(true)
      setSwipeX(window.innerWidth)
      setTimeout(() => onExecute(), 300)
    } else if (swipeX < -SWIPE_THRESHOLD) {
      // Swipe left — dismiss
      setSwipedAway(true)
      setSwipeX(-window.innerWidth)
      setTimeout(() => onDismiss(), 300)
    } else {
      // Snap back
      setSwipeX(0)
    }
    setSwiping(false)
  }, [expanded, swiping, swipeX, onExecute, onDismiss])

  // Done state
  if (done || swipedAway) {
    return (
      <div style={{
        padding: `${theme.spacing.md} ${theme.spacing.lg}`,
        backgroundColor: theme.colors.surface,
        borderRadius: theme.borderRadius.lg,
        border: `1px solid ${theme.colors.border}`,
        display: 'flex',
        alignItems: 'center',
        gap: theme.spacing.md,
        opacity: 0.7,
        transition: 'opacity 0.3s ease',
      }}>
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '24px',
          height: '24px',
          borderRadius: theme.borderRadius.full,
          backgroundColor: theme.colors.successBg,
          color: theme.colors.success,
          fontSize: '14px',
          flexShrink: 0,
        }}>
          ✓
        </span>
        <span style={{
          fontSize: theme.typography.sizes.sm,
          color: theme.colors.textMuted,
          textDecoration: 'line-through',
        }}>
          {headline}
        </span>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', overflow: 'hidden', borderRadius: theme.borderRadius.lg }}>
      {/* Swipe reveal backgrounds */}
      {!expanded && (
        <>
          {/* Right swipe — green (primary action) */}
          <div style={{
            position: 'absolute', top: 0, left: 0, bottom: 0, right: 0,
            backgroundColor: theme.colors.success || '#16a34a',
            borderRadius: theme.borderRadius.lg,
            display: 'flex', alignItems: 'center', paddingLeft: '24px',
            opacity: swipeX > 30 ? Math.min(1, swipeX / SWIPE_THRESHOLD) : 0,
            transition: swiping ? 'none' : 'opacity 0.2s ease',
          }}>
            <span style={{ color: 'white', fontWeight: 600, fontSize: theme.typography.sizes.sm }}>{primaryCta}</span>
          </div>
          {/* Left swipe — red (dismiss) */}
          <div style={{
            position: 'absolute', top: 0, left: 0, bottom: 0, right: 0,
            backgroundColor: '#dc2626',
            borderRadius: theme.borderRadius.lg,
            display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: '24px',
            opacity: swipeX < -30 ? Math.min(1, Math.abs(swipeX) / SWIPE_THRESHOLD) : 0,
            transition: swiping ? 'none' : 'opacity 0.2s ease',
          }}>
            <span style={{ color: 'white', fontWeight: 600, fontSize: theme.typography.sizes.sm }}>Zrušit</span>
          </div>
        </>
      )}
      <div
        ref={swipeRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{
          backgroundColor: theme.colors.surface,
          borderRadius: theme.borderRadius.lg,
          border: `1px solid ${theme.colors.border}`,
          boxShadow: expanded ? theme.shadows.hover : theme.shadows.card,
          overflow: 'hidden',
          transition: swiping ? 'none' : 'transform 0.3s ease, box-shadow 0.3s ease',
          transform: !expanded && swipeX !== 0 ? `translateX(${swipeX}px)` : 'translateX(0)',
          position: 'relative',
          zIndex: 1,
        }}>
      {/* Header — always visible, tappable */}
      <button
        onClick={onToggle}
        style={{
          display: 'block',
          width: '100%',
          textAlign: 'left',
          padding: expanded
            ? `${theme.spacing.lg} ${theme.spacing.lg} ${theme.spacing.sm}`
            : `${theme.spacing.md} ${theme.spacing.lg}`,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          transition: 'padding 0.3s ease',
        }}
      >
        <div style={{
          fontSize: expanded ? theme.typography.sizes.lg : theme.typography.sizes.base,
          fontWeight: theme.typography.weights.semibold,
          color: theme.colors.text,
          lineHeight: 1.4,
          marginBottom: theme.spacing.xs,
          transition: 'font-size 0.3s ease',
        }}>
          {urgencySignal}{headline}
        </div>
        <div style={{
          fontSize: theme.typography.sizes.sm,
          color: theme.colors.textMuted,
          lineHeight: expanded ? 1.6 : 1.5,
          ...(!expanded ? {
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical' as const,
            overflow: 'hidden',
          } : {}),
        }}>
          {story}
        </div>
      </button>

      {/* Animated expandable content */}
      <div style={{
        height: expanded ? (animating ? `${contentHeight}px` : 'auto') : '0px',
        overflow: 'hidden',
        transition: 'height 0.3s ease',
      }}>
        <div ref={contentRef}>
          {/* Conflict section (SCHEDULE only) */}
          {hasConflicts && action.action_type === 'SCHEDULE' && (
            <div style={{ padding: `0 ${theme.spacing.lg} ${theme.spacing.md}` }}>
              <ConflictSection
                conflicts={conflicts}
                cpName={action.cpName || ''}
                actionId={action.id}
                token={token}
              />
            </div>
          )}

          {/* Type-specific expanded content */}
          <div style={{ padding: `0 ${theme.spacing.lg} ${theme.spacing.lg}` }}>
            {action.action_type === 'REPLY' && (
              <ReplyCard
                action={action}
                token={token}
                onExecute={onExecute}
                onConvertTodo={onConvertTodo}
                onRegenerateDraft={onRegenerateDraft}
              />
            )}
            {action.action_type === 'SCHEDULE' && (
              <ScheduleCard
                action={action}
                token={token}
                onExecute={onExecute}
                onConvertTodo={onConvertTodo}
                onRegenerateDraft={onRegenerateDraft}
                onSaveDraft={onSaveDraft}
              />
            )}
            {action.action_type === 'TODO' && (
              <TodoCard
                action={action}
                onComplete={onExecute}
                onPostpone={onPostpone}
                onDismiss={onDismiss}
              />
            )}
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}
