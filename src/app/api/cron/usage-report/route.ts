import { NextRequest, NextResponse } from 'next/server'
import { validateCronToken } from '@/lib/auth/tokens'
import { getUsageByUserAndModel, getCumulativeUsage } from '@/lib/db/ai-usage'
import { getUserById } from '@/lib/db/users'
import { sendEmail } from '@/lib/google/gmail'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const REPORT_RECIPIENT = 'ai@nik.page'
// Send from this user's Gmail account
const SENDER_USER_ID = '9e59bc06-7276-453d-bc2e-f224a0a327e3'

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization')
    const token = authHeader?.replace('Bearer ', '')

    if (!validateCronToken(token)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    console.log(`\n[UsageReport] ========== Generating usage report ==========`)

    // Period: yesterday (daily for now, will switch to monthly)
    const now = new Date()
    const periodEnd = new Date(now)
    periodEnd.setUTCHours(0, 0, 0, 0)
    const periodStart = new Date(periodEnd)
    periodStart.setUTCDate(periodStart.getUTCDate() - 1)

    const periodLabel = periodStart.toISOString().slice(0, 10)

    // Fetch period usage + cumulative
    const [periodUsage, cumulativeUsage] = await Promise.all([
      getUsageByUserAndModel(periodStart.toISOString(), periodEnd.toISOString()),
      getCumulativeUsage(),
    ])

    // Resolve user names
    const userIds = [...new Set(periodUsage.map(r => r.user_id))]
    const users = await Promise.all(userIds.map(id => getUserById(id)))
    const userNames = new Map<string, string>()
    for (const u of users) {
      if (u) userNames.set(u.id, u.public_name || u.mila_name || u.email || u.id.slice(0, 8))
    }

    // Build email
    const { subject, html, text } = buildReport(periodLabel, periodUsage, cumulativeUsage, userNames)

    await sendEmail(SENDER_USER_ID, {
      to: REPORT_RECIPIENT,
      subject,
      body: text,
      htmlBody: html,
    })

    console.log(`[UsageReport] Sent to ${REPORT_RECIPIENT}`)
    console.log(`[UsageReport] ========== Done ==========\n`)

    return NextResponse.json({ success: true, period: periodLabel, rows: periodUsage.length })
  } catch (error) {
    console.error('[UsageReport] Error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

interface UsageRow {
  user_id?: string
  model: string
  total_calls: number
  total_input_tokens: number
  total_output_tokens: number
  total_cost_usd: number
}

function buildReport(
  periodLabel: string,
  periodUsage: (UsageRow & { user_id: string })[],
  cumulativeUsage: UsageRow[],
  userNames: Map<string, string>
): { subject: string; html: string; text: string } {
  const subject = `Mila AI Usage — ${periodLabel}`

  const fmt$ = (n: number) => `$${n.toFixed(4)}`
  const fmtK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

  // Period totals
  const periodTotal = periodUsage.reduce((acc, r) => ({
    calls: acc.calls + r.total_calls,
    input: acc.input + r.total_input_tokens,
    output: acc.output + r.total_output_tokens,
    cost: acc.cost + r.total_cost_usd,
  }), { calls: 0, input: 0, output: 0, cost: 0 })

  // Cumulative totals
  const cumTotal = cumulativeUsage.reduce((acc, r) => ({
    calls: acc.calls + r.total_calls,
    input: acc.input + r.total_input_tokens,
    output: acc.output + r.total_output_tokens,
    cost: acc.cost + r.total_cost_usd,
  }), { calls: 0, input: 0, output: 0, cost: 0 })

  // --- Plain text ---
  const textLines: string[] = [
    `Mila AI Usage Report — ${periodLabel}`,
    '',
    `Period total: ${periodTotal.calls} calls, ${fmtK(periodTotal.input)} in / ${fmtK(periodTotal.output)} out, ${fmt$(periodTotal.cost)}`,
    '',
  ]

  if (periodUsage.length > 0) {
    textLines.push('Per user per model:')
    for (const r of periodUsage.sort((a, b) => b.total_cost_usd - a.total_cost_usd)) {
      const name = userNames.get(r.user_id) ?? r.user_id.slice(0, 8)
      textLines.push(`  ${name} | ${r.model} | ${r.total_calls} calls | ${fmtK(r.total_input_tokens)} in / ${fmtK(r.total_output_tokens)} out | ${fmt$(r.total_cost_usd)}`)
    }
  } else {
    textLines.push('No usage recorded for this period.')
  }

  textLines.push('')
  textLines.push('--- Cumulative (all time) ---')
  textLines.push(`Total: ${cumTotal.calls} calls, ${fmtK(cumTotal.input)} in / ${fmtK(cumTotal.output)} out, ${fmt$(cumTotal.cost)}`)
  for (const r of cumulativeUsage.sort((a, b) => b.total_cost_usd - a.total_cost_usd)) {
    textLines.push(`  ${r.model} | ${r.total_calls} calls | ${fmtK(r.total_input_tokens)} in / ${fmtK(r.total_output_tokens)} out | ${fmt$(r.total_cost_usd)}`)
  }

  const text = textLines.join('\n')

  // --- HTML ---
  const tableStyle = 'border-collapse:collapse;width:100%;font-family:monospace;font-size:13px;'
  const thStyle = 'text-align:left;padding:6px 10px;border-bottom:2px solid #333;background:#f5f5f5;'
  const tdStyle = 'padding:6px 10px;border-bottom:1px solid #ddd;'
  const tdRight = `${tdStyle}text-align:right;`

  const renderTable = (rows: { label: string; model: string; calls: number; tokIn: number; tokOut: number; cost: number }[]) => {
    const total = rows.reduce((a, r) => ({ calls: a.calls + r.calls, tokIn: a.tokIn + r.tokIn, tokOut: a.tokOut + r.tokOut, cost: a.cost + r.cost }), { calls: 0, tokIn: 0, tokOut: 0, cost: 0 })
    return `<table style="${tableStyle}">
      <tr><th style="${thStyle}">User</th><th style="${thStyle}">Model</th><th style="${thStyle}text-align:right;">Calls</th><th style="${thStyle}text-align:right;">Tok In</th><th style="${thStyle}text-align:right;">Tok Out</th><th style="${thStyle}text-align:right;">Cost</th></tr>
      ${rows.map(r => `<tr><td style="${tdStyle}">${r.label}</td><td style="${tdStyle}">${r.model}</td><td style="${tdRight}">${r.calls}</td><td style="${tdRight}">${fmtK(r.tokIn)}</td><td style="${tdRight}">${fmtK(r.tokOut)}</td><td style="${tdRight}">${fmt$(r.cost)}</td></tr>`).join('\n')}
      <tr style="font-weight:bold;border-top:2px solid #333;"><td style="${tdStyle}">TOTAL</td><td style="${tdStyle}"></td><td style="${tdRight}">${total.calls}</td><td style="${tdRight}">${fmtK(total.tokIn)}</td><td style="${tdRight}">${fmtK(total.tokOut)}</td><td style="${tdRight}">${fmt$(total.cost)}</td></tr>
    </table>`
  }

  const periodRows = periodUsage
    .sort((a, b) => b.total_cost_usd - a.total_cost_usd)
    .map(r => ({
      label: userNames.get(r.user_id) ?? r.user_id.slice(0, 8),
      model: r.model,
      calls: r.total_calls,
      tokIn: r.total_input_tokens,
      tokOut: r.total_output_tokens,
      cost: r.total_cost_usd,
    }))

  const cumRows = cumulativeUsage
    .sort((a, b) => b.total_cost_usd - a.total_cost_usd)
    .map(r => ({
      label: '',
      model: r.model,
      calls: r.total_calls,
      tokIn: r.total_input_tokens,
      tokOut: r.total_output_tokens,
      cost: r.total_cost_usd,
    }))

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;max-width:700px;margin:0 auto;padding:20px;">
<h2 style="margin-bottom:4px;">Mila AI Usage — ${periodLabel}</h2>
<p style="color:#666;margin-top:0;">Period: ${periodLabel} | Total: ${fmt$(periodTotal.cost)}</p>

<h3>Daily breakdown</h3>
${periodRows.length > 0 ? renderTable(periodRows) : '<p style="color:#999;">No usage recorded.</p>'}

<h3 style="margin-top:30px;">Cumulative (all time)</h3>
<p style="color:#666;margin-top:0;">Total: ${fmt$(cumTotal.cost)}</p>
${cumRows.length > 0 ? renderTable(cumRows) : '<p style="color:#999;">No data.</p>'}

<p style="color:#999;font-size:11px;margin-top:30px;">Generated by Mila • ${new Date().toISOString()}</p>
</body></html>`

  return { subject, html, text }
}
