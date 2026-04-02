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
  actionToken: string
  expanded: boolean
  onToggle: () => void
  onExecute: () => Promise<void>
  onConvertTodo: () => Promise<void>
  onDismiss: () => Promise<void>
  onPostpone: (postponeTo: string) => Promise<void>
  onRegenerateDraft: (instruction: string) => Promise<{ subject: string; body: string }>
  onSaveDraft: (data: { meetingType?: string; dynamicFields?: Record<string, string>; notes?: string }) => Promise<void>
  onConvertQuestionTodo?: (question: string) => Promise<void>
  done?: boolean
  showPostponePicker?: boolean
}

/** Urgency badge — positioned dot instead of inline emoji (Item 49) */
function UrgencyBadge({ urgency }: { urgency: number }) {
  if (urgency >= 10) {
    return (
      <>
        <style>{`@keyframes mila-urgency-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.6; transform: scale(1.3); } }`}</style>
        <span style={{
          display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%',
          backgroundColor: theme.colors.error, marginRight: '6px', flexShrink: 0,
          boxShadow: `0 0 6px ${theme.colors.error}`,
          animation: 'mila-urgency-pulse 1.5s ease-in-out infinite',
        }} />
      </>
    )
  }
  if (urgency >= 9) {
    return (
      <span style={{
        display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%',
        backgroundColor: theme.colors.error, marginRight: '6px', flexShrink: 0,
      }} />
    )
  }
  return null
}

function getUrgencyAccent(urgency: number): string | undefined {
  if (urgency >= 9) return theme.colors.error
  if (urgency >= 7) return theme.colors.warning
  return undefined
}

/** Card background tint for extreme urgency (Item 49) */
function getUrgencyBgTint(urgency: number): string | undefined {
  if (urgency >= 10) return theme.colors.errorBg
  return undefined
}

export function BriefCard({
  action, actionToken, expanded, onToggle,
  onExecute, onConvertTodo, onDismiss, onPostpone,
  onRegenerateDraft, onSaveDraft, onConvertQuestionTodo, done, showPostponePicker,
}: BriefCardProps) {
  // Use headline if available, otherwise CP name
  const headline = action.headline || action.cpName || 'Akce'
  // Use story if available, otherwise a SHORT fallback — NOT the full intent_cs wall of text
  const story = action.story || action.rationale_cs || action.topic || null
  const urgencyAccent = getUrgencyAccent(action.urgency)
  const urgencyBgTint = getUrgencyBgTint(action.urgency)

  const payload = action.payload as Record<string, unknown> | null
  const conflicts = (payload?.conflicts as ConflictCardData[]) || []
  const hasConflicts = conflicts.filter(c => !(c as Record<string, unknown>).resolved).length > 0

  // Scroll into view on expand
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (expanded && cardRef.current) {
      const timer = setTimeout(() => {
        cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 380) // after expand animation
      return () => clearTimeout(timer)
    }
  }, [expanded])

  // Animate expanded content
  const contentRef = useRef<HTMLDivElement>(null)
  const [contentHeight, setContentHeight] = useState(0)
  const [animating, setAnimating] = useState(false)

  // Item 46: use rAF to measure after DOM updates — fixes 0-height on first render
  useEffect(() => {
    if (expanded && contentRef.current) {
      requestAnimationFrame(() => {
        if (contentRef.current) setContentHeight(contentRef.current.scrollHeight)
      })
      setAnimating(true)
      const t = setTimeout(() => setAnimating(false), 350)
      return () => clearTimeout(t)
    } else {
      setAnimating(true)
      setContentHeight(0)
      const t = setTimeout(() => setAnimating(false), 350)
      return () => clearTimeout(t)
    }
  }, [expanded])

  useEffect(() => {
    if (expanded && contentRef.current && !animating) {
      const observer = new ResizeObserver(() => {
        if (contentRef.current) setContentHeight(contentRef.current.scrollHeight)
      })
      observer.observe(contentRef.current)
      return () => observer.disconnect()
    }
  }, [expanded, animating])

  // Swipe (collapsed only)
  const touchStartX = useRef(0)
  const touchStartY = useRef(0)
  const [swipeX, setSwipeX] = useState(0)
  const [swiping, setSwiping] = useState(false)
  const [swipedAway, setSwipedAway] = useState(false)
  const SWIPE_THRESHOLD = 100

  const primaryLabel = action.action_type === 'REPLY' ? 'Odeslat'
    : action.action_type === 'SCHEDULE' ? 'Potvrdit' : 'Hotovo'

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
    if (!swiping && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.5) setSwiping(true)
    if (swiping) {
      e.preventDefault()
      setSwipeX(dx)
    }
  }, [expanded, swiping])

  const onTouchEnd = useCallback(async () => {
    if (expanded || !swiping) { setSwipeX(0); setSwiping(false); return }
    if (swipeX > SWIPE_THRESHOLD) {
      setSwipedAway(true); setSwipeX(window.innerWidth)
      setTimeout(() => onExecute(), 300)
    } else if (swipeX < -SWIPE_THRESHOLD) {
      setSwipedAway(true); setSwipeX(-window.innerWidth)
      setTimeout(() => onDismiss(), 300)
    } else {
      setSwipeX(0)
    }
    setSwiping(false)
  }, [expanded, swiping, swipeX, onExecute, onDismiss])

  // Hover state (desktop)
  const [hovered, setHovered] = useState(false)

  // Done / swiped away
  if (done || swipedAway) {
    return (
      <div style={{
        padding: `${theme.spacing.sm} ${theme.spacing.md}`,
        backgroundColor: theme.colors.surface,
        borderRadius: theme.borderRadius.lg,
        display: 'flex',
        alignItems: 'center',
        gap: theme.spacing.sm,
        opacity: 0.5,
        transition: 'opacity 0.4s ease',
      }}>
        <span style={{
          width: '20px', height: '20px', borderRadius: theme.borderRadius.full,
          backgroundColor: theme.colors.successBg, color: theme.colors.success,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '12px', flexShrink: 0,
        }}>✓</span>
        <span style={{ fontSize: theme.typography.sizes.sm, color: theme.colors.textMuted, textDecoration: 'line-through' }}>
          {headline}
        </span>
      </div>
    )
  }

  return (
    <div ref={cardRef} style={{ position: 'relative', borderRadius: theme.borderRadius.lg }}>
      {/* Swipe reveal backgrounds (collapsed only) */}
      {!expanded && (swipeX > 20 || swipeX < -20) && (
        <>
          <div style={{
            position: 'absolute', inset: 0, backgroundColor: theme.colors.success || '#16a34a',
            borderRadius: theme.borderRadius.lg,
            display: 'flex', alignItems: 'center', paddingLeft: '20px',
            opacity: swipeX > 0 ? Math.min(1, swipeX / SWIPE_THRESHOLD) : 0,
          }}>
            <span style={{ color: 'white', fontWeight: 600, fontSize: theme.typography.sizes.sm }}>{primaryLabel}</span>
          </div>
          <div style={{
            position: 'absolute', inset: 0, backgroundColor: '#dc2626',
            borderRadius: theme.borderRadius.lg,
            display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: '20px',
            opacity: swipeX < 0 ? Math.min(1, Math.abs(swipeX) / SWIPE_THRESHOLD) : 0,
          }}>
            <span style={{ color: 'white', fontWeight: 600, fontSize: theme.typography.sizes.sm }}>Zrušit</span>
          </div>
        </>
      )}

      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          backgroundColor: urgencyBgTint || theme.colors.surface,
          borderRadius: theme.borderRadius.lg,
          borderLeft: urgencyAccent ? `3px solid ${urgencyAccent}` : `3px solid transparent`,
          boxShadow: expanded
            ? theme.shadows.hover
            : hovered
              ? '0 4px 12px rgba(0,0,0,0.08)'
              : theme.shadows.card,
          overflow: 'hidden',
          transition: swiping ? 'none' : 'transform 0.3s ease, box-shadow 0.25s ease',
          // Item 47: hover lift for collapsed cards
          transform: !expanded && swipeX !== 0
            ? `translateX(${swipeX}px)`
            : !expanded && hovered
              ? 'translateY(-2px)'
              : undefined,
          position: 'relative',
          zIndex: 1,
          cursor: expanded ? 'default' : 'pointer',
        }}
      >
        {/* Header */}
        <button
          onClick={onToggle}
          style={{
            display: 'block', width: '100%', textAlign: 'left',
            padding: `${theme.spacing.md} ${theme.spacing.lg}`,
            paddingBottom: expanded ? theme.spacing.xs : theme.spacing.md,
            background: 'none', border: 'none', cursor: 'pointer',
          }}
        >
          <div style={{
            display: 'flex',
            alignItems: 'center',
          }}>
            <UrgencyBadge urgency={action.urgency} />
            <span style={{
              fontSize: expanded ? theme.typography.sizes.lg : theme.typography.sizes.base,
              fontWeight: theme.typography.weights.semibold,
              color: theme.colors.text,
              lineHeight: 1.3,
              transition: 'font-size 0.25s ease',
            }}>
              {headline}
            </span>
          </div>
          {/* Story — visible both collapsed and expanded as context */}
          {story && (
            <div style={{
              fontSize: theme.typography.sizes.sm,
              color: theme.colors.textMuted,
              lineHeight: 1.5,
              marginTop: '4px',
              ...(!expanded ? {
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical' as const,
                overflow: 'hidden',
              } : {}),
            }}>
              {story}
            </div>
          )}
        </button>

        {/* Expandable content */}
        <div style={{
          height: expanded ? (animating ? `${contentHeight}px` : 'auto') : '0px',
          overflow: 'hidden',
          transition: 'height 0.35s ease',
        }}>
          <div ref={contentRef}>
            {/* Conflict section (SCHEDULE only) */}
            {hasConflicts && action.action_type === 'SCHEDULE' && (
              <div style={{ padding: `0 ${theme.spacing.lg} ${theme.spacing.md}` }}>
                <ConflictSection
                  conflicts={conflicts}
                  cpName={action.cpName || ''}
                  actionId={action.id}
                  token={actionToken}
                />
              </div>
            )}

            {/* Type-specific content */}
            <div style={{ padding: `0 ${theme.spacing.lg} ${theme.spacing.lg}` }}>
              {action.action_type === 'REPLY' && (
                <ReplyCard
                  action={action}
                  token={actionToken}
                  onRegenerateDraft={onRegenerateDraft}
                  onSaveDraft={onSaveDraft}
                  onConvertTodo={onConvertQuestionTodo}
                />
              )}
              {action.action_type === 'SCHEDULE' && (
                <ScheduleCard
                  action={action}
                  token={actionToken}
                  onRegenerateDraft={onRegenerateDraft}
                  onSaveDraft={onSaveDraft}
                />
              )}
              {action.action_type === 'TODO' && (
                <TodoCard
                  action={action}
                  onPostpone={onPostpone}
                  showPostponePicker={showPostponePicker}
                />
              )}

              {/* Inline CTAs — visible on desktop, duplicates StickyBar for reachability */}
              <div className="brief-inline-ctas" style={{
                display: 'flex',
                gap: theme.spacing.sm,
                marginTop: theme.spacing.lg,
                paddingTop: theme.spacing.md,
                borderTop: `1px solid ${theme.colors.border}`,
              }}>
                <button
                  onClick={onExecute}
                  style={{
                    flex: 1,
                    padding: `10px ${theme.spacing.lg}`,
                    backgroundColor: theme.colors.primary,
                    color: 'white',
                    border: 'none',
                    borderRadius: theme.borderRadius.md,
                    cursor: 'pointer',
                    fontWeight: theme.typography.weights.semibold,
                    fontSize: theme.typography.sizes.base,
                  }}
                >
                  {action.action_type === 'REPLY' ? 'Odeslat' : action.action_type === 'SCHEDULE' ? 'Potvrdit' : 'Hotovo'}
                </button>
                {action.action_type !== 'TODO' && (
                  <button
                    onClick={onConvertTodo}
                    style={{
                      padding: `10px ${theme.spacing.lg}`,
                      backgroundColor: theme.colors.secondary,
                      color: theme.colors.text,
                      border: 'none',
                      borderRadius: theme.borderRadius.md,
                      cursor: 'pointer',
                      fontWeight: theme.typography.weights.medium,
                      fontSize: theme.typography.sizes.base,
                    }}
                  >
                    {'Úkol'}
                  </button>
                )}
                {action.action_type === 'TODO' && (
                  <button
                    onClick={onDismiss}
                    style={{
                      padding: `10px ${theme.spacing.lg}`,
                      backgroundColor: 'transparent',
                      color: theme.colors.textMuted,
                      border: 'none',
                      borderRadius: theme.borderRadius.md,
                      cursor: 'pointer',
                      fontWeight: theme.typography.weights.medium,
                      fontSize: theme.typography.sizes.base,
                    }}
                  >
                    Smazat
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
