'use client'

import { useEffect, useRef, useState } from 'react'
import { theme } from '@/config/theme'
import { BriefCard } from './BriefCard'
import { ItineraryView } from './ItineraryView'
import { CompletedSection } from './CompletedSection'
import { StickyBar } from './StickyBar'
import type { BriefData, BriefAction } from './types'

interface BriefFeedProps {
  initialData: BriefData
  userId: string
  token: string
  /** Deep-link to a specific action card */
  focusActionId?: string | null
  greeting?: string
}

export function BriefFeed({ initialData, userId, token, focusActionId, greeting }: BriefFeedProps) {
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

  // Hydrate with fresh data on mount
  useEffect(() => {
    async function refresh() {
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
        // Keep initial data on failure
      }
    }
    refresh()
  }, [userId, token])

  // Sort actions by urgency (highest first), then priority_score
  const sortedActions = [...data.actions].sort((a, b) => {
    if (b.urgency !== a.urgency) return b.urgency - a.urgency
    return b.priority_score - a.priority_score
  })

  // Action handlers — all use existing API endpoints
  async function handleExecute(actionId: string) {
    const res = await fetch(`/api/action/${actionId}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: getActionToken(actionId) }),
    })
    if (res.ok) {
      setDoneIds(prev => new Set(prev).add(actionId))
      setExpandedId(null)
    }
  }

  async function handleConvertTodo(actionId: string) {
    const res = await fetch(`/api/action/${actionId}/convert-todo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: getActionToken(actionId) }),
    })
    if (res.ok) {
      setDoneIds(prev => new Set(prev).add(actionId))
      setExpandedId(null)
    }
  }

  async function handleDismiss(actionId: string) {
    const res = await fetch(`/api/action/${actionId}/todo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: getActionToken(actionId) }),
    })
    if (res.ok) {
      setDoneIds(prev => new Set(prev).add(actionId))
      setExpandedId(null)
    }
  }

  async function handlePostpone(actionId: string, postponeTo: string) {
    const res = await fetch(`/api/action/${actionId}/postpone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: getActionToken(actionId), postponeTo }),
    })
    if (res.ok) {
      // Remove from visible list
      setData(prev => ({
        ...prev,
        actions: prev.actions.filter(a => a.id !== actionId),
      }))
      setExpandedId(null)
    }
  }

  async function handleRegenerateDraft(actionId: string, instruction: string): Promise<{ subject: string; body: string }> {
    const res = await fetch(`/api/action/${actionId}/regenerate-draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: getActionToken(actionId), instruction }),
    })
    if (!res.ok) throw new Error('Failed to regenerate')
    return res.json()
  }

  async function handleSaveDraft(actionId: string, data: Record<string, unknown>) {
    await fetch(`/api/action/${actionId}/draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: getActionToken(actionId), ...data }),
    })
  }

  async function handleCommand(command: string) {
    // TODO: Wire to command parser API when available
    console.log('[BriefFeed] Command:', command)
  }

  // Token helper — for the brief page, all actions share the page token
  // In production, per-action tokens should be generated server-side
  function getActionToken(_actionId: string): string {
    return token
  }

  const activeCardType = expandedId
    ? sortedActions.find(a => a.id === expandedId)?.action_type || null
    : null

  return (
    <div style={{
      maxWidth: '672px',
      margin: '0 auto',
      padding: `${theme.spacing.lg} ${theme.spacing.md}`,
      paddingBottom: '80px', // Space for sticky bar
      minHeight: '100vh',
    }}>
      {/* Greeting */}
      {greeting && (
        <div style={{
          fontSize: theme.typography.sizes.base,
          color: theme.colors.textMuted,
          marginBottom: theme.spacing.lg,
          lineHeight: 1.6,
        }}>
          {greeting}
        </div>
      )}

      {/* Action cards feed */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
        {sortedActions.map(action => (
          <div
            key={action.id}
            id={`action-${action.id}`}
            ref={el => { if (el) cardRefs.current.set(action.id, el) }}
          >
            <BriefCard
              action={action}
              token={token}
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
            padding: theme.spacing.xl,
            color: theme.colors.textMuted,
            fontSize: theme.typography.sizes.sm,
          }}>
            Žádné akce k vyřízení.
          </div>
        )}
      </div>

      {/* Day itinerary */}
      <div style={{ marginTop: theme.spacing.xl }}>
        <ItineraryView
          todayEvents={data.events.today as any}
          upcomingEvents={data.events.upcoming as any}
          timezone={data.settings.timezone}
        />
      </div>

      {/* Completed items */}
      <CompletedSection items={data.completed} />

      {/* Sticky bottom bar */}
      <StickyBar
        activeCardType={activeCardType}
        onCommand={handleCommand}
      />
    </div>
  )
}
