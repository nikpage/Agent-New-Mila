/**
 * Per-Client Configuration
 *
 * THIS IS THE FILE YOU MODIFY DURING CLIENT SETUP.
 * Each deployment gets a customized version of this file.
 * This is the "1k EUR setup" — sit with the client, understand their
 * business, and configure everything here.
 *
 * The rest of the codebase reads from this config.
 */

export const clientConfig = {
  // ─── Client Identity ───────────────────────────────────────────────
  client: {
    name: 'Jan Novák',
    company: 'RE/MAX Premium',
    role: 'Senior Real Estate Agent',
    email: 'jan@remax-premium.cz',
    phone: '+420777123456',
    /** WhatsApp number — digits only with country code, no spaces */
    whatsapp: '+420777123456',
  },

  // ─── Business Context ──────────────────────────────────────────────
  // Fed to AI so it understands the client's world
  business: {
    type: 'real_estate' as const,
    market: 'Prague residential real estate',
    specialization: 'Luxury apartments in Prague 1-3',
    /** Typical deal range — used for AI to estimate dollarValue */
    typicalDealSize: { min: 3_000_000, max: 25_000_000, currency: 'CZK' },
    /** Signals that a lead is high-value (matched against message text) */
    highValueSignals: [
      'penthouse', 'investment', 'portfolio', 'developer',
      'company purchase', 'cash buyer', 'urgent sale',
      'exclusive', 'off-market', 'celý dům', 'developerský projekt',
    ],
    /** Signals that a lead is low-priority (informational, not buying/selling) */
    lowPrioritySignals: [
      'just looking', 'jen se dívám', 'market report', 'newsletter',
      'price index', 'cenová mapa',
    ],
  },

  // ─── AI Persona ────────────────────────────────────────────────────
  ai: {
    /** What the assistant calls itself */
    name: 'Mila',
    /** Primary language for all outputs */
    language: 'cs' as const,
    /** How Mila talks TO the client (internal comms) */
    toneWithUser: 'Professional, warm, concise. Address as "pane Nováku".',
    /** How Mila talks TO counterparties (external comms) */
    toneWithCounterparties: 'Polite, formal Czech. Sign emails as "S pozdravem, Jan Novák, RE/MAX Premium".',
    /** Email signature block */
    emailSignature: `S pozdravem,
Jan Novák
Senior Real Estate Agent
RE/MAX Premium
Tel: +420 777 123 456
jan@remax-premium.cz`,
    /**
     * System context injected into ALL AI prompts.
     * This is the core personality and knowledge base.
     * Write it like you're briefing a new human assistant on day 1.
     */
    systemContext: `You assist Jan Novák, a senior real estate agent at RE/MAX Premium in Prague.
He specializes in luxury residential properties in Prague 1-3.
He values efficiency, hates wasted time, and wants every lead followed up within 24 hours.
His biggest fear is losing a deal because a lead went cold.
When a buyer or seller reaches out, treat it as the highest priority.
All communications should be in Czech unless the counterparty writes in another language.
For scheduling: Jan prefers morning meetings (9-12) and uses his car between appointments.
His office is at Václavské náměstí 1, Praha 1.`,
  },

  // ─── Lead Management ───────────────────────────────────────────────
  // The core value: don't drop leads, increase closing rate
  leads: {
    /** Days without ANY activity before a lead status becomes "cooling" */
    coolingThresholdDays: 2,
    /** Days without activity before a lead is "cold" — urgent follow-up needed */
    coldThresholdDays: 5,
    /** Days without activity before lead is considered "dead" — escalate to user */
    deadThresholdDays: 14,
    /** Max auto follow-ups Mila generates before escalating to user decision */
    maxAutoFollowUps: 3,
    /** Priority multiplier for leads approaching cold status */
    coolingPriorityBoost: 1.5,
    /** Priority multiplier for cold leads (stacks with cooling) */
    coldPriorityBoost: 2.5,
    /** Minimum deal value to trigger lead tracking (ignore tiny/unknown deals) */
    minDealValueForTracking: 0,
  },

  // ─── WhatsApp ──────────────────────────────────────────────────────
  whatsapp: {
    /** Enable WhatsApp channel */
    enabled: true,
    /** Directory for WA Web session persistence (QR code scan saved here) */
    sessionDataPath: './.wwebjs_auth',
    /** Port for the local WA daemon HTTP API */
    daemonPort: 3001,
    /** Optional auto-acknowledge message sent immediately on receipt */
    autoAckMessage: null as string | null,
    /** Phone numbers to ignore (automated services, spam) */
    blockedNumbers: [] as string[],
    /** Group chats to monitor (by group name). Empty = ignore all groups. */
    monitoredGroups: [] as string[],
  },

  // ─── Calendar ──────────────────────────────────────────────────────
  calendar: {
    /** Primary business calendar ID */
    businessCalendarId: 'primary',
    /** Personal calendar ID (if separate from business). null = single calendar. */
    personalCalendarId: null as string | null,
    /**
     * Keywords in event titles that mark them as personal.
     * Used when business + personal events are on the same calendar.
     * Personal events block time but don't generate action proposals.
     */
    personalEventKeywords: [
      'osobní', 'personal', 'rodina', 'family', 'lékař', 'doctor',
      'dentist', 'zubař', 'sport', 'gym', 'fitness', 'dovolená',
      'vacation', 'holiday', 'narozeniny', 'birthday', 'výročí',
      'anniversary', 'škola', 'school', 'kroužek',
    ],
  },

  // ─── Priority Scoring ──────────────────────────────────────────────
  scoring: {
    /** Boost for seller-side deals (listing agent earns more commission) */
    offerMultiplierSeller: 1.5,
    /** Baseline for buyer-side deals */
    offerMultiplierBuyer: 1.0,
    /** Multiplier for VIP contacts */
    priorityMultiplierVip: 2.0,
    /** Fibonacci-based scoring factor */
    kcFactor: 13,
  },
} as const

export type ClientConfig = typeof clientConfig

/**
 * Helper to get the AI system context with client details.
 * Injected into every AI prompt for consistent persona.
 */
export function getAISystemPrompt(): string {
  const { ai, business, client } = clientConfig
  return `${ai.systemContext}

Business: ${client.company} — ${business.specialization}
Market: ${business.market}
Typical deal: ${business.typicalDealSize.min.toLocaleString()}-${business.typicalDealSize.max.toLocaleString()} ${business.typicalDealSize.currency}

High-value signals: ${business.highValueSignals.join(', ')}
Language: ${ai.language === 'cs' ? 'Czech' : ai.language}
Tone with counterparties: ${ai.toneWithCounterparties}`
}

/**
 * Check if a message contains high-value deal signals.
 * Used by lead tracking to boost priority.
 */
export function containsHighValueSignals(text: string): boolean {
  const lower = text.toLowerCase()
  return clientConfig.business.highValueSignals.some(signal =>
    lower.includes(signal.toLowerCase())
  )
}

/**
 * Check if an event title indicates a personal (non-business) event.
 */
export function isPersonalEvent(title: string): boolean {
  const lower = title.toLowerCase()
  return clientConfig.calendar.personalEventKeywords.some(keyword =>
    lower.includes(keyword.toLowerCase())
  )
}
