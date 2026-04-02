'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { theme } from '@/config/theme'
import { BriefCard } from './BriefCard'
import { ItineraryView } from './ItineraryView'
import { CompletedSection } from './CompletedSection'
import { StickyBar } from './StickyBar'
import type { BriefData, BriefAction, BriefEvent, StickyBarCTA } from './types'

interface BriefFeedProps {
  initialData: BriefData
  userId: string
  token: string
  focusActionId?: string | null
}

function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Dobré ráno'
  if (hour < 18) return 'Dobré odpoledne'
  return 'Dobrý večer'
}

export function BriefFeed({ initialData, userId, token, focusActionId }: BriefFeedProps) {
  const [data, setData] = useState(initialData)
  const [expandedId, setExpandedId] = useState<string | null>(focusActionId || null)
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set())
  const [postponePickerOpen, setPostponePickerOpen] = useState(false)
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  // Check hash for #action-{id} deep links (from email templates)
  useEffect(() => {
    const hash = window.location.hash
    if (hash && hash.startsWith('#action-')) {
      const hashActionId = hash.replace('#action-', '')
      if (hashActionId && !expandedId) {
        setExpandedId(hashActionId)
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to focused card on mount
  useEffect(() => {
    if (focusActionId) {
      const el = cardRefs.current.get(focusActionId)
      if (el) {
        setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100)
      }
    }
  }, [focusActionId])

  // Scroll to hash-linked card
  useEffect(() => {
    if (expandedId && !focusActionId) {
      const el = cardRefs.current.get(expandedId)
      if (el) {
        setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100)
      }
    }
  }, [expandedId, focusActionId])

  // Refresh function
  const refreshData = useCallback(async () => {
    try {
      const res = await fetch(`/api/brief/${userId}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (res.ok) {
        const fresh = await res.json()
        setData(fresh)
      }
    } catch {
      // Keep current data
    }
  }, [userId, token])

  // Hydrate on mount
  useEffect(() => { refreshData() }, [refreshData])

  // Pull-to-refresh
  const [pullY, setPullY] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const pullStartY = useRef(0)
  const isPulling = useRef(false)
  const PULL_THRESHOLD = 80

  const onPullTouchStart = useCallback((e: React.TouchEvent) => {
    if (window.scrollY > 0) return
    pullStartY.current = e.touches[0].clientY
    isPulling.current = false
  }, [])

  const onPullTouchMove = useCallback((e: React.TouchEvent) => {
    if (refreshing) return
    const dy = e.touches[0].clientY - pullStartY.current
    if (dy > 10 && window.scrollY <= 0) isPulling.current = true
    if (isPulling.current && dy > 0) setPullY(Math.min(dy * 0.5, 120))
  }, [refreshing])

  const onPullTouchEnd = useCallback(async () => {
    if (!isPulling.current) return
    isPulling.current = false
    if (pullY >= PULL_THRESHOLD) {
      setRefreshing(true)
      setPullY(50)
      await refreshData()
      setRefreshing(false)
    }
    setPullY(0)
  }, [pullY, refreshData])

  // Sort actions by urgency then priority
  const sortedActions = [...data.actions].sort((a, b) => {
    if (b.urgency !== a.urgency) return b.urgency - a.urgency
    return b.priority_score - a.priority_score
  })

  // Get token for an action — use per-action token if available, fall back to page token
  function getActionToken(action: BriefAction): string {
    return action.actionToken || token
  }

  // ── Action handlers ──────────────────────────────────────────────────

  async function handleExecute(actionId: string) {
    const action = sortedActions.find(a => a.id === actionId)
    const res = await fetch(`/api/action/${actionId}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: action ? getActionToken(action) : token }),
    })
    if (res.ok) {
      setDoneIds(prev => new Set(prev).add(actionId))
      setExpandedId(null)
    }
  }

  async function handleConvertTodo(actionId: string) {
    const action = sortedActions.find(a => a.id === actionId)
    const res = await fetch(`/api/action/${actionId}/convert-todo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: action ? getActionToken(action) : token }),
    })
    if (res.ok) {
      setDoneIds(prev => new Set(prev).add(actionId))
      setExpandedId(null)
    }
  }

  async function handleDismiss(actionId: string) {
    const action = sortedActions.find(a => a.id === actionId)
    const res = await fetch(`/api/action/${actionId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: action ? getActionToken(action) : token }),
    })
    if (res.ok) {
      setDoneIds(prev => new Set(prev).add(actionId))
      setExpandedId(null)
    }
  }

  async function handlePostpone(actionId: string, postponeTo: string) {
    const action = sortedActions.find(a => a.id === actionId)
    const res = await fetch(`/api/action/${actionId}/postpone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: action ? getActionToken(action) : token, postponeTo }),
    })
    if (res.ok) {
      setData(prev => ({ ...prev, actions: prev.actions.filter(a => a.id !== actionId) }))
      setExpandedId(null)
    }
  }

  async function handleRegenerateDraft(actionId: string, instruction: string): Promise<{ subject: string; body: string }> {
    const action = sortedActions.find(a => a.id === actionId)
    const res = await fetch(`/api/action/${actionId}/regenerate-draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: action ? getActionToken(action) : token, instruction }),
    })
    if (!res.ok) throw new Error('Failed to regenerate')
    return res.json()
  }

  async function handleSaveDraft(actionId: string, d: Record<string, unknown>) {
    const action = sortedActions.find(a => a.id === actionId)
    await fetch(`/api/action/${actionId}/draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: action ? getActionToken(action) : token, ...d }),
    })
  }

  // Item 35: Wire command to API
  async function handleCommand(command: string) {
    const res = await fetch('/api/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, userId, command }),
    })
    if (res.ok) {
      const result = await res.json()
      if (result.success) {
        // Refresh to show new todos/contacts
        await refreshData()
      }
      // Could show a toast/notification with result.message — for now, silent
    }
  }

  // Item 20: Convert a specific question to TODO
  async function handleConvertQuestionTodo(actionId: string, question: string) {
    const action = sortedActions.find(a => a.id === actionId)
    const res = await fetch(`/api/action/${actionId}/convert-todo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: action ? getActionToken(action) : token,
        description: `Zjistit: ${question}`,
      }),
    })
    if (res.ok) {
      await refreshData()
    }
  }

  // ── StickyBar CTA generation ─────────────────────────────────────────

  const expandedAction = expandedId ? sortedActions.find(a => a.id === expandedId) : null

  function getExpandedCTAs(): StickyBarCTA[] | null {
    if (!expandedAction || doneIds.has(expandedAction.id)) return null

    const id = expandedAction.id
    switch (expandedAction.action_type) {
      case 'REPLY':
        return [
          { label: 'Odeslat', action: () => handleExecute(id), primary: true },
          { label: 'Úkol', action: () => handleConvertTodo(id) },
        ]
      case 'SCHEDULE':
        return [
          { label: 'Potvrdit', action: () => handleExecute(id), primary: true },
          { label: 'Úkol', action: () => handleConvertTodo(id) },
        ]
      case 'TODO':
        return [
          { label: 'Hotovo', action: () => handleExecute(id), primary: true },
          { label: 'Odložit', action: () => { setPostponePickerOpen(prev => !prev) } },
          { label: 'Smazat', action: () => handleDismiss(id), destructive: true },
        ]
      default:
        return null
    }
  }

  // Item 37: History / dismissed items toggle
  const [showHistory, setShowHistory] = useState(false)
  const [historyItems, setHistoryItems] = useState<BriefAction[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  async function loadHistory() {
    if (showHistory) { setShowHistory(false); return }
    setHistoryLoading(true)
    try {
      const res = await fetch(`/api/brief/${userId}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, includeDismissed: true }),
      })
      if (res.ok) {
        const result = await res.json()
        // Filter to only dismissed/completed items not already shown
        const activeIds = new Set(data.actions.map(a => a.id))
        const dismissed = (result.actions || []).filter((a: BriefAction) =>
          !activeIds.has(a.id) && (a.status === 'dismissed' || a.status === 'completed')
        )
        setHistoryItems(dismissed)
      }
    } catch {
      // Silently fail
    } finally {
      setHistoryLoading(false)
      setShowHistory(true)
    }
  }

  // Item 51: Swipe hint — show once via localStorage
  const [showSwipeHint, setShowSwipeHint] = useState(false)
  useEffect(() => {
    if (sortedActions.length > 0 && typeof window !== 'undefined') {
      const key = 'mila_swipe_hint_shown'
      if (!localStorage.getItem(key)) {
        setShowSwipeHint(true)
        localStorage.setItem(key, '1')
        const t = setTimeout(() => setShowSwipeHint(false), 4000)
        return () => clearTimeout(t)
      }
    }
  }, [sortedActions.length])

  const pendingCount = sortedActions.filter(a => !doneIds.has(a.id)).length
  const greeting = getGreeting()
  const firstName = data.userName?.split(' ')[0] || ''

  return (
    <div
      onTouchStart={onPullTouchStart}
      onTouchMove={onPullTouchMove}
      onTouchEnd={onPullTouchEnd}

      className="brief-feed-container"
      style={{
        maxWidth: '960px',
        margin: '0 auto',
        padding: '0',
        paddingBottom: '88px',
        minHeight: '100dvh',
        transform: pullY > 0 ? `translateY(${pullY}px)` : undefined,
        transition: isPulling.current ? 'none' : 'transform 0.3s ease',
        position: 'relative',
      }}
    >
      {/* Item 45: Desktop responsive styles */}
      <style>{`
        @media (max-width: 768px) {
          .brief-feed-container { max-width: 768px !important; }
          .brief-inline-ctas { display: none !important; }
        }
        @media (min-width: 1025px) {
          .brief-desktop-layout { display: flex !important; gap: 24px !important; align-items: flex-start; }
          .brief-cards-column { flex: 3; min-width: 0; }
          .brief-sidebar-column { flex: 2; min-width: 0; position: sticky; top: 16px; }
        }
      `}</style>
      {/* Pull-to-refresh indicator */}
      {(pullY > 0 || refreshing) && (
        <div style={{
          position: 'absolute',
          top: '-36px',
          left: 0,
          right: 0,
          textAlign: 'center',
          fontSize: theme.typography.sizes.xs,
          color: theme.colors.textMuted,
          opacity: pullY >= PULL_THRESHOLD || refreshing ? 1 : pullY / PULL_THRESHOLD,
        }}>
          {refreshing ? 'Aktualizuji...' : pullY >= PULL_THRESHOLD ? 'Pusťte pro obnovení' : ''}
        </div>
      )}

      {/* ── Header ──────────────────────────────────────────────── */}
      <header style={{
        padding: `${theme.spacing.xl} ${theme.spacing.lg} ${theme.spacing.md}`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
      }}>
        <div>
          <div style={{
            fontSize: theme.typography.sizes.xxl,
            fontWeight: theme.typography.weights.bold,
            color: theme.colors.text,
            lineHeight: 1.2,
          }}>
            {greeting}{firstName ? `, ${firstName}` : ''}
          </div>
          <div style={{
            fontSize: theme.typography.sizes.sm,
            color: theme.colors.textMuted,
            marginTop: theme.spacing.xs,
          }}>
            {pendingCount > 0
              ? `${pendingCount} ${pendingCount === 1 ? 'věc k vyřízení' : pendingCount < 5 ? 'věci k vyřízení' : 'věcí k vyřízení'}`
              : 'Vše vyřízeno'
            }
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.spacing.sm }}>
          <button
            onClick={() => refreshData()}
            disabled={refreshing}
            title="Obnovit"
            style={{
              width: '32px', height: '32px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: theme.borderRadius.full,
              border: `1px solid ${theme.colors.border}`,
              backgroundColor: theme.colors.surface,
              color: theme.colors.textMuted,
              cursor: refreshing ? 'not-allowed' : 'pointer',
              fontSize: '14px', flexShrink: 0,
              opacity: refreshing ? 0.5 : 1,
              transition: 'opacity 0.15s ease',
            }}
          >
            ↻
          </button>
          <div style={{
            fontSize: '11px',
            fontWeight: theme.typography.weights.semibold,
            color: theme.colors.primary,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}>
            Mila
          </div>
        </div>
      </header>

      {/* Item 51: Swipe hint */}
      {showSwipeHint && sortedActions.length > 0 && (
        <div style={{
          textAlign: 'center', padding: `${theme.spacing.xs} ${theme.spacing.md}`,
          fontSize: theme.typography.sizes.xs, color: theme.colors.textMuted,
          animation: 'mila-hint-fade 4s ease forwards',
        }}>
          <style>{`@keyframes mila-hint-fade { 0% { opacity: 0; } 15% { opacity: 1; } 85% { opacity: 1; } 100% { opacity: 0; } }`}</style>
          Swipe vpravo = potvrdit, vlevo = zrušit
        </div>
      )}

      {/* Item 45: Desktop two-column layout wrapper */}
      <div className="brief-desktop-layout" style={{ padding: `0 ${theme.spacing.md}` }}>
        {/* Cards column */}
        <div className="brief-cards-column">
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: theme.spacing.sm,
          }}>
            {sortedActions.map(action => (
              <div
                key={action.id}
                id={`action-${action.id}`}
                ref={el => { if (el) cardRefs.current.set(action.id, el) }}
              >
                <BriefCard
                  action={action}
                  actionToken={getActionToken(action)}
                  expanded={expandedId === action.id}
                  onToggle={() => { setExpandedId(expandedId === action.id ? null : action.id); setPostponePickerOpen(false) }}
                  onExecute={() => handleExecute(action.id)}
                  onConvertTodo={() => handleConvertTodo(action.id)}
                  onDismiss={() => handleDismiss(action.id)}
                  onPostpone={(postponeTo) => handlePostpone(action.id, postponeTo)}
                  onRegenerateDraft={(instruction) => handleRegenerateDraft(action.id, instruction)}
                  onSaveDraft={(d) => handleSaveDraft(action.id, d)}
                  onConvertQuestionTodo={(question) => handleConvertQuestionTodo(action.id, question)}
                  done={doneIds.has(action.id)}
                  showPostponePicker={expandedId === action.id && action.action_type === 'TODO' ? postponePickerOpen : false}
                />
              </div>
            ))}

            {sortedActions.length === 0 && (
              <div style={{
                textAlign: 'center',
                padding: `${theme.spacing.xxl} ${theme.spacing.lg}`,
                color: theme.colors.textMuted,
                fontSize: theme.typography.sizes.base,
              }}>
                Žádné akce k vyřízení.
              </div>
            )}
          </div>

          {/* Completed items — below cards */}
          <div style={{ marginTop: theme.spacing.lg }}>
            <CompletedSection items={data.completed} />
          </div>

          {/* Item 37: History link */}
          <div style={{ marginTop: theme.spacing.md, textAlign: 'center' }}>
            <button
              onClick={loadHistory}
              disabled={historyLoading}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: theme.typography.sizes.sm, color: theme.colors.textMuted,
                textDecoration: 'underline', opacity: historyLoading ? 0.5 : 1,
              }}
            >
              {historyLoading ? '...' : showHistory ? 'Skrýt historii' : 'Historie'}
            </button>
          </div>

          {/* History items */}
          {showHistory && historyItems.length > 0 && (
            <div style={{
              display: 'flex', flexDirection: 'column', gap: theme.spacing.xs,
              padding: `${theme.spacing.md} 0`,
            }}>
              {historyItems.map(action => (
                <div key={action.id} style={{
                  padding: `${theme.spacing.sm} ${theme.spacing.md}`,
                  backgroundColor: theme.colors.surface, borderRadius: theme.borderRadius.md,
                  border: `1px solid ${theme.colors.border}`, opacity: 0.6,
                }}>
                  <div style={{
                    fontSize: theme.typography.sizes.sm, color: theme.colors.textMuted,
                    textDecoration: 'line-through',
                  }}>
                    {action.headline || action.cpName || action.action_type}
                  </div>
                  <div style={{ fontSize: theme.typography.sizes.xs, color: theme.colors.textMuted }}>
                    {action.status === 'dismissed' ? 'Zrušeno' : 'Hotovo'}
                    {' · '}
                    {new Date(action.updated_at).toLocaleDateString('cs-CZ')}
                  </div>
                </div>
              ))}
            </div>
          )}
          {showHistory && historyItems.length === 0 && !historyLoading && (
            <div style={{
              textAlign: 'center', padding: theme.spacing.md,
              fontSize: theme.typography.sizes.sm, color: theme.colors.textMuted,
            }}>
              Žádná historie.
            </div>
          )}
        </div>

        {/* Sidebar column — itinerary (on desktop, right side; on mobile, below cards) */}
        <div className="brief-sidebar-column" style={{ marginTop: theme.spacing.xl }}>
          <ItineraryView
            todayEvents={data.events.today as BriefEvent[]}
            upcomingEvents={data.events.upcoming as BriefEvent[]}
            timezone={data.settings.timezone}
          />
        </div>
      </div>

      {/* ── Sticky bottom bar ───────────────────────────────────── */}
      <StickyBar
        ctas={getExpandedCTAs()}
        onCommand={handleCommand}
      />
    </div>
  )
}
