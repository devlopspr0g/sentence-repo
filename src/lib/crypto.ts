import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

function keyBuffer(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error('PROVIDER_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(keyHex, 'hex');
}

/** Encrypt to `ivHex:tagHex:cipherHex` using AES-256-GCM. */
export function encryptSecret(plain: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuffer(keyHex), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data.toString('hex')}`;
}

/** Decrypt a value produced by `encryptSecret`. */
export function decryptSecret(payload: string, keyHex: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(':');
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error('Malformed encrypted secret; expected iv:tag:ciphertext (hex)');
  }
  const decipher = createDecipheriv('aes-256-gcm', keyBuffer(keyHex), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}
