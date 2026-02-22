import { describe, it, expect } from 'vitest'
import { cleanEmailText, cleanMessageText } from './generate'

// ─── cleanEmailText (backward-compatible alias) ────────────────────────────

describe('cleanEmailText', () => {
  it('strips quoted reply lines', () => {
    const input = `Hello, how are you?

> On Monday I said something
> And then more
>> Even nested

Let me know.`
    const result = cleanEmailText(input)
    expect(result).toContain('Hello, how are you?')
    expect(result).toContain('Let me know.')
    expect(result).not.toContain('> On Monday')
    expect(result).not.toContain('>> Even nested')
  })

  it('strips "On ... wrote:" preamble', () => {
    const input = `Sure, I agree.

On Mon, Feb 10, 2025 at 9:00 AM Jan Novák <jan@example.com> wrote:
> Original message here`
    const result = cleanEmailText(input)
    expect(result).toContain('Sure, I agree.')
    expect(result).not.toContain('wrote:')
  })

  it('strips Czech "Dne ... napsal:" preamble', () => {
    const input = `Dobrý den,

Dne 10.2.2025 Jan Novák napsal:
> Původní zpráva`
    const result = cleanEmailText(input)
    expect(result).toContain('Dobrý den,')
    expect(result).not.toContain('napsal:')
  })

  it('strips signature after "-- "', () => {
    const input = `Thanks for the info.

--
Jan Novák
CEO, Example Corp
+420 123 456 789`
    const result = cleanEmailText(input)
    expect(result).toContain('Thanks for the info.')
    expect(result).not.toContain('CEO')
    expect(result).not.toContain('+420')
  })

  it('strips signature after em-dash "—"', () => {
    const input = `Sounds good, let's proceed.

—
Mgr. Jana Nováková
Office: Praha 1`
    const result = cleanEmailText(input)
    expect(result).toContain("let's proceed")
    expect(result).not.toContain('Praha 1')
  })

  it('strips "S pozdravem" signature block near the end', () => {
    const input = `Dobrý den, posílám nabídku v příloze. Prosím o vyjádření do pátku.

S pozdravem,
Jan Novák
Makléř
RE/MAX Praha`
    const result = cleanEmailText(input)
    expect(result).toContain('nabídku v příloze')
    expect(result).not.toContain('Makléř')
    expect(result).not.toContain('RE/MAX')
  })

  it('strips "Best regards" signature near the end', () => {
    const input = `Here is the updated proposal for the property at Vinohradská 42.

Best regards,
John Smith
Senior Agent`
    const result = cleanEmailText(input)
    expect(result).toContain('updated proposal')
    expect(result).not.toContain('Senior Agent')
  })

  it('does NOT strip signature-like text in the first half of the message', () => {
    const input = `Best regards to the team from me.

Now, about the deal — we need to finalize terms by Friday.
The buyer has requested a walkthrough on Monday.
Please confirm availability.`
    const result = cleanEmailText(input)
    expect(result).toContain('Best regards to the team')
    expect(result).toContain('finalize terms')
  })

  it('strips unsubscribe lines', () => {
    const input = `Meeting tomorrow at 10.

Click here to unsubscribe from these notifications.`
    const result = cleanEmailText(input)
    expect(result).toContain('Meeting tomorrow')
    expect(result).not.toContain('unsubscribe')
  })

  it('strips HTML img tags (tracking pixels)', () => {
    const input = `Thanks for the update.<img src="https://track.example.com/pixel.gif" width="1" height="1"> See you tomorrow.`
    const result = cleanEmailText(input)
    expect(result).toContain('Thanks for the update.')
    expect(result).toContain('See you tomorrow.')
    expect(result).not.toContain('<img')
  })

  it('collapses multiple blank lines', () => {
    const input = `First line.



Second line.




Third line.`
    const result = cleanEmailText(input)
    expect(result).not.toMatch(/\n{3,}/)
  })

  it('returns empty string trimmed for whitespace-only input', () => {
    expect(cleanEmailText('   \n\n  ')).toBe('')
  })

  it('preserves clean message content', () => {
    const input = `Dobrý den pane Nováku,

ráda bych se zeptala na byt 3+1 na Vinohradské.
Je stále k dispozici? Jaká je cena?

Děkuji za odpověď.`
    const result = cleanEmailText(input)
    // Core content preserved
    expect(result).toContain('byt 3+1 na Vinohradské')
    expect(result).toContain('Je stále k dispozici')
    expect(result).toContain('Jaká je cena')
  })

  it('handles a real-world messy email', () => {
    const input = `Dobrý den,

ano, byt je stále volný. Cena je 8 500 000 Kč.

Dne 15.2.2025 Jana Malá napsal:
> Dobrý den,
> mám zájem o byt na Vinohradské.
> Můžeme si domluvit prohlídku?

S pozdravem,
Jan Novák
RE/MAX Praha
+420 777 888 999
www.remax-praha.cz

Tato zpráva je důvěrná a je určena pouze pro adresáta.`
    const result = cleanEmailText(input)
    expect(result).toContain('byt je stále volný')
    expect(result).toContain('8 500 000 Kč')
    expect(result).not.toContain('> Dobrý den')
    expect(result).not.toContain('RE/MAX')
    expect(result).not.toContain('+420 777')
    expect(result).not.toContain('důvěrná')
  })
})

// ─── cleanMessageText — channel-aware cleaning ─────────────────────────────

describe('cleanMessageText', () => {
  it('defaults to email cleaning when no channel specified', () => {
    const input = `Hello there.

> Quoted text
> More quoted

Best regards,
Jan`
    const result = cleanMessageText(input)
    expect(result).toContain('Hello there.')
    expect(result).not.toContain('> Quoted text')
  })

  it('cleanEmailText is a backward-compatible alias for cleanMessageText(text, "email")', () => {
    const input = `Some content.

> Quoted reply

S pozdravem,
Jan Novák
Company`
    expect(cleanEmailText(input)).toBe(cleanMessageText(input, 'email'))
  })

  // ─── Exchange-specific ──────────────────────────────────────────────────

  it('strips EXTERNAL EMAIL banners (Exchange)', () => {
    const input = `EXTERNAL EMAIL — Do not click suspicious links.

Dobrý den, posílám smlouvu v příloze.`
    const result = cleanMessageText(input, 'email/exchange')
    expect(result).toContain('smlouvu v příloze')
    expect(result).not.toContain('EXTERNAL EMAIL')
  })

  it('strips CAUTION: External banners (Exchange)', () => {
    const input = `CAUTION: External email — verify sender before replying.

Please see attached invoice.`
    const result = cleanMessageText(input, 'email/exchange')
    expect(result).toContain('attached invoice')
    expect(result).not.toContain('CAUTION')
  })

  it('strips Outlook-style From/Sent/To/Subject quoted headers (Exchange)', () => {
    const input = `Yes, I agree with the terms.

From: Jan Novák <jan@example.com>
Sent: Monday, February 10, 2025 9:00 AM
To: User <user@example.com>
Subject: RE: Property deal

Original message content here.`
    const result = cleanMessageText(input, 'email/exchange')
    expect(result).toContain('I agree with the terms')
    expect(result).not.toContain('From: Jan Novák')
    expect(result).not.toContain('Sent: Monday')
  })

  it('strips Outlook-style headers with Cc line (Exchange)', () => {
    const input = `Noted, thanks.

From: Jana Malá <jana@example.com>
Sent: Tuesday, March 3, 2025 2:00 PM
To: User <user@example.com>
Cc: Boss <boss@example.com>
Subject: FW: Contract update`
    const result = cleanMessageText(input, 'email/exchange')
    expect(result).toContain('Noted, thanks')
    expect(result).not.toContain('From: Jana')
    expect(result).not.toContain('Cc: Boss')
  })

  it('strips aka.ms links (Exchange)', () => {
    const input = `Please review the document. Learn more: https://aka.ms/LearnAboutSenderIdentification`
    const result = cleanMessageText(input, 'email/exchange')
    expect(result).toContain('review the document')
    expect(result).not.toContain('aka.ms')
  })

  it('strips "Get Outlook for" app promotion (Exchange)', () => {
    const input = `Sounds good, see you Thursday.

Get Outlook for iOS and Android`
    const result = cleanMessageText(input, 'email/exchange')
    expect(result).toContain('see you Thursday')
    expect(result).not.toContain('Get Outlook')
  })

  it('applies base email cleaning AND Exchange cleaning together', () => {
    const input = `EXTERNAL EMAIL — verify sender.

Dobrý den, byt je k dispozici.

> Původní zpráva od klienta

S pozdravem,
Jan Novák
Makléř

Get Outlook for iOS and Android`
    const result = cleanMessageText(input, 'email/exchange')
    expect(result).toContain('byt je k dispozici')
    expect(result).not.toContain('EXTERNAL EMAIL')
    expect(result).not.toContain('> Původní')
    expect(result).not.toContain('Makléř')
    expect(result).not.toContain('Get Outlook')
  })

  // ─── WhatsApp ───────────────────────────────────────────────────────────

  it('strips WhatsApp encryption system message', () => {
    const input = `Messages and calls are end-to-end encrypted. No one outside of this chat can read them.

Ahoj, jak to vypadá s tou prohlídkou?`
    const result = cleanMessageText(input, 'whatsapp')
    expect(result).toContain('prohlídkou')
    expect(result).not.toContain('end-to-end encrypted')
  })

  it('strips "This message was deleted" system messages (WhatsApp)', () => {
    const input = `This message was deleted.`
    const result = cleanMessageText(input, 'whatsapp')
    expect(result).toBe('')
  })

  it('strips forwarded labels (WhatsApp)', () => {
    const input = `[Forwarded] Check out this property listing on Vinohradská.`
    const result = cleanMessageText(input, 'whatsapp')
    expect(result).toContain('property listing')
    expect(result).not.toMatch(/^\[?Forwarded\]?/)
  })

  it('strips Czech forwarded labels (WhatsApp)', () => {
    const input = `Přeposláno Podívej se na tento byt.`
    const result = cleanMessageText(input, 'whatsapp')
    expect(result).toContain('Podívej se')
    expect(result).not.toContain('Přeposláno')
  })

  it('preserves clean WhatsApp message as-is', () => {
    const input = `Ahoj, zítra v 10 u toho bytu na Vinohradské? Díky!`
    const result = cleanMessageText(input, 'whatsapp')
    expect(result).toBe(input)
  })

  it('does NOT strip email signatures from WhatsApp messages', () => {
    const input = `S pozdravem a díky za info o tom bytě.`
    const result = cleanMessageText(input, 'whatsapp')
    expect(result).toContain('S pozdravem')
  })

  // ─── Unknown channel ───────────────────────────────────────────────────

  it('falls back to email cleaning for unknown channel types', () => {
    const input = `Content here.

> Quoted stuff`
    const result = cleanMessageText(input, 'sms')
    expect(result).toContain('Content here.')
    expect(result).not.toContain('> Quoted')
  })
})
