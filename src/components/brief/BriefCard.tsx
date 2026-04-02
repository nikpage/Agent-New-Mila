'use client'

import { useRef, useEffect, useState, useCallback } from 'react'
import { useTheme } from '@/contexts/ThemeContext'
import { ReplyCard } from './ReplyCard'
import { ScheduleCard } from './ScheduleCard'
import { TodoCard } from './TodoCard'
import { ConflictSection } from './ConflictSection'
import type { BriefAction } from './types'
import type { ConflictCardData } from '@/components/action/action-card-template'

function usePressState() {
  const [pressed, setPressed] = useState(false)
  const pressHandlers = {
    onMouseDown: () => setPressed(true),
    onMouseUp: () => setPressed(false),
    onMouseLeave: () => setPressed(false),
    onTouchStart: () => setPressed(true),
    onTouchEnd: () => setPressed(false),
  }
  return { pressed, pressHandlers }
}

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
  onUndo?: () => void
  done?: boolean
  showPostponePicker?: boolean
  isFirst?: boolean
}

/** Urgency badge — positioned dot with optional pulse halo (Task 4) */
function UrgencyBadge({ urgency, theme }: { urgency: number; theme: ReturnType<typeof useTheme> }) {
  if (urgency >= 10) {
    return (
      <>
        <style>{`@keyframes mila-urgency-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.6; transform: scale(1.15); } }`}</style>
        <span style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          marginRight: '6px',
          flexShrink: 0,
        }}>
          {/* Halo ring */}
          <span style={{
            position: 'absolute',
            inset: '-3px',
            borderRadius: '50%',
            backgroundColor: theme.colors.error,
            opacity: 0.25,
            animation: 'mila-urgency-pulse 1.5s ease-in-out infinite',
            animationDelay: '0.4s',
          }} />
          {/* Main dot */}
          <span style={{
            display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%',
            backgroundColor: theme.colors.error,
            boxShadow: `0 0 6px ${theme.colors.error}`,
            animation: 'mila-urgency-pulse 1.5s ease-in-out infinite',
            position: 'relative',
          }} />
        </span>
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

function getUrgencyAccent(urgency: number, theme: ReturnType<typeof useTheme>): string | undefined {
  if (urgency >= 9) return theme.colors.error
  if (urgency >= 7) return theme.colors.urgencyMedium
  return undefined
}

/** Card background tint for extreme urgency */
function getUrgencyBgTint(urgency: number, theme: ReturnType<typeof useTheme>): string | undefined {
  if (urgency >= 10) return theme.colors.errorBg
  return undefined
}

export function BriefCard({
  action, actionToken, expanded, onToggle,
  onExecute, onConvertTodo, onDismiss, onPostpone,
  onRegenerateDraft, onSaveDraft, onConvertQuestionTodo, onUndo, done, showPostponePicker,
  isFirst,
}: BriefCardProps) {
  const theme = useTheme()

  // Use headline if available, otherwise CP name
  const headline = action.headline || action.cpName || 'Akce'
  // Use story if available, otherwise a SHORT fallback
  const story = action.story || action.rationale_cs || action.topic || null
  const urgencyAccent = getUrgencyAccent(action.urgency, theme)
  const urgencyBgTint = getUrgencyBgTint(action.urgency, theme)

  // Loading state for inline CTAs
  const [ctaLoading, setCtaLoading] = useState<string | null>(null)

  async function handleCta(label: string, fn: () => Promise<void>) {
    setCtaLoading(label)
    try { await fn() } finally { setCtaLoading(null) }
  }

  const payload = action.payload as Record<string, unknown> | null
  const conflicts = (payload?.conflicts as ConflictCardData[]) || []
  const hasConflicts = conflicts.filter(c => !(c as Record<string, unknown>).resolved).length > 0

  // Scroll into view on expand
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (expanded && cardRef.current) {
      const timer = setTimeout(() => {
        cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 380)
      return () => clearTimeout(timer)
    }
  }, [expanded])

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

  // Press states for buttons (Task 2)
  const headerPress = usePressState()
  const primaryPress = usePressState()
  const secondaryPress = usePressState()
  const tertiaryPress = usePressState()

  // Task 10: Swipe hint on first use
  useEffect(() => {
    if (!isFirst) return
    const seen = localStorage.getItem('mila-swipe-hint')
    if (!seen && !expanded) {
      setTimeout(() => setSwipeX(20), 600)
      setTimeout(() => setSwipeX(0), 1000)
      localStorage.setItem('mila-swipe-hint', '1')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Task 9: Done-state — show undo bar, then collapse
  const [donePhase, setDonePhase] = useState<'none' | 'undo' | 'collapsing' | 'gone'>('none')
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if ((done || swipedAway) && donePhase === 'none') {
      setDonePhase('undo')
      undoTimer.current = setTimeout(() => setDonePhase('collapsing'), 5000)
    }
    return () => { if (undoTimer.current) clearTimeout(undoTimer.current) }
  }, [done, swipedAway, donePhase])

  useEffect(() => {
    if (donePhase === 'collapsing') {
      const t = setTimeout(() => setDonePhase('gone'), 400)
      return () => clearTimeout(t)
    }
  }, [donePhase])

  // Undo bar — 5 seconds to take back
  if (donePhase === 'undo') {
    return (
      <div style={{
        padding: `${theme.spacing.sm} ${theme.spacing.md}`,
        backgroundColor: theme.colors.surface,
        borderRadius: theme.borderRadius.lg,
        display: 'flex',
        alignItems: 'center',
        gap: theme.spacing.sm,
        border: `1px solid ${theme.colors.border}`,
      }}>
        <span style={{
          width: '20px', height: '20px', borderRadius: theme.borderRadius.full,
          backgroundColor: theme.colors.successBg, color: theme.colors.success,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '12px', flexShrink: 0,
        }}>✓</span>
        <span style={{ fontSize: theme.typography.sizes.sm, color: theme.colors.textMuted, flex: 1 }}>
          {headline}
        </span>
        <button
          onClick={() => {
            if (undoTimer.current) clearTimeout(undoTimer.current)
            setDonePhase('none')
            if (onUndo) onUndo()
          }}
          style={{
            padding: `${theme.spacing.xs} ${theme.spacing.md}`,
            backgroundColor: 'transparent',
            color: theme.colors.primary,
            border: `1px solid ${theme.colors.primary}`,
            borderRadius: theme.borderRadius.md,
            cursor: 'pointer',
            fontSize: theme.typography.sizes.sm,
            fontWeight: theme.typography.weights.medium,
          }}
        >
          Zpět
        </button>
      </div>
    )
  }

  // Collapsing / gone
  if (donePhase === 'collapsing' || donePhase === 'gone') {
    return (
      <div style={{
        maxHeight: donePhase === 'gone' ? '0px' : '60px',
        opacity: donePhase === 'gone' ? 0 : 0.5,
        overflow: 'hidden',
        transition: 'max-height 400ms cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 300ms cubic-bezier(0.4, 0, 0.2, 1)',
      }} />
    )
  }

  return (
    <div ref={cardRef} style={{
      position: 'relative',
      borderRadius: theme.borderRadius.lg,
      maxWidth: '680px',
      marginLeft: 'auto',
      marginRight: 'auto',
      width: '100%',
    }}>
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
            <span style={{ color: 'white', fontWeight: 600, fontSize: theme.typography.sizes.sm }}>Zahodit</span>
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
          borderLeft: urgencyAccent ? `3px solid ${urgencyAccent}` : '3px solid transparent',
          boxShadow: expanded
            ? theme.shadows.hover
            : hovered
              ? '0 4px 12px rgba(0,0,0,0.08)'
              : theme.shadows.card,
          overflow: 'hidden',
          transition: swiping
            ? 'none'
            : `transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.25s cubic-bezier(0.4, 0, 0.2, 1)`,
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
          {...headerPress.pressHandlers}
          style={{
            display: 'block', width: '100%', textAlign: 'left',
            padding: `${theme.spacing.md} ${theme.spacing.lg}`,
            paddingBottom: expanded ? theme.spacing.xs : theme.spacing.md,
            background: 'none', border: 'none', cursor: 'pointer',
            minHeight: '52px',
            transform: headerPress.pressed ? 'scale(0.97)' : 'scale(1)',
            transition: 'transform 0.1s ease, opacity 0.15s ease, background-color 0.15s ease',
          }}
        >
          <div style={{
            display: 'flex',
            alignItems: 'center',
          }}>
            <UrgencyBadge urgency={action.urgency} theme={theme} />
            <span style={{
              fontSize: expanded ? theme.typography.sizes.md : theme.typography.sizes.smPlus,
              fontWeight: theme.typography.weights.semibold,
              color: theme.colors.text,
              lineHeight: theme.lineHeight.tight,
              letterSpacing: theme.letterSpacing.tight,
              transition: 'font-size 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
              flex: 1,
            }}>
              {headline}
            </span>
            {expanded && (
              <span style={{
                fontSize: theme.typography.sizes.sm,
                color: theme.colors.textMuted,
                flexShrink: 0,
                marginLeft: theme.spacing.sm,
                transition: 'opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
              }}>
                ✕
              </span>
            )}
          </div>
          {/* Story — visible both collapsed and expanded as context */}
          {story && (
            <div style={{
              fontSize: theme.typography.sizes.sm,
              color: theme.colors.textSubtle,
              lineHeight: theme.lineHeight.snug,
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

        {/* Expandable content — CSS Grid pattern (Task 1) */}
        <div style={{
          display: 'grid',
          gridTemplateRows: expanded ? '1fr' : '0fr',
          transition: 'grid-template-rows 350ms cubic-bezier(0.25, 0.46, 0.45, 0.94)',
        }}>
          <div style={{ minHeight: 0, overflow: 'hidden' }}>
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
                  onClick={() => handleCta('primary', onExecute)}
                  disabled={ctaLoading !== null}
                  {...primaryPress.pressHandlers}
                  style={{
                    flex: 1,
                    padding: `10px ${theme.spacing.lg}`,
                    background: theme.colors.primaryGradient,
                    color: 'white',
                    border: 'none',
                    borderRadius: theme.borderRadius.md,
                    cursor: ctaLoading ? 'not-allowed' : 'pointer',
                    fontWeight: theme.typography.weights.semibold,
                    fontSize: theme.typography.sizes.base,
                    letterSpacing: theme.letterSpacing.wide,
                    opacity: ctaLoading === 'primary' ? 0.6 : ctaLoading ? 0.8 : 1,
                    transform: primaryPress.pressed ? 'scale(0.97)' : 'scale(1)',
                    transition: 'transform 0.1s ease, opacity 0.15s cubic-bezier(0.4, 0, 0.2, 1)',
                  }}
                >
                  {ctaLoading === 'primary' ? '...' : action.action_type === 'REPLY' ? 'Odeslat' : action.action_type === 'SCHEDULE' ? 'Potvrdit' : 'Hotovo'}
                </button>
                {action.action_type !== 'TODO' && (
                  <button
                    onClick={() => handleCta('secondary', onConvertTodo)}
                    disabled={ctaLoading !== null}
                    {...secondaryPress.pressHandlers}
                    style={{
                      padding: `10px ${theme.spacing.lg}`,
                      backgroundColor: theme.colors.secondary,
                      color: theme.colors.text,
                      border: 'none',
                      borderRadius: theme.borderRadius.md,
                      cursor: ctaLoading ? 'not-allowed' : 'pointer',
                      fontWeight: theme.typography.weights.medium,
                      fontSize: theme.typography.sizes.base,
                      letterSpacing: theme.letterSpacing.wide,
                      opacity: ctaLoading === 'secondary' ? 0.6 : ctaLoading ? 0.8 : 1,
                      transform: secondaryPress.pressed ? 'scale(0.97)' : 'scale(1)',
                      transition: 'transform 0.1s ease, opacity 0.15s cubic-bezier(0.4, 0, 0.2, 1)',
                    }}
                  >
                    {ctaLoading === 'secondary' ? '...' : 'Úkol'}
                  </button>
                )}
                {action.action_type === 'TODO' && (
                  <button
                    onClick={() => handleCta('tertiary', onDismiss)}
                    disabled={ctaLoading !== null}
                    {...tertiaryPress.pressHandlers}
                    style={{
                      padding: `10px ${theme.spacing.lg}`,
                      backgroundColor: 'transparent',
                      color: theme.colors.textMuted,
                      border: 'none',
                      borderRadius: theme.borderRadius.md,
                      cursor: ctaLoading ? 'not-allowed' : 'pointer',
                      fontWeight: theme.typography.weights.medium,
                      fontSize: theme.typography.sizes.base,
                      opacity: ctaLoading === 'tertiary' ? 0.6 : ctaLoading ? 0.8 : 1,
                      transform: tertiaryPress.pressed ? 'scale(0.97)' : 'scale(1)',
                      transition: 'transform 0.1s ease, opacity 0.15s cubic-bezier(0.4, 0, 0.2, 1)',
                    }}
                  >
                    {ctaLoading === 'tertiary' ? '...' : 'Smazat'}
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
