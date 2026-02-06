import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Primary: Ink Blue
        primary: {
          DEFAULT: '#1a2744',
          light: '#2a3a54',
          dark: '#0f1a2e',
        },
        // Accent: Earth Brown
        accent: {
          DEFAULT: '#6b3d3d',
          light: '#8b4d4d',
          dark: '#4a2a2a',
        },
        // Background: Parchment
        background: '#F9F7F2',
        // Surface: Paper White
        surface: '#FFFFFF',
        border: '#E2E0D9',
        text: {
          DEFAULT: '#1a2744',
          muted: '#64748b',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'card': '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.05)',
        'card-hover': '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.05)',
      },
    },
  },
  plugins: [],
}

export default config
