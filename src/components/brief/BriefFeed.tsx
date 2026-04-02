'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { theme } from '@/config/theme'
import { BriefCard } from './BriefCard'
import { ItineraryView } from './ItineraryView'
import { CompletedSection } from './CompletedSection'
import { StickyBar } from './StickyBar'
import type { BriefData, BriefAction, StickyBarCTA } from './types'

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
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  // Scroll to focused card on mount
  useEffect(() => {
    if (focusActionId) {
      const el = cardRefs.current.get(focusActionId)
      if (el) {
        setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100)
      }
    }
  }, [focusActionId])

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

  async function handleCommand(command: string) {
    // TODO: Wire to command parser API
    console.log('[BriefFeed] Command:', command)
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
          { label: 'Odložit', action: () => handlePostpone(id, 'tomorrow') },
          { label: 'Smazat', action: () => handleDismiss(id), destructive: true },
        ]
      default:
        return null
    }
  }

  const pendingCount = sortedActions.filter(a => !doneIds.has(a.id)).length
  const greeting = getGreeting()
  const firstName = data.userName?.split(' ')[0] || ''

  return (
    <div
      onTouchStart={onPullTouchStart}
      onTouchMove={onPullTouchMove}
      onTouchEnd={onPullTouchEnd}
      style={{
        maxWidth: '768px',
        margin: '0 auto',
        padding: '0',
        paddingBottom: '88px',
        minHeight: '100dvh',
        transform: pullY > 0 ? `translateY(${pullY}px)` : undefined,
        transition: isPulling.current ? 'none' : 'transform 0.3s ease',
        position: 'relative',
      }}
    >
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
        <div style={{
          fontSize: '11px',
          fontWeight: theme.typography.weights.semibold,
          color: theme.colors.primary,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}>
          Mila
        </div>
      </header>

      {/* ── Action cards ────────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing.sm,
        padding: `0 ${theme.spacing.md}`,
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
              onToggle={() => setExpandedId(expandedId === action.id ? null : action.id)}
              onExecute={() => handleExecute(action.id)}
              onConvertTodo={() => handleConvertTodo(action.id)}
              onDismiss={() => handleDismiss(action.id)}
              onPostpone={(postponeTo) => handlePostpone(action.id, postponeTo)}
              onRegenerateDraft={(instruction) => handleRegenerateDraft(action.id, instruction)}
              onSaveDraft={(d) => handleSaveDraft(action.id, d)}
              done={doneIds.has(action.id)}
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

      {/* ── Day itinerary ───────────────────────────────────────── */}
      <div style={{ padding: `${theme.spacing.xl} ${theme.spacing.md} 0` }}>
        <ItineraryView
          todayEvents={data.events.today as any}
          upcomingEvents={data.events.upcoming as any}
          timezone={data.settings.timezone}
        />
      </div>

      {/* ── Completed items ─────────────────────────────────────── */}
      <div style={{ padding: `0 ${theme.spacing.md}` }}>
        <CompletedSection items={data.completed} />
      </div>

      {/* ── Sticky bottom bar ───────────────────────────────────── */}
      <StickyBar
        ctas={getExpandedCTAs()}
        onCommand={handleCommand}
      />
    </div>
  )
}
