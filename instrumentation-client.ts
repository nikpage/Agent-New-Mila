// Client-side Sentry initialization for Next.js App Router
import * as Sentry from '@sentry/nextjs'

// Initialize Sentry for client-side
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  debug: false,
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: 0.1,
  integrations: [
    Sentry.replayIntegration({
      maskAllText: true,
      blockAllMedia: true,
    }),
  ],
})

// Export hooks for Next.js instrumentation
export const onRequestError = Sentry.captureException
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
