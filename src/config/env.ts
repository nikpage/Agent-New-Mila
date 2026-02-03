/**
 * Environment configuration with type safety
 * All environment variables are validated at startup
 */

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function optionalEnv(name: string, defaultValue: string = ''): string {
  return process.env[name] || defaultValue
}

export const env = {
  // Supabase
  supabase: {
    url: requireEnv('SUPABASE_URL'),
    anonKey: requireEnv('SUPABASE_KEY'),
    serviceKey: requireEnv('SUPABASE_SERVICE_KEY'),
  },

  // Google OAuth
  google: {
    clientId: requireEnv('GOOGLE_CLIENT_ID'),
    clientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
    redirectUri: requireEnv('GOOGLE_REDIRECT_URI'),
    mapsApiKey: requireEnv('GOOGLE_MAPS_API_KEY'),
  },

  // AI
  gemini: {
    apiKey: requireEnv('GEMINI_API_KEY'),
  },

  // App
  app: {
    baseUrl: requireEnv('APP_BASE_URL'),
    cronSecret: requireEnv('CRON_SECRET'),
    adminPassword: optionalEnv('ADMIN_PASSWORD'),
  },

  // Auth
  auth: {
    secret: requireEnv('NEXTAUTH_SECRET'),
  },
} as const

// Lazy initialization to avoid errors during build
let _env: typeof env | null = null

export function getEnv() {
  if (!_env) {
    _env = env
  }
  return _env
}

// Safe access that returns undefined instead of throwing
export function getEnvSafe() {
  return {
    supabase: {
      url: process.env.SUPABASE_URL,
      anonKey: process.env.SUPABASE_KEY,
      serviceKey: process.env.SUPABASE_SERVICE_KEY,
    },
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      redirectUri: process.env.GOOGLE_REDIRECT_URI,
      mapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
    },
    gemini: {
      apiKey: process.env.GEMINI_API_KEY,
    },
    app: {
      baseUrl: process.env.APP_BASE_URL,
      cronSecret: process.env.CRON_SECRET,
      adminPassword: process.env.ADMIN_PASSWORD,
    },
    auth: {
      secret: process.env.NEXTAUTH_SECRET,
    },
  }
}
