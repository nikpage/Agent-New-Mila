import 'dotenv/config'
import { createInterface } from 'readline'
import { upsertUser } from '../src/lib/db/users'
import { getAuthorizationUrl } from '../src/lib/google/auth'
import { generateOAuthState } from '../src/lib/auth/tokens'
import { v4 as uuidv4 } from 'uuid'

const rl = createInterface({
  input: process.stdin,
  output: process.stdout
})

async function main() {
  console.log('--- Mila User Creation Tool ---')
  console.log('This script will create a user in Supabase and generate a Google OAuth URL.')
  console.log('Ensure your application is running (npm run dev) to handle the callback.\n')

  rl.question('Enter email address: ', async (email) => {
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
        email_timezone: 'UTC', // Default, will be updated by settings lat er if needed
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

    } catch (error) {
      console.error('Error creating user:', error)
    } finally {
      rl.close()
      process.exit(0)
    }
  })
}

main().catch(console.error)
