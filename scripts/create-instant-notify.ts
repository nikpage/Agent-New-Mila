import { config } from 'dotenv'
config({ path: '.env.local' })
import { createInstantNotifySchedule } from '../src/lib/qstash/client'

createInstantNotifySchedule()
  .then(id => console.log('Instant-notify schedule created:', id))
  .catch(e => console.error('Failed:', e))
