import { config } from 'dotenv'
config({ path: '.env.local' })
import { createInterface } from 'readline'
import { spawn } from 'child_process'
import { upsertUser } from '../src/lib/db/users'
import { getAuthorizationUrl } from '../src/lib/google/auth'
import { generateOAuthState } from '../src/lib/auth/tokens'
import { v4 as uuidv4 } from 'uuid'

const rl = createInterface({
  input: process.stdin,
  output: process.stdout
})

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()))
  })
}

async function main() {
  console.log('--- Mila User Creation Tool ---')
  console.log('This script will create a user in Supabase and generate a Google OAuth URL.')
  console.log('Ensure your application is running (npm run dev) to handle the callback.\n')

  const email = await ask('Enter email address: ')
  if (!email || !email.includes('@')) {
    console.error('Invalid email address')
    process.exit(1)
  }

  try {
    const userId = uuidv4()
    console.log(`\nCreating user record for ${email}...`)
    console.log(`User ID: ${userId}`)

    // Create the user in Supabase
    await upsertUser({
      id: userId,
      email: email.toLowerCase(),
      email_enabled: true,
      email_unsubscribed: false,
      email_timezone: 'UTC', // Default, will be updated by settings later if needed
    })

    console.log('User record created successfully.')

    // Generate OAuth state and URL
    const state = generateOAuthState(userId)
    const authUrl = getAuthorizationUrl(state)

    console.log('\n--- ACTION REQUIRED ---')
    console.log('1. Ensure your app is running at http://localhost:3000 (or your configured APP_BASE_URL)')
    console.log('2. Open the following URL in your browser to connect Google Account:')
    console.log('\n' + authUrl + '\n')
    console.log('After you grant permissions, the app will save the tokens and the user will be fully active.')

    // Offer to continue to settings configuration
    const configure = await ask('\nConfigure user settings now? [yes]: ')
    if (!configure || configure.toLowerCase() === 'yes' || configure.toLowerCase() === 'y') {
      console.log('\nLaunching settings configuration...\n')
      rl.close()

      const child = spawn('npx', ['tsx', 'scripts/configure-user.ts', '--user-id', userId], {
        stdio: 'inherit',
        cwd: process.cwd(),
      })

      child.on('close', (code) => {
        process.exit(code ?? 0)
      })
    } else {
      console.log(`\nSkipped. Run settings configuration later with:`)
      console.log(`  npx tsx scripts/configure-user.ts --user-id ${userId}`)
      rl.close()
      process.exit(0)
    }

  } catch (error) {
    console.error('Error creating user:', error)
    rl.close()
    process.exit(1)
  }
}

main().catch(console.error)
