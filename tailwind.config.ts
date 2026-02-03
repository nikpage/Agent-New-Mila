import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Primary: Dark blue - elegant, professional
        primary: {
          DEFAULT: '#1a2744',
          light: '#243352',
          dark: '#0f1a2e',
          50: '#e8ebf0',
          100: '#c5cdd9',
          200: '#9eabc0',
          300: '#7789a7',
          400: '#596f94',
          500: '#3b5581',
          600: '#334a73',
          700: '#293c61',
          800: '#1a2744',
          900: '#0f1a2e',
        },
        // Accent: Dark reddish-brown - warm, sophisticated
        accent: {
          DEFAULT: '#6b3d3d',
          light: '#8b4d4d',
          dark: '#4a2a2a',
          50: '#f5eaea',
          100: '#e6cbcb',
          200: '#d5a8a8',
          300: '#c48585',
          400: '#b76a6a',
          500: '#a95050',
          600: '#8b4d4d',
          700: '#6b3d3d',
          800: '#4a2a2a',
          900: '#2d1a1a',
        },
        // Background: Very dark blue
        background: '#0f1623',
        // Surface: Cards, modals
        surface: '#1a2744',
        // Border
        border: '#2a3a54',
        // Text colors
        text: {
          DEFAULT: '#e5e7eb',
          muted: '#9ca3af',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'card': '0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -2px rgba(0, 0, 0, 0.2)',
        'card-hover': '0 10px 15px -3px rgba(0, 0, 0, 0.4), 0 4px 6px -4px rgba(0, 0, 0, 0.3)',
      },
    },
  },
  plugins: [],
}

export default config
