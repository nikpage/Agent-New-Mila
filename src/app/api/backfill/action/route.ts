import { NextRequest } from 'next/server'
import { validateBackfillToken } from '@/lib/auth/tokens'
import { findOrCreateCP, blacklistCP } from '@/lib/db/counterparties'
import { generateActionsForConversations } from '@/services/planning'
import { theme } from '@/config/theme'

/**
 * Backfill report action handler.
 * Handles signed links from the backfill report email:
 *   - allow:     Create a CP from a previously-filtered sender email
 *   - blacklist: Blacklist an existing CP
 *   - add:       Generate action proposals for a conversation (enter Mila process)
 *
 * All links are GET so they work as <a href="..."> in email.
 * Token provides authentication + CSRF protection.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const uid = searchParams.get('uid')
  const op = searchParams.get('op')
  const target = searchParams.get('target')
  const sig = searchParams.get('sig')

  if (!uid || !op || !target || !sig) {
    return htmlResponse('Chybějící parametry', 'Odkaz je neplatný.', 400)
  }

  if (!validateBackfillToken(sig, uid, op, target)) {
    return htmlResponse('Neplatný odkaz', 'Odkaz vypršel nebo je neplatný.', 401)
  }

  try {
    switch (op) {
      case 'allow': {
        const email = decodeURIComponent(target)
        const cp = await findOrCreateCP(uid, email)
        if (!cp) {
          return htmlResponse('Chyba', 'Nepodařilo se vytvořit kontakt.', 500)
        }
        return htmlResponse(
          'Kontakt povolen',
          `<strong>${email}</strong> byl přidán mezi vaše kontakty. Příští ingestion zpracuje jejich emaily.`
        )
      }

      case 'blacklist': {
        await blacklistCP(target)
        return htmlResponse(
          'Kontakt zablokován',
          'Budoucí emaily od tohoto kontaktu budou ignorovány.'
        )
      }

      case 'add': {
        const actions = await generateActionsForConversations([target])
        const count = actions.length
        return htmlResponse(
          'Přidáno do Mila',
          `Konverzace byla přidána do procesu Mila. Vytvořeno ${count} akčních návrhů — uvidíte je v příštím briefu.`
        )
      }

      default:
        return htmlResponse('Neznámá akce', `Operace "${op}" není podporována.`, 400)
    }
  } catch (error) {
    console.error(`[Backfill Action] ${op} failed for uid=${uid}:`, error)
    return htmlResponse('Chyba', 'Akce se nezdařila. Zkuste to prosím znovu.', 500)
  }
}

function htmlResponse(title: string, message: string, status: number = 200): Response {
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${title} — Mila</title></head>
<body style="margin:0;padding:0;background-color:${theme.colors.background};font-family:'Inter',system-ui,sans-serif;color:${theme.colors.text};">
  <div style="max-width:480px;margin:60px auto;padding:40px;background:${theme.colors.surface};border-radius:12px;border:1px solid ${theme.colors.border};box-shadow:${theme.shadows.card};text-align:center;">
    <h1 style="font-size:22px;margin-bottom:12px;">${title}</h1>
    <p style="font-size:16px;color:${theme.colors.textMuted};line-height:1.5;">${message}</p>
    <p style="margin-top:24px;font-size:14px;color:${theme.colors.textMuted};">— Mila</p>
  </div>
</body>
</html>`

  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
