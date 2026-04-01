'use client'

import { useState } from 'react'
import { theme } from '@/config/theme'
import type { CompletedActionSummary } from './types'

const TYPE_LABEL: Record<string, string> = {
  REPLY: 'Odpověď', SCHEDULE: 'Schůzka', TODO: 'Úkol',
}

interface CompletedSectionProps {
  items: CompletedActionSummary[]
}

export function CompletedSection({ items }: CompletedSectionProps) {
  const [expanded, setExpanded] = useState(false)

  if (items.length === 0) return null

  return (
    <div style={{ marginTop: theme.spacing.lg }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.spacing.sm,
          padding: `${theme.spacing.sm} 0`,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: theme.typography.sizes.sm,
          color: theme.colors.textMuted,
          fontWeight: theme.typography.weights.medium,
        }}
      >
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '20px',
          height: '20px',
          borderRadius: theme.borderRadius.full,
          backgroundColor: theme.colors.successBg,
          color: theme.colors.success,
          fontSize: '12px',
        }}>
          ✓
        </span>
        Mila vyřídila {items.length} {items.length === 1 ? 'věc' : items.length < 5 ? 'věci' : 'věcí'}
        <span style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
          ▸
        </span>
      </button>

      {expanded && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: theme.spacing.sm,
          paddingLeft: theme.spacing.lg,
          borderLeft: `2px solid ${theme.colors.successBg}`,
        }}>
          {items.map(item => (
            <div key={item.id} style={{
              padding: theme.spacing.sm,
              fontSize: theme.typography.sizes.sm,
              color: theme.colors.textMuted,
              lineHeight: 1.5,
            }}>
              <span style={{ color: theme.colors.text, fontWeight: theme.typography.weights.medium }}>
                {item.cpName || 'Neznámý'}
              </span>
              {' · '}
              <span>{TYPE_LABEL[item.actionType] || item.actionType}</span>
              {item.topic && <span> · {item.topic}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
