'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useTheme } from '@/contexts/ThemeContext'
import { BriefCard } from './BriefCard'
import { ItineraryView } from './ItineraryView'
import { CompletedSection } from './CompletedSection'
import { StickyBar } from './StickyBar'
import type { BriefData, BriefAction, BriefEvent, CoolingContact } from './types'

interface BriefFeedProps {
  initialData: BriefData
  userId: string
  token: string
  focusActionId?: string | null
}

function formatDateCzech(): string {
  const now = new Date()
  return now.toLocaleDateString('cs-CZ', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Dobré ráno'
  if (hour < 18) return 'Dobré odpoledne'
  return 'Dobrý večer'
}

export function BriefFeed({ initialData, userId, token, focusActionId }: BriefFeedProps) {
  const { isDark, toggleTheme, ...theme } = useTheme()
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

  // Get token for an action
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

  // Toast feedback for commands
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function showToast(msg: string) {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 4000)
  }

  async function handleCommand(command: string) {
    const res = await fetch('/api/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, userId, command }),
    })
    if (res.ok) {
      const result = await res.json()
      if (result.success) {
        await refreshData()
      }
      showToast(result.message || (result.success ? 'Hotovo' : 'Nepodařilo se'))
    } else {
      showToast('Chyba při zpracování')
    }
  }

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

  const pendingCount = sortedActions.filter(a => !doneIds.has(a.id)).length
  const dateStr = formatDateCzech()
  const greeting = data.greeting || `${getGreeting()}${data.userName ? `, ${data.userName.split(' ')[0]}` : ''}.`

  // Generate a contextual subtitle
  const subtitle = pendingCount > 0
    ? `${pendingCount} ${pendingCount === 1 ? 'věc k vyřízení' : pendingCount < 5 ? 'věci k vyřízení' : 'věcí k vyřízení'}`
    : 'Vše vyřízeno'

  return (
    <div
      onTouchStart={onPullTouchStart}
      onTouchMove={onPullTouchMove}
      onTouchEnd={onPullTouchEnd}
      className="mila-page"
      style={{
        paddingBottom: '80px',
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
          fontSize: '11px',
          color: 'var(--sub)',
          opacity: pullY >= PULL_THRESHOLD || refreshing ? 1 : pullY / PULL_THRESHOLD,
        }}>
          {refreshing ? 'Aktualizuji...' : pullY >= PULL_THRESHOLD ? 'Pusťte pro obnovení' : ''}
        </div>
      )}

      {/* ── Header ──────────────────────────────────────────────── */}
      <header style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: '12px',
        marginBottom: '28px',
      }}>
        <div>
          <div style={{
            fontSize: '11px',
            fontWeight: 600,
            letterSpacing: '0.09em',
            textTransform: 'uppercase',
            color: 'var(--sub)',
            marginBottom: '7px',
          }}>
            {dateStr}
          </div>
          <div
            className="mila-htitle"
            style={{
              fontFamily: 'Georgia, serif',
              fontStyle: 'italic',
              fontSize: '19px',
              color: 'var(--txt)',
              lineHeight: 1.38,
            }}
          >
            {greeting}
          </div>
        </div>
        <button
          onClick={toggleTheme}
          style={{
            width: '36px',
            height: '36px',
            borderRadius: '50%',
            background: 'var(--surf)',
            border: '1px solid var(--brd)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            marginTop: '2px',
            outline: 'none',
            WebkitTapHighlightColor: 'transparent',
            transition: 'background .3s, border-color .3s',
          }}
        >
          {isDark ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--sub)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--sub)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>
      </header>

      {/* ── Desktop grid: cards left, sidebar right ─────────── */}
      <div className="mila-desktop-grid">
        {/* ── Main column: action cards ───────────────────────── */}
        <div>
          {sortedActions.length > 0 && (
            <>
              <div style={{
                fontSize: '11px',
                fontWeight: 600,
                letterSpacing: '0.09em',
                textTransform: 'uppercase',
                color: 'var(--sub)',
                margin: '0 0 10px 2px',
              }}>
                K vyřízení
              </div>

              {sortedActions.map(action => (
                <div
                  key={action.id}
                  id={`action-${action.id}`}
                  ref={el => { if (el) cardRefs.current.set(action.id, el) }}
                  style={{ marginBottom: '12px' }}
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
                    onUndo={() => { setDoneIds(prev => { const next = new Set(prev); next.delete(action.id); return next }) }}
                    done={doneIds.has(action.id)}
                    showPostponePicker={expandedId === action.id && action.action_type === 'TODO' ? postponePickerOpen : false}
                    isFirst={false}
                  />
                </div>
              ))}
            </>
          )}

          {sortedActions.length === 0 && (
            <div style={{
              textAlign: 'center',
              padding: '48px 24px',
              color: 'var(--mtd)',
              fontSize: '13.5px',
            }}>
              Žádné akce k vyřízení.
            </div>
          )}

          {/* Completed items — below cards in main column */}
          {data.completed.length > 0 && (
            <div style={{ marginTop: '24px' }}>
              <CompletedSection items={data.completed} />
            </div>
          )}
        </div>

        {/* ── Sidebar: cooling contacts + agenda ─────────────── */}
        <div>
          {/* Cooling contacts */}
          {(data.coolingContacts || []).length > 0 && (
            <>
              <div style={{
                fontSize: '11px',
                fontWeight: 600,
                letterSpacing: '0.09em',
                textTransform: 'uppercase',
                color: 'var(--sub)',
                margin: '0 0 10px 2px',
              }}>
                Chladnoucí kontakty
              </div>

              {(data.coolingContacts || []).map(contact => (
                <CoolingCard key={contact.conversationId} contact={contact} />
              ))}
            </>
          )}

          {/* Today's agenda */}
          <ItineraryView
            todayEvents={data.events.today as BriefEvent[]}
            upcomingEvents={data.events.upcoming as BriefEvent[]}
            timezone={data.settings.timezone}
            userId={userId}
            token={token}
          />
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed',
          bottom: '80px',
          left: '50%',
          transform: 'translateX(-50%)',
          backgroundColor: 'var(--txt)',
          color: 'var(--bg)',
          padding: '8px 24px',
          borderRadius: '14px',
          fontSize: '13.5px',
          fontWeight: 500,
          boxShadow: 'var(--sdw-h)',
          zIndex: 50,
          maxWidth: '80vw',
          textAlign: 'center',
        }}>
          {toast}
        </div>
      )}

      {/* ── Sticky bottom bar ───────────────────────────────────── */}
      <StickyBar onCommand={handleCommand} />
    </div>
  )
}

/** Cooling contact card */
function CoolingCard({ contact }: { contact: CoolingContact }) {
  const label = contact.topic
    ? `${contact.cpName} — ${contact.topic}`
    : contact.cpName

  return (
    <div style={{
      marginBottom: '10px',
      borderRadius: '14px',
      border: '1px solid var(--brd)',
      background: 'var(--surf)',
      padding: '13px 15px 13px 18px',
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      boxShadow: 'var(--sdw), inset 4px 0 0 var(--cool)',
      transition: 'background .2s, box-shadow .25s, transform .25s cubic-bezier(.34,1.56,.64,1)',
      cursor: 'default',
    }}>
      <span style={{
        width: '7px',
        height: '7px',
        borderRadius: '50%',
        background: 'var(--cool)',
        flexShrink: 0,
        opacity: 0.75,
      }} />
      <span style={{
        fontFamily: 'Georgia, serif',
        fontSize: '14px',
        fontWeight: 700,
        color: 'var(--mtd)',
        flex: 1,
        lineHeight: 1.25,
      }}>
        {label}
      </span>
      <span style={{
        fontSize: '11px',
        fontWeight: 600,
        color: 'var(--cool)',
        whiteSpace: 'nowrap',
      }}>
        {contact.daysSilent} {contact.daysSilent === 1 ? 'den' : contact.daysSilent < 5 ? 'dny' : 'dní'} ticha
      </span>
    </div>
  )
}
