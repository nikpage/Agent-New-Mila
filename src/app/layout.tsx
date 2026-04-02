import type { Metadata, Viewport } from 'next'
import './globals.css'
import { theme } from '@/config/theme'
import { ThemeProvider } from '@/contexts/ThemeContext'

export const metadata: Metadata = {
  title: 'Mila - Executive Assistant',
  description: 'Your AI-powered executive assistant',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8f5f2' },
    { media: '(prefers-color-scheme: dark)', color: '#0f1a2e' },
  ],
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <link rel="manifest" href="/manifest.json" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
      </head>
      <body className="antialiased" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
