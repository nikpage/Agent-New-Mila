import { NextRequest, NextResponse } from 'next/server'
import { classifyCommand, isMilaCommand, CommandParseError } from '@/lib/commands/parser'
import { executeCommand } from '@/lib/commands/executor'
import { validateTriggerToken } from '@/lib/auth/tokens'
import { getUserSettings } from '@/lib/db/users'

/**
 * POST /api/commands — Execute a Mila command from the brief page.
 * Auth: trigger token (same as brief page access).
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { token, userId, command } = body as {
      token: string
      userId: string
      command: string
    }

    if (!token || !userId) {
      return NextResponse.json({ error: 'Missing token or userId' }, { status: 401 })
    }

    if (!validateTriggerToken(token, userId)) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    if (!command || typeof command !== 'string' || !command.trim()) {
      return NextResponse.json({ error: 'Empty command' }, { status: 400 })
    }

    // Wrap the command with "Mila:" prefix if not already present
    const commandText = command.trim()
    const subject = commandText.toLowerCase().startsWith('mila:')
      ? commandText
      : `Mila: ${commandText}`

    // Check if it's a valid Mila command
    if (!isMilaCommand(subject)) {
      return NextResponse.json({
        success: false,
        message: 'Nerozumím příkazu. Zkuste: "todo [úkol]" nebo "kontakt [jméno]"',
      })
    }

    // Classify the command
    const classified = await classifyCommand(subject, '')
    const settings = await getUserSettings(userId)
    const result = await executeCommand(classified, userId, settings)

    return NextResponse.json({
      success: result.success,
      message: result.summary,
      commandType: result.commandType,
    })
  } catch (error) {
    if (error instanceof CommandParseError) {
      return NextResponse.json({
        success: false,
        message: error.userMessage,
      })
    }
    console.error('[Commands:POST]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 }
    )
  }
}
