import { NextRequest } from 'next/server'
import { validateBackfillToken } from '@/lib/auth/tokens'
import { findOrCreateCP, blacklistCP, updateCP, getCPById } from '@/lib/db/counterparties'
import { generateActionsForConversations } from '@/services/planning'
import { getSupabaseAdmin } from '@/lib/supabase/client'
import { VALID_CP_ROLES } from '@/lib/supabase/types'
import { theme } from '@/config/theme'

/**
 * Backfill report action handler.
 * Handles signed links from the backfill report email:
 *   - allow:     Create a CP from a previously-filtered sender email
 *   - blacklist: Blacklist an existing CP (also used for "stop following")
 *   - add:       Generate action proposals for a conversation (enter Mila process)
 *   - setrole:   Set a counterparty's role (target format: cpId:role)
 *
 * All links are GET so they work as <a href="..."> in email.
 * Token provides authentication + CSRF protection.
 * Operations are idempotent — re-clicking shows "already done" state.
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
        // target is already decoded by searchParams.get()
        const cp = await findOrCreateCP(uid, target)
        if (!cp) {
          return htmlResponse('Chyba', 'Nepodařilo se vytvořit kontakt.', 500)
        }
        return htmlResponse(
          'Kontakt povolen',
          `<strong>${escapeHtml(target)}</strong> byl přidán mezi vaše kontakty. Příští ingestion zpracuje jejich emaily.`
        )
      }

      case 'blacklist': {
        // Idempotent — check if already blacklisted
        const cp = await getCPById(target)
        if (cp?.is_blacklisted) {
          return htmlResponse('Kontakt již zablokován', 'Tento kontakt je již zablokovaný.')
        }
        await blacklistCP(target)
        return htmlResponse(
          'Kontakt zablokován',
          'Budoucí emaily od tohoto kontaktu budou ignorovány.'
        )
      }

      case 'add': {
        // Idempotent — check if actions already exist for this conversation
        const supabase = getSupabaseAdmin()
        const { data: existing } = await supabase
          .from('action_proposals')
          .select('id')
          .eq('conversation_id', target)
          .limit(1)

        if (existing && existing.length > 0) {
          return htmlResponse(
            'Již přidáno do Mila',
            'Tato konverzace již byla přidána do procesu Mila. Uvidíte ji v příštím briefu.'
          )
        }

        const actions = await generateActionsForConversations([target])
        const count = actions.length
        return htmlResponse(
          'Přidáno do Mila',
          `Konverzace byla přidána do procesu Mila. Vytvořeno ${count} akčních návrhů — uvidíte je v příštím briefu.`
        )
      }

      case 'setrole': {
        // target format: cpId:role
        const colonIdx = target.indexOf(':')
        if (colonIdx === -1) {
          return htmlResponse('Chybějící parametry', 'Odkaz je neplatný.', 400)
        }
        const cpId = target.slice(0, colonIdx)
        const role = target.slice(colonIdx + 1)

        if (!(VALID_CP_ROLES as readonly string[]).includes(role)) {
          return htmlResponse('Neznámá role', `Role "${escapeHtml(role)}" není platná.`, 400)
        }

        // Idempotent — check if role already set
        const existingCP = await getCPById(cpId)
        if (existingCP?.role === role) {
          const ROLE_LABELS: Record<string, string> = {
            buyer: 'kupující', seller: 'prodávající', landlord: 'pronajímatel',
            tenant: 'nájemce', agent: 'makléř', developer: 'developer', other: 'jiný',
          }
          return htmlResponse(
            'Role již nastavena',
            `Kontakt <strong>${escapeHtml(existingCP.name || existingCP.primary_identifier)}</strong> má již roli <strong>${ROLE_LABELS[role] || role}</strong>.`
          )
        }

        await updateCP(cpId, { role })
        const updatedCP = await getCPById(cpId)
        const ROLE_LABELS: Record<string, string> = {
          buyer: 'kupující', seller: 'prodávající', landlord: 'pronajímatel',
          tenant: 'nájemce', agent: 'makléř', developer: 'developer', other: 'jiný',
        }
        return htmlResponse(
          'Role nastavena',
          `Kontakt <strong>${escapeHtml(updatedCP?.name || updatedCP?.primary_identifier || cpId)}</strong> má nyní roli <strong>${ROLE_LABELS[role] || role}</strong>.`
        )
      }

      default:
        return htmlResponse('Neznámá akce', `Operace "${escapeHtml(op)}" není podporována.`, 400)
    }
  } catch (error) {
    console.error(`[Backfill Action] ${op} failed for uid=${uid}:`, error)
    return htmlResponse('Chyba', 'Akce se nezdařila. Zkuste to prosím znovu.', 500)
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Build a themed HTML confirmation page.
 * Success pages (status 200) get: checkmark icon, auto-close countdown, close button.
 * Error pages get: static error display, no auto-close.
 */
function htmlResponse(title: string, message: string, status: number = 200): Response {
  const isSuccess = status === 200

  const icon = isSuccess
    ? `<div style="width:72px;height:72px;background-color:${theme.colors.successBg};border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px auto;">
        <svg width="36" height="36" fill="none" stroke="${theme.colors.success}" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
        </svg>
      </div>`
    : `<div style="width:72px;height:72px;background-color:${theme.colors.errorBg};border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px auto;">
        <svg width="36" height="36" fill="none" stroke="${theme.colors.error}" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </div>`

  const autoCloseScript = isSuccess ? `
    <p id="countdown" style="font-size:13px;color:${theme.colors.textMuted};margin-top:20px;">
      Toto okno se zavře za <span id="secs">5</span> s
    </p>
    <button onclick="tryClose()" style="margin-top:12px;padding:8px 24px;background:${theme.colors.secondary};color:${theme.colors.text};border:1px solid ${theme.colors.border};border-radius:6px;font-size:14px;cursor:pointer;font-family:inherit;">
      Zavřít
    </button>
    <script>
      var secs = 5;
      var el = document.getElementById('secs');
      var timer = setInterval(function() {
        secs--;
        if (el) el.textContent = secs;
        if (secs <= 0) { clearInterval(timer); tryClose(); }
      }, 1000);
      function tryClose() {
        try { window.close(); } catch(e) {}
        document.getElementById('countdown').textContent = 'Hotovo — můžete zavřít tuto záložku.';
      }
    </script>` : ''

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${title} — Mila</title></head>
<body style="margin:0;padding:0;background-color:${theme.colors.background};font-family:'Inter',system-ui,sans-serif;color:${theme.colors.text};">
  <div style="max-width:480px;margin:60px auto;padding:40px;background:${theme.colors.surface};border-radius:12px;border:1px solid ${theme.colors.border};box-shadow:${theme.shadows.card};text-align:center;">
    ${icon}
    <h1 style="font-size:22px;margin:0 0 12px 0;">${title}</h1>
    <p style="font-size:16px;color:${theme.colors.textMuted};line-height:1.5;margin:0;">${message}</p>
    ${autoCloseScript}
    <p style="margin-top:24px;font-size:14px;color:${theme.colors.textMuted};">— Mila</p>
  </div>
</body>
</html>`

  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
