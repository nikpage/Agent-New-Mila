/**
 * Single source of truth for Look & Feel.
 * "Parchment & Blue" Scheme.
 * Used by both React components (Web UI) and Email Templates (Gmail).
 */

const typography = {
  fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
  sizes: {
    xs: '12px',
    sm: '14px',
    smPlus: '15px',   // collapsed card headline
    base: '16px',
    md: '17px',       // expanded card headline
    lg: '18px',
    xl: '20px',
    xxl: '24px',
  },
  weights: {
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  }
} as const

const spacing = {
  xs: '4px',
  sm: '8px',
  md: '16px',
  lg: '24px',
  xl: '32px',
  xxl: '48px',
} as const

const borderRadius = {
  sm: '4px',
  md: '8px',
  lg: '12px',
  full: '9999px',
} as const

const lineHeight = {
  tight: '1.25',    // headlines
  snug: '1.4',      // story / body text
  relaxed: '1.6',   // expanded card content
} as const

const letterSpacing = {
  tight: '-0.01em',   // semibold headlines
  normal: '0',
  wide: '0.01em',    // buttons and labels
  wider: '0.06em',    // uppercase labels if any
} as const

export const lightTheme = {
  colors: {
    // Base
    background: '#f8f5f2', // Parchment-like off-white
    surface: '#fefdfb',    // Warmer card surface
    surfaceWarm: '#faf9f7',

    // Primary (Blue)
    primary: '#1e3a8a',      // Deep Navy Blue
    primaryLight: '#2563eb', // Brighter Blue for hovers/accents
    primaryDark: '#172554',  // Darker Navy
    primaryGradient: 'linear-gradient(135deg, #1e3a8a 0%, #2563eb 100%)',

    // Secondary (Neutral/Gray)
    secondary: '#f3f4f6',      // Light Gray for secondary buttons/backgrounds
    secondaryHover: '#e5e7eb', // Slightly darker gray for hover states

    // Text
    text: '#1f2937',       // Dark Gray/Charcoal (High contrast)
    textMuted: '#4b5563',  // Better contrast on parchment
    textSubtle: '#4b5563', // Story and secondary text
    textLight: '#ffffff',  // White text

    // Borders & Dividers
    border: '#d1d5db',     // More card definition

    // Status / Accents
    accent: '#b45309',     // Warm Amber/Brown (compliments parchment)
    accentLight: '#d97706',
    success: '#059669',    // Green
    successBg: '#f0fdf4',  // Warmer green tint
    warning: '#d97706',    // Amber
    warningBg: '#fffbeb',
    error: '#c41e1e',      // Less harsh on parchment
    errorBg: '#fef2f2',
    urgencyMedium: '#9a3412', // Left border for urgency 7-8

    // Overlay
    overlay: 'rgba(0, 0, 0, 0.5)',
  },

  spacing,
  borderRadius,
  typography,
  lineHeight,
  letterSpacing,

  shadows: {
    card: '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)',
    hover: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
    modal: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
  },
} as const

export const darkTheme = {
  colors: {
    background: '#0f1a2e',      // deep navy, not black
    surface: '#1a2640',          // card surface
    surfaceWarm: '#1e2a3a',      // card hover

    primary: '#3b82f6',
    primaryLight: '#60a5fa',
    primaryDark: '#2563eb',
    primaryGradient: 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)',

    secondary: '#1e2d45',
    secondaryHover: '#243452',

    text: '#e8dcc8',             // warm cream, not pure white
    textMuted: '#8fa3b8',
    textSubtle: '#7a9ab5',
    textLight: '#ffffff',

    border: '#2d3f5a',

    accent: '#c4853a',           // amber/bronze
    accentLight: '#d97706',
    success: '#34d399',
    successBg: '#0f2a1e',
    warning: '#f59e0b',
    warningBg: '#2a1f0a',
    error: '#f87171',
    errorBg: '#2a0f0f',
    urgencyMedium: '#c2762a',

    overlay: 'rgba(0, 0, 0, 0.7)',
  },

  spacing,
  borderRadius,
  typography,
  lineHeight,
  letterSpacing,

  shadows: {
    card: '0 1px 3px 0 rgba(0, 0, 0, 0.4), 0 1px 2px 0 rgba(0, 0, 0, 0.3)',
    hover: '0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -2px rgba(0, 0, 0, 0.3)',
    modal: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.3)',
  },
} as const

/** Backward-compatible default export — used by server components and email templates */
export const theme = lightTheme

export interface Theme {
  colors: { [K in keyof typeof lightTheme.colors]: string }
  spacing: typeof lightTheme.spacing
  borderRadius: typeof lightTheme.borderRadius
  typography: typeof lightTheme.typography
  lineHeight: typeof lightTheme.lineHeight
  letterSpacing: typeof lightTheme.letterSpacing
  shadows: { [K in keyof typeof lightTheme.shadows]: string }
}
