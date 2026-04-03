'use client'

import { useRef, useEffect, useState, useCallback } from 'react'
import { useTheme } from '@/contexts/ThemeContext'
import { ReplyCard } from './ReplyCard'
import { ScheduleCard } from './ScheduleCard'
import { TodoCard } from './TodoCard'
import { ConflictSection } from './ConflictSection'
import type { BriefAction } from './types'
import type { ConflictCardData } from '@/components/action/action-card-template'

const TYPE_LABELS: Record<string, string> = {
  REPLY: 'Odpověď',
  SCHEDULE: 'Schůzka',
  TODO: 'Úkol',
}

const PRIMARY_LABELS: Record<string, string> = {
  REPLY: 'Odeslat odpověď',
  SCHEDULE: 'Potvrdit termín',
  TODO: 'Hotovo',
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

/** Get urgency class: 'uh' for high (>=9), 'um' for medium (>=7) */
function getUrgencyClass(urgency: number): string {
  if (urgency >= 9) return 'uh'
  if (urgency >= 7) return 'um'
  return ''
}

export function BriefCard({
  action, actionToken, expanded, onToggle,
  onExecute, onConvertTodo, onDismiss, onPostpone,
  onRegenerateDraft, onSaveDraft, onConvertQuestionTodo, onUndo, done, showPostponePicker,
}: BriefCardProps) {
  const theme = useTheme()

  const headline = action.headline || action.cpName || 'Akce'
  const story = action.story || action.rationale_cs || action.topic || null
  const urgencyClass = getUrgencyClass(action.urgency)

  // Loading + error state for CTAs
  const [ctaLoading, setCtaLoading] = useState<string | null>(null)
  const [ctaError, setCtaError] = useState<string | null>(null)

  async function handleCta(label: string, fn: () => Promise<void>) {
    setCtaLoading(label)
    setCtaError(null)
    try {
      await fn()
    } catch (err) {
      setCtaError(err instanceof Error ? err.message : 'Něco se pokazilo')
    } finally {
      setCtaLoading(null)
    }
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

  // Done state — show undo bar, then collapse
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

  // Undo bar
  if (donePhase === 'undo') {
    return (
      <div style={{
        padding: '8px 16px',
        backgroundColor: 'var(--surf)',
        borderRadius: '14px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        border: '1px solid var(--brd)',
      }}>
        <span style={{
          width: '20px', height: '20px', borderRadius: '50%',
          backgroundColor: 'var(--success-bg)', color: 'var(--success)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '12px', flexShrink: 0,
        }}>✓</span>
        <span style={{ fontSize: '13.5px', color: 'var(--mtd)', flex: 1 }}>
          {headline}
        </span>
        <button
          onClick={() => {
            if (undoTimer.current) clearTimeout(undoTimer.current)
            setDonePhase('none')
            if (onUndo) onUndo()
          }}
          style={{
            padding: '4px 16px',
            backgroundColor: 'transparent',
            color: 'var(--acc)',
            border: '1px solid var(--obrd)',
            borderRadius: '9px',
            cursor: 'pointer',
            fontSize: '13.5px',
            fontWeight: 600,
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

  // Urgency-dependent inset shadow for left border
  const urgencyShadow = urgencyClass === 'uh'
    ? ', inset 4px 0 0 var(--uh)'
    : urgencyClass === 'um'
      ? ', inset 4px 0 0 var(--um)'
      : ''

  const baseShadow = 'var(--sdw)' + urgencyShadow
  const hoverShadow = 'var(--sdw-h)' + urgencyShadow

  return (
    <div ref={cardRef} style={{ position: 'relative' }}>
      {/* Swipe reveal backgrounds */}
      {!expanded && (swipeX > 20 || swipeX < -20) && (
        <>
          <div style={{
            position: 'absolute', inset: 0, backgroundColor: 'var(--success)',
            borderRadius: '14px',
            display: 'flex', alignItems: 'center', paddingLeft: '20px',
            opacity: swipeX > 0 ? Math.min(1, swipeX / SWIPE_THRESHOLD) : 0,
          }}>
            <span style={{ color: 'white', fontWeight: 600, fontSize: '13px' }}>
              {PRIMARY_LABELS[action.action_type] || 'Hotovo'}
            </span>
          </div>
          <div style={{
            position: 'absolute', inset: 0, backgroundColor: 'var(--uh)',
            borderRadius: '14px',
            display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: '20px',
            opacity: swipeX < 0 ? Math.min(1, Math.abs(swipeX) / SWIPE_THRESHOLD) : 0,
          }}>
            <span style={{ color: 'white', fontWeight: 600, fontSize: '13px' }}>Zahodit</span>
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
          borderRadius: '14px',
          border: '1px solid var(--brd)',
          overflow: 'hidden',
          boxShadow: expanded ? baseShadow : hovered ? hoverShadow : baseShadow,
          transition: swiping
            ? 'none'
            : 'box-shadow .25s cubic-bezier(.4,0,.2,1), transform .25s cubic-bezier(.34,1.56,.64,1), background .2s',
          transform: !expanded && swipeX !== 0
            ? `translateX(${swipeX}px)`
            : !expanded && hovered
              ? 'translateY(-3px)'
              : undefined,
          background: !expanded && hovered ? 'var(--surf-h)' : 'var(--surf)',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* Header — clickable to toggle */}
        <button
          onClick={onToggle}
          style={{
            display: 'block',
            width: '100%',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
            padding: '15px 15px 14px 18px',
            color: 'var(--txt)',
            outline: 'none',
            WebkitTapHighlightColor: 'transparent',
            transition: 'transform .08s ease',
          }}
        >
          {/* Top row: dot + headline + badge + chevron */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '7px',
            marginBottom: '6px',
          }}>
            {/* Urgency dot */}
            {urgencyClass === 'uh' && (
              <span style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: 'var(--uh)',
                flexShrink: 0,
                animation: 'dp 2s ease-in-out infinite',
              }} />
            )}
            {urgencyClass === 'um' && (
              <span style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: 'var(--um)',
                flexShrink: 0,
              }} />
            )}

            {/* Headline */}
            <span style={{
              fontFamily: 'Georgia, serif',
              fontSize: expanded ? '17px' : '15.5px',
              fontWeight: 700,
              color: 'var(--txt)',
              lineHeight: 1.25,
              flex: 1,
              transition: 'font-size .22s cubic-bezier(.25,.46,.45,.94)',
            }}>
              {headline}
            </span>

            {/* Type badge */}
            <span style={{
              fontSize: '10px',
              fontWeight: 600,
              letterSpacing: '0.07em',
              textTransform: 'uppercase',
              color: 'var(--sub)',
              background: 'var(--bg)',
              border: '1px solid var(--brd)',
              borderRadius: '4px',
              padding: '2px 6px',
              flexShrink: 0,
              transition: 'background .3s, border-color .3s, color .3s',
            }}>
              {TYPE_LABELS[action.action_type] || action.action_type}
            </span>

            {/* Chevron */}
            <span style={{
              color: 'var(--sub)',
              fontSize: '10px',
              flexShrink: 0,
              lineHeight: 1,
              transition: 'transform .3s cubic-bezier(.25,.46,.45,.94)',
              transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            }}>
              ▾
            </span>
          </div>

          {/* Story / subtitle */}
          {story && (
            <div style={{
              fontSize: '13.5px',
              color: 'var(--mtd)',
              lineHeight: 1.52,
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

        {/* Expandable content — CSS Grid for smooth animation */}
        <div style={{
          display: 'grid',
          gridTemplateRows: expanded ? '1fr' : '0fr',
          transition: 'grid-template-rows .32s cubic-bezier(.25,.46,.45,.94)',
        }}>
          <div style={{ minHeight: 0, overflow: expanded ? 'visible' : 'hidden' }}>
            <div style={{
              padding: '2px 15px 16px 18px',
              borderTop: '1px solid var(--brd)',
            }}>
              {/* Conflict section (SCHEDULE only) */}
              {hasConflicts && action.action_type === 'SCHEDULE' && (
                <div style={{ marginBottom: '12px' }}>
                  <ConflictSection
                    conflicts={conflicts}
                    cpName={action.cpName || ''}
                    actionId={action.id}
                    token={actionToken}
                  />
                </div>
              )}

              {/* Shared context block — all card types */}
              {action.summaryJson?.currentState && (
                <div style={{ marginBottom: '12px' }}>
                  <div style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    letterSpacing: '0.05em',
                    textTransform: 'uppercase',
                    color: 'var(--mtd)',
                    marginBottom: '4px',
                  }}>
                    Kontext
                  </div>
                  <div style={{
                    fontSize: '13.5px',
                    color: 'var(--txt)',
                    lineHeight: 1.6,
                    borderLeft: '2px solid var(--brd)',
                    paddingLeft: '16px',
                  }}>
                    {action.summaryJson.currentState}
                  </div>
                </div>
              )}

              {/* Type-specific content */}
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

              {/* Action buttons */}
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                marginTop: '16px',
              }}>
                <button
                  onClick={() => handleCta('primary', onExecute)}
                  disabled={ctaLoading !== null}
                  style={{
                    fontFamily: 'system-ui, -apple-system, sans-serif',
                    fontWeight: 600,
                    fontSize: '14px',
                    borderRadius: '9px',
                    border: 'none',
                    cursor: ctaLoading ? 'not-allowed' : 'pointer',
                    letterSpacing: '0.01em',
                    outline: 'none',
                    WebkitTapHighlightColor: 'transparent',
                    width: '100%',
                    padding: '12px 14px',
                    background: 'var(--pbg)',
                    color: 'var(--ptxt)',
                    opacity: ctaLoading === 'primary' ? 0.6 : 1,
                    transition: 'transform .08s ease',
                  }}
                >
                  {ctaLoading === 'primary' ? '...' : PRIMARY_LABELS[action.action_type] || 'Hotovo'}
                </button>

                <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
                  {action.action_type === 'TODO' && (
                    <button
                      onClick={() => handleCta('postpone', async () => { /* Toggle postpone picker via parent */ })}
                      style={{
                        fontFamily: 'system-ui, -apple-system, sans-serif',
                        fontWeight: 500,
                        fontSize: '13px',
                        borderRadius: '9px',
                        border: 'none',
                        cursor: 'pointer',
                        letterSpacing: '0.01em',
                        outline: 'none',
                        WebkitTapHighlightColor: 'transparent',
                        padding: '8px 12px',
                        background: 'transparent',
                        color: 'var(--sub)',
                        transition: 'transform .08s ease',
                      }}
                    >
                      Odložit
                    </button>
                  )}

                  <button
                    onClick={() => handleCta('dismiss', onDismiss)}
                    disabled={ctaLoading !== null}
                    style={{
                      fontFamily: 'system-ui, -apple-system, sans-serif',
                      fontWeight: 500,
                      fontSize: '13px',
                      borderRadius: '9px',
                      border: 'none',
                      cursor: ctaLoading ? 'not-allowed' : 'pointer',
                      letterSpacing: '0.01em',
                      outline: 'none',
                      WebkitTapHighlightColor: 'transparent',
                      padding: '8px 12px',
                      background: 'transparent',
                      color: 'var(--sub)',
                      opacity: ctaLoading === 'dismiss' ? 0.6 : 1,
                      transition: 'transform .08s ease',
                    }}
                  >
                    {ctaLoading === 'dismiss' ? '...' : 'Zahodit'}
                  </button>
                </div>

                {ctaError && (
                  <div style={{
                    fontSize: '12px',
                    color: 'var(--uh)',
                    textAlign: 'center',
                  }}>
                    {ctaError}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
