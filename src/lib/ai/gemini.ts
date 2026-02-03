import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai'
import type { ConversationSummary, ActionType } from '../supabase/types'

let genAI: GoogleGenerativeAI | null = null
let model: GenerativeModel | null = null

/**
 * Get Gemini model instance
 */
function getModel(): GenerativeModel {
  if (!model) {
    const apiKey = process.env.GEMINI_API_KEY

    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not configured')
    }

    genAI = new GoogleGenerativeAI(apiKey)
    model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })
  }

  return model
}

/**
 * Generic prompt function
 */
export async function prompt(text: string): Promise<string> {
  const model = getModel()
  const result = await model.generateContent(text)
  return result.response.text()
}

/**
 * Analyze a conversation and generate a summary
 */
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
  "currentState": "Brief description of where this conversation/deal currently stands",
  "risks": ["Risk 1", "Risk 2"],
  "nextSteps": ["Next step 1", "Next step 2"],
  "keyPoints": ["Key point 1", "Key point 2"]
}

Be concise. Focus on actionable insights.`

  const result = await model.generateContent(prompt)
  const text = result.response.text()

  // Extract JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error('Failed to parse conversation analysis')
  }

  return JSON.parse(jsonMatch[0]) as ConversationSummary
}

/**
 * Determine what action should be proposed for a conversation
 */
export async function proposeAction(
  conversationSummary: ConversationSummary,
  recentMessages: { direction: string; text: string }[],
  cpName: string | null
): Promise<{
  actionType: ActionType
  rationale: string
  draftSubject?: string
  draftBody?: string
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
  "rationale": "One sentence explaining why this action now",
  "draftSubject": "Subject line if actionType is REPLY",
  "draftBody": "Draft email body if actionType is REPLY (keep professional, concise)",
  "urgency": 1-10 (10 = needs immediate attention),
  "dollarValue": estimated deal value in dollars (0 if unknown),
  "painFactor": 1-10 (how much pain from ignoring this)
}

Rules:
- REPLY: User needs to send a response
- SCHEDULE: A meeting needs to be arranged
- WAIT: Ball is in counterparty's court, nothing to do
- FILE: Conversation is closed, archive it`

  const result = await model.generateContent(prompt)
  const text = result.response.text()

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error('Failed to parse action proposal')
  }

  return JSON.parse(jsonMatch[0])
}

/**
 * Generate a draft reply based on context
 */
export async function generateDraftReply(
  conversationContext: string,
  userIntent: string,
  cpName: string | null,
  previousDraft?: string
): Promise<{ subject: string; body: string }> {
  const model = getModel()

  const prompt = `Generate a professional email reply.

CONVERSATION CONTEXT:
${conversationContext}

USER'S INTENT:
${userIntent}

RECIPIENT: ${cpName || 'the counterparty'}

${previousDraft ? `PREVIOUS DRAFT (to improve):\n${previousDraft}\n` : ''}

Respond with ONLY valid JSON:
{
  "subject": "Email subject line",
  "body": "Email body text (no greeting like 'Hi' needed, just the content)"
}

Keep it concise and professional. Match the tone of the conversation.`

  const result = await model.generateContent(prompt)
  const text = result.response.text()

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error('Failed to parse draft reply')
  }

  return JSON.parse(jsonMatch[0])
}

/**
 * Extract topic from a conversation
 */
export async function extractTopic(
  messages: { text: string }[]
): Promise<string> {
  const model = getModel()

  const messageTexts = messages.slice(0, 5).map(m => m.text.slice(0, 300)).join('\n---\n')

  const prompt = `What is the main topic of this email conversation? Respond with ONLY a brief topic (3-7 words).

${messageTexts}`

  const result = await model.generateContent(prompt)
  return result.response.text().trim()
}

/**
 * Determine if a new message belongs to an existing conversation
 */
export async function shouldJoinConversation(
  newMessage: { subject: string; body: string; from: string },
  existingConversation: { topic: string; summary: string; participants: string[] }
): Promise<boolean> {
  const model = getModel()

  const prompt = `Does this new email belong to the existing conversation?

NEW EMAIL:
From: ${newMessage.from}
Subject: ${newMessage.subject}
Body preview: ${newMessage.body.slice(0, 500)}

EXISTING CONVERSATION:
Topic: ${existingConversation.topic}
Summary: ${existingConversation.summary}
Participants: ${existingConversation.participants.join(', ')}

Respond with ONLY "yes" or "no".`

  const result = await model.generateContent(prompt)
  const answer = result.response.text().toLowerCase().trim()

  return answer === 'yes' || answer.includes('yes')
}

/**
 * Generate morning brief headline
 */
export async function generateBriefHeadline(
  todayEvents: { title: string; time: string }[],
  pendingActions: { type: string; cpName: string; urgency: number }[],
  tomorrowHighlights?: string[]
): Promise<string> {
  const model = getModel()

  const eventsText = todayEvents.length > 0
    ? todayEvents.map(e => `${e.time}: ${e.title}`).join('\n')
    : 'No meetings scheduled'

  const actionsText = pendingActions
    .sort((a, b) => b.urgency - a.urgency)
    .slice(0, 5)
    .map(a => `${a.type} for ${a.cpName} (urgency: ${a.urgency})`)
    .join('\n')

  const prompt = `Write a brief, personal executive assistant-style morning briefing headline (2-3 sentences).

TODAY'S SCHEDULE:
${eventsText}

PENDING ACTIONS:
${actionsText}

${tomorrowHighlights ? `TOMORROW: ${tomorrowHighlights.join(', ')}` : ''}

Write as if you're a thoughtful executive assistant giving a quick morning status. Be warm but professional. Focus on what matters most today.`

  const result = await model.generateContent(prompt)
  return result.response.text().trim()
}

/**
 * Classify email intent
 */
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

  const prompt = `Classify this email.

FROM: ${from}
SUBJECT: ${subject}
BODY: ${body.slice(0, 1000)}

Respond with ONLY valid JSON:
{
  "isActionable": true/false (does this require user action?),
  "category": "meeting_request" | "question" | "update" | "confirmation" | "newsletter" | "spam" | "other",
  "priority": "high" | "medium" | "low"
}

Newsletters, automated emails, and spam are NOT actionable.`

  const result = await model.generateContent(prompt)
  const text = result.response.text()

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return { isActionable: false, category: 'other', priority: 'low' }
  }

  return JSON.parse(jsonMatch[0])
}
