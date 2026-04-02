'use client'

import { useState } from 'react'

export function usePressState() {
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
