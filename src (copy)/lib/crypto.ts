import crypto from 'crypto'

/**
 * Derive a 256-bit AES key from NEXTAUTH_SECRET using HKDF.
 * Same secret, deterministic key — no new env vars needed.
 */
function deriveKey(): Buffer {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) {
    throw new Error(
      'NEXTAUTH_SECRET is not set. Cannot encrypt/decrypt OAuth tokens.'
    )
  }

  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      secret,
      'mila-oauth-salt',
      'mila-oauth-tokens',
      32
    )
  )
}

/**
 * Encrypt a tokens object using AES-256-GCM.
 *
 * Output format (base64-encoded):
 *   [ IV (12 bytes) | authTag (16 bytes) | ciphertext (variable) ]
 *
 * The authTag provides tamper detection — any modification to the
 * ciphertext or IV will cause decryption to fail.
 */
export function encryptTokens(tokens: object): string {
  const key = deriveKey()
  const iv = crypto.randomBytes(12)

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const plaintext = JSON.stringify(tokens)

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])

  const authTag = cipher.getAuthTag()

  // Pack: IV + authTag + ciphertext
  const packed = Buffer.concat([iv, authTag, encrypted])
  return packed.toString('base64')
}

/**
 * Decrypt a base64 string back into a tokens object using AES-256-GCM.
 *
 * Expects the format produced by encryptTokens:
 *   [ IV (12 bytes) | authTag (16 bytes) | ciphertext (variable) ]
 */
export function decryptTokens(encrypted: string): object {
  const key = deriveKey()
  const packed = Buffer.from(encrypted, 'base64')

  if (packed.length < 28) {
    throw new Error('Encrypted token data is too short (corrupted?)')
  }

  const iv = packed.subarray(0, 12)
  const authTag = packed.subarray(12, 28)
  const ciphertext = packed.subarray(28)

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ])

  return JSON.parse(decrypted.toString('utf8'))
}
