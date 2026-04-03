/**
 * Single source of truth for Look & Feel.
 * "Parchment & Blue" Scheme — updated to match refined design.
 * Used by both React components (Web UI) and Email Templates (Gmail).
 */

const typography = {
  fontFamily: "system-ui, -apple-system, sans-serif",
  headingFontFamily: "Georgia, serif",
  sizes: {
    xs: '11px',
    sm: '13.5px',
    smPlus: '15.5px',   // collapsed card headline
    base: '13.5px',
    md: '17px',          // expanded card headline
    lg: '18px',
    xl: '19px',          // header title
    xxl: '19px',
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
  md: '9px',
  lg: '14px',
  full: '9999px',
} as const

const lineHeight = {
  tight: '1.25',    // headlines
  snug: '1.38',     // header title
  relaxed: '1.52',  // card story
  spacious: '1.62', // plan text
} as const

const letterSpacing = {
  tight: '-0.01em',
  normal: '0',
  wide: '0.01em',
  wider: '0.09em',    // uppercase section labels
} as const

export const lightTheme = {
  colors: {
    // Base
    background: '#f0ebe2',
    surface: '#f9f6f1',
    surfaceHover: '#e8e0d4',

    // Primary (Blue gradient)
    primary: '#1a3566',
    primaryLight: '#2654a8',
    primaryDark: '#1a3566',
    primaryGradient: 'linear-gradient(150deg, #1a3566 0%, #2654a8 100%)',

    // Secondary
    secondary: '#f0ebe2',
    secondaryHover: '#e8e0d4',

    // Text
    text: '#1c1f2a',
    textMuted: '#676b7a',
    textSubtle: '#97a0af',
    textLight: '#ffffff',

    // Borders
    border: '#ddd6ca',

    // Outline buttons
    outlineBorder: '#c4bbb0',
    outlineText: '#4a4e5a',

    // Status / Accents
    accent: '#b05c14',
    accentLight: '#d97706',
    success: '#059669',
    successBg: '#f0fdf4',
    warning: '#d97706',
    warningBg: '#fffbeb',
    error: '#c0200e',
    errorBg: '#fef2f2',
    urgencyMedium: '#7a6200',

    // Cooling contacts
    cool: '#1a6566',

    // Bottom bar
    barBackground: '#f9f6f1',
    barBorder: '#ddd6ca',

    // Overlay
    overlay: 'rgba(0, 0, 0, 0.5)',
  },

  spacing,
  borderRadius,
  typography,
  lineHeight,
  letterSpacing,

  shadows: {
    card: '0 1px 3px rgba(0,0,0,.07), 0 2px 8px rgba(0,0,0,.05)',
    hover: '0 6px 22px rgba(0,0,0,.15)',
    modal: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
  },
} as const

export const darkTheme = {
  colors: {
    background: '#0c1320',
    surface: '#12203a',
    surfaceHover: '#1c2e50',

    primary: '#1d4d9c',
    primaryLight: '#3a7fd4',
    primaryDark: '#1d4d9c',
    primaryGradient: 'linear-gradient(150deg, #1d4d9c 0%, #3a7fd4 100%)',

    secondary: '#1c2e50',
    secondaryHover: '#253a60',

    text: '#e5ddd0',
    textMuted: '#8da2ba',
    textSubtle: '#6882a0',
    textLight: '#ffffff',

    border: '#253a60',

    outlineBorder: '#2d4268',
    outlineText: '#8da2ba',

    accent: '#c07428',
    accentLight: '#d97706',
    success: '#34d399',
    successBg: '#0f2a1e',
    warning: '#f59e0b',
    warningBg: '#2a1f0a',
    error: '#e84848',
    errorBg: '#2a0f0f',
    urgencyMedium: '#d4a800',

    cool: '#20a0a0',

    barBackground: '#0e1a2e',
    barBorder: '#1f3050',

    overlay: 'rgba(0, 0, 0, 0.7)',
  },

  spacing,
  borderRadius,
  typography,
  lineHeight,
  letterSpacing,

  shadows: {
    card: '0 0 0 1px rgba(255,255,255,.04)',
    hover: '0 6px 22px rgba(0,0,0,.55)',
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
