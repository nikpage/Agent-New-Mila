'use client'

import { useState } from 'react'
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
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 0',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: '13.5px',
          color: 'var(--mtd)',
          fontWeight: 500,
        }}
      >
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '20px',
          height: '20px',
          borderRadius: '50%',
          backgroundColor: 'var(--success-bg)',
          color: 'var(--success)',
          fontSize: '12px',
        }}>
          ✓
        </span>
        Mila vyřídila {items.length} {items.length === 1 ? 'věc' : items.length < 5 ? 'věci' : 'věcí'}
        <span style={{
          transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 0.2s',
          fontSize: '10px',
        }}>
          ▸
        </span>
      </button>

      {expanded && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          paddingLeft: '24px',
          borderLeft: '2px solid var(--success-bg)',
        }}>
          {items.map(item => (
            <div key={item.id} style={{
              padding: '8px',
              fontSize: '13.5px',
              color: 'var(--mtd)',
              lineHeight: 1.5,
            }}>
              <span style={{ color: 'var(--txt)', fontWeight: 500 }}>
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
