import { describe, it, expect } from 'vitest'
import { cleanEmailText } from './generate'

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
