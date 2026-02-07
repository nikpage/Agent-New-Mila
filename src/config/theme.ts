/**
 * Single source of truth for Look & Feel.
 * "Parchment & Blue" Scheme.
 * Used by both React components (Web UI) and Email Templates (Gmail).
 */

export const theme = {
  colors: {
    // Base
    background: '#f8f5f2', // Parchment-like off-white
    surface: '#ffffff',    // Pure white for cards

    // Primary (Blue)
    primary: '#1e3a8a',      // Deep Navy Blue
    primaryLight: '#2563eb', // Brighter Blue for hovers/accents
    primaryDark: '#172554',  // Darker Navy

    // Secondary (Neutral/Gray)
    secondary: '#f3f4f6',      // Light Gray for secondary buttons/backgrounds
    secondaryHover: '#e5e7eb', // Slightly darker gray for hover states

    // Text
    text: '#1f2937',       // Dark Gray/Charcoal (High contrast)
    textMuted: '#6b7280',  // Medium Gray
    textLight: '#ffffff',  // White text

    // Borders & Dividers
    border: '#e5e7eb',

    // Status / Accents
    accent: '#b45309',     // Warm Amber/Brown (compliments parchment)
    accentLight: '#d97706',
    success: '#059669',    // Green
    successBg: '#ecfdf5',
    warning: '#d97706',    // Amber
    warningBg: '#fffbeb',
    error: '#dc2626',      // Red
    errorBg: '#fef2f2',

    // Overlay
    overlay: 'rgba(0, 0, 0, 0.5)',
  },

  spacing: {
    xs: '4px',
    sm: '8px',
    md: '16px',
    lg: '24px',
    xl: '32px',
    xxl: '48px',
  },

  borderRadius: {
    sm: '4px',
    md: '8px',
    lg: '12px',
    full: '9999px',
  },

  shadows: {
    card: '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)',
    hover: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
    modal: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
  },

  typography: {
    fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
    sizes: {
      xs: '12px',
      sm: '14px',
      base: '16px',
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
  }
} as const
