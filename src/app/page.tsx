/**
 * Mila - Home page
 * This is not a user-facing app, it's an agent.
 * This page shows status and provides OAuth setup.
 */

export default function HomePage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="card max-w-md w-full p-8 text-center">
        <div className="w-16 h-16 bg-accent/20 rounded-full flex items-center justify-center mx-auto mb-6">
          <svg
            className="w-8 h-8 text-accent-light"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
            />
          </svg>
        </div>

        <h1 className="text-2xl font-semibold mb-2">Mila</h1>
        <p className="text-text-muted mb-8">
          Your AI-powered executive assistant
        </p>

        <div className="space-y-4">
          <a
            href="/auth/connect"
            className="btn-primary w-full block"
          >
            Connect Google Account
          </a>

          <a
            href="/api/health"
            className="btn-outline w-full block"
          >
            Check System Status
          </a>
        </div>

        <p className="text-text-muted text-sm mt-8">
          Mila manages your decisions, not your emails.
        </p>
      </div>
    </main>
  )
}
