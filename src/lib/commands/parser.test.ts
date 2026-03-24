import { describe, it, expect } from 'vitest'
import { isMilaCommand, classifyCommand, CommandParseError } from './parser'

describe('isMilaCommand', () => {
  it('detects "Mila: new contact"', () => {
    expect(isMilaCommand('Mila: new contact')).toBe(true)
  })

  it('detects without space after colon', () => {
    expect(isMilaCommand('mila:todo')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isMilaCommand('MILA: KONTAKT')).toBe(true)
  })

  it('handles leading whitespace', () => {
    expect(isMilaCommand('  Mila: todo')).toBe(true)
  })

  it('rejects "Re: Mila: ..." (not at start)', () => {
    expect(isMilaCommand('Re: Mila: todo')).toBe(false)
  })

  it('rejects "Meeting with Mila"', () => {
    expect(isMilaCommand('Meeting with Mila')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isMilaCommand('')).toBe(false)
  })

  it('rejects Fwd: Mila:', () => {
    expect(isMilaCommand('Fwd: Mila: contact')).toBe(false)
  })
})

describe('classifyCommand', () => {
  describe('new_contact', () => {
    it('classifies "Mila: new contact"', () => {
      const result = classifyCommand('Mila: new contact', 'Jan Novotný')
      expect(result.type).toBe('new_contact')
      expect(result.body).toBe('Jan Novotný')
    })

    it('classifies "Mila: contact"', () => {
      const result = classifyCommand('Mila: contact', 'Jan')
      expect(result.type).toBe('new_contact')
    })

    it('classifies "Mila: kontakt"', () => {
      const result = classifyCommand('mila: kontakt', 'Jan')
      expect(result.type).toBe('new_contact')
    })

    it('classifies "Mila: nový kontakt"', () => {
      const result = classifyCommand('Mila: nový kontakt', 'Jan')
      expect(result.type).toBe('new_contact')
    })
  })

  describe('todo', () => {
    it('classifies "Mila: todo"', () => {
      const result = classifyCommand('Mila: todo', 'Call the notary')
      expect(result.type).toBe('todo')
      expect(result.body).toBe('Call the notary')
    })

    it('classifies "Mila: task"', () => {
      const result = classifyCommand('Mila: task', 'Follow up')
      expect(result.type).toBe('todo')
    })

    it('classifies "Mila: úkol"', () => {
      const result = classifyCommand('Mila: úkol', 'Zavolat notáři')
      expect(result.type).toBe('todo')
    })

    it('classifies "Mila: ukol"', () => {
      const result = classifyCommand('mila: ukol', 'Test')
      expect(result.type).toBe('todo')
    })

    it('allows extra text after command keyword in subject', () => {
      const result = classifyCommand('Mila: todo call the notary', 'about the deal')
      expect(result.type).toBe('todo')
      expect(result.body).toBe('about the deal')
    })
  })

  describe('errors', () => {
    it('throws CommandParseError for unknown command', () => {
      expect(() => classifyCommand('Mila: dance', 'body')).toThrow(CommandParseError)
    })

    it('throws CommandParseError for empty body', () => {
      expect(() => classifyCommand('Mila: todo', '')).toThrow(CommandParseError)
    })

    it('throws CommandParseError for whitespace-only body', () => {
      expect(() => classifyCommand('Mila: todo', '   ')).toThrow(CommandParseError)
    })

    it('error message contains the unrecognized command', () => {
      try {
        classifyCommand('Mila: dance', 'body')
        expect.fail('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(CommandParseError)
        expect((e as CommandParseError).userMessage).toContain('dance')
      }
    })
  })

  it('preserves original subject in result', () => {
    const result = classifyCommand('  Mila: TODO  ', 'task body')
    expect(result.subject).toBe('Mila: TODO')
  })
})
