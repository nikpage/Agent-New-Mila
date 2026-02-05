import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai'
import type { ConversationSummary, ActionType } from '../supabase/types'

let genAI: GoogleGenerativeAI | null = null
let model: GenerativeModel | null = null

function getModel(): GenerativeModel {
  if (!model) {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error('GEMINI_API_KEY not configured')
    genAI = new GoogleGenerativeAI(apiKey)
    model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' }) // gemini-2.5-flash is correct and current. DO NOT CHANGE THIS
  }
  return model
}

export async function analyzeConversation(
  messages: { direction: string; text: string; date: Date }[]
): Promise<ConversationSummary> {
  const model = getModel()
  const messageText = messages
    .map(m => `[${m.direction}] ${m.date.toISOString().split('T')[0]}: ${m.text}`)
    .join('\n\n')

  const prompt = `Analyze this email conversation and provide a JSON summary.

CONVERSATION:
${messageText}

Respond with ONLY valid JSON in this exact format:
{
  "currentState": "Brief description of where this conversation/deal currently stands (in Czech)",
  "risks": ["Risk 1 (in Czech)", "Risk 2 (in Czech)"],
  "nextSteps": ["Next step 1 (in Czech)", "Next step 2 (in Czech)"],
  "keyPoints": ["Key point 1 (in Czech)", "Key point 2 (in Czech)"]
}

Be concise. Focus on actionable insights.`

  const result = await model.generateContent(prompt)
  const text = result.response.text()
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse conversation analysis')

  return JSON.parse(jsonMatch[0]) as ConversationSummary
}

/**
 * Determine what action should be proposed (Intent Only - NO DRAFTS)
 */
export async function proposeAction(
  conversationSummary: ConversationSummary,
  recentMessages: { direction: string; text: string }[],
  cpName: string | null
): Promise<{
  actionType: ActionType
  rationale_cs: string
  intent_cs: string
  missingInfo: { label: string; placeholder: string; value: null }[]
  urgency: number
  dollarValue: number
  painFactor: number
}> {
  const model = getModel()

  const recentText = recentMessages
    .slice(-3)
    .map(m => `[${m.direction}]: ${m.text.slice(0, 500)}`)
    .join('\n\n')

  const prompt = `Based on this conversation state, determine what action the user should take.

CONVERSATION STATE:
${JSON.stringify(conversationSummary, null, 2)}

RECENT MESSAGES:
${recentText}

COUNTERPARTY: ${cpName || 'Unknown'}

Respond with ONLY valid JSON:
{
  "actionType": "REPLY" | "SCHEDULE" | "WAIT" | "FILE",
  "rationale_cs": "One sentence explaining WHY this action is needed now (Trigger). Must be in CZECH.",
  "intent_cs": "The plan. 1-2 sentences written TO THE USER (first person 'Navrhuji...'). Explain what you will do. Must be in CZECH. Return null if actionType is WAIT/FILE.",
  "missingInfo": [{"label": "Label in Czech (e.g. Plocha bytu)", "placeholder": "Example value (e.g. 75 m2)", "value": null}],
  "urgency": 1-10 (10 = needs immediate attention),
  "dollarValue": estimated deal value in dollars (0 if unknown),
  "painFactor": 1-10 (how much pain from ignoring this)
}

Rules:
- DO NOT write the email draft.
- intent_cs must be a plan summary addressed to the user in Czech.
- missingInfo: Analyze the incoming email. If the sender asked specific questions (e.g. "How big is the flat?", "When can we meet?"), create a form field for each missing piece of data so the user can fill it in.`

  const result = await model.generateContent(prompt)
  const text = result.response.text()

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse action proposal')

  return JSON.parse(jsonMatch[0])
}

/**
 * Generate the Final Draft (Just-In-Time)
 */
export async function generateFinalDraft(
  conversationContext: any,
  intent: string,
  userNotes?: string,
  missingInfo?: any[],
  cpName?: string
): Promise<{ subject: string; body: string }> {
  const model = getModel()

  const prompt = `You are an executive assistant writing an email on behalf of your boss.
Language: CZECH.

CONTEXT:
${JSON.stringify(conversationContext, null, 2)}

THE PLAN (INTENT):
${intent}

${userNotes ? `USER NOTES (Override the plan if needed):
${userNotes}` : ''}

${missingInfo && missingInfo.length > 0 ? `SPECIFIC DATA PROVIDED BY USER:
${JSON.stringify(missingInfo)}` : ''}

RECIPIENT: ${cpName || 'The Counterparty'}

Write the final email in CZECH.
- Professional, concise tone.
- Use the specific data provided in the missingInfo section to answer the counterparty's questions.
- If the plan implies scheduling, propose the specific times mentioned.

Respond with ONLY valid JSON:
{
  "subject": "Email subject line",
  "body": "Email body text (ready to send)"
}`

  const result = await model.generateContent(prompt)
  const text = result.response.text()

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse draft reply')

  return JSON.parse(jsonMatch[0])
}

// ... (Keep extractTopic, shouldJoinConversation, generateBriefHeadline, classifyEmail - they are fine) ...
export async function extractTopic(messages: { text: string }[]): Promise<string> {
  const model = getModel()
  const messageTexts = messages.slice(0, 5).map(m => m.text.slice(0, 300)).join('\n---\n')
  const prompt = `What is the main topic of this email conversation? Respond with ONLY a brief topic (3-7 words) in CZECH.\n\n${messageTexts}`
  const result = await model.generateContent(prompt)
  return result.response.text().trim()
}

export async function shouldJoinConversation(
  newMessage: { subject: string; body: string; from: string },
  existingConversation: { topic: string; summary: string; participants: string[] }
): Promise<boolean> {
  const model = getModel()
  const prompt = `Does this new email belong to the existing conversation?\n\nNEW EMAIL:\nFrom: ${newMessage.from}\nSubject: ${newMessage.subject}\nBody preview: ${newMessage.body.slice(0, 500)}\n\nEXISTING CONVERSATION:\nTopic: ${existingConversation.topic}\nSummary: ${existingConversation.summary}\nParticipants: ${existingConversation.participants.join(', ')}\n\nRespond with ONLY "yes" or "no".`
  const result = await model.generateContent(prompt)
  const answer = result.response.text().toLowerCase().trim()
  return answer === 'yes' || answer.includes('yes')
}

export async function generateBriefHeadline(
  todayEvents: { title: string; time: string }[],
  pendingActions: { type: string; cpName: string; urgency: number }[],
  tomorrowHighlights?: string[]
): Promise<string> {
  const model = getModel()
  const eventsText = todayEvents.length > 0 ? todayEvents.map(e => `${e.time}: ${e.title}`).join('\n') : 'No meetings scheduled'
  const actionsText = pendingActions.sort((a, b) => b.urgency - a.urgency).slice(0, 5).map(a => `${a.type} for ${a.cpName} (urgency: ${a.urgency})`).join('\n')
  const prompt = `Write a brief, personal executive assistant-style morning briefing headline (2-3 sentences) in CZECH.\n\nTODAY'S SCHEDULE:\n${eventsText}\n\nPENDING ACTIONS:\n${actionsText}\n\n${tomorrowHighlights ? `TOMORROW: ${tomorrowHighlights.join(', ')}` : ''}\n\nWrite as if you're a thoughtful executive assistant giving a quick morning status. Be warm but professional. Focus on what matters most today.`
  const result = await model.generateContent(prompt)
  return result.response.text().trim()
}

export async function classifyEmail(
  subject: string,
  body: string,
  from: string
): Promise<{
  isActionable: boolean
  category: 'meeting_request' | 'question' | 'update' | 'confirmation' | 'newsletter' | 'spam' | 'other'
  priority: 'high' | 'medium' | 'low'
}> {
  const model = getModel()
  const prompt = `Classify this email.\n\nFROM: ${from}\nSUBJECT: ${subject}\nBODY: ${body.slice(0, 1000)}\n\nRespond with ONLY valid JSON:\n{\n  "isActionable": true/false (does this require user action?),\n  "category": "meeting_request" | "question" | "update" | "confirmation" | "newsletter" | "spam" | "other",\n  "priority": "high" | "medium" | "low"\n}\n\nNewsletters, automated emails, and spam are NOT actionable.`
  const result = await model.generateContent(prompt)
  const text = result.response.text()
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return { isActionable: false, category: 'other', priority: 'low' }
  return JSON.parse(jsonMatch[0])
}
