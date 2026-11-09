import { HttpError } from './errors';

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/**
 * Validate a user-supplied provider base URL. The server will call it, so it must
 * be https and must not point at loopback, private or internal hosts (SSRF guard).
 * Note: this checks the hostname text only; it does not defend against DNS rebinding.
 */
export function assertSafeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'base_url is not a valid URL', 'invalid_request_error', 'invalid_base_url');
  }
  const host = url.hostname.toLowerCase();
  const unsafe =
    url.protocol !== 'https:' ||
    Boolean(url.username) ||
    Boolean(url.password) ||
    host.startsWith('[') ||
    host.includes(':') ||
    !host.includes('.') ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    PRIVATE_V4.some((re) => re.test(host));
  if (unsafe) {
    throw new HttpError(
      400,
      'base_url must be a public https URL (no localhost, private IPs or credentials)',
      'invalid_request_error',
      'invalid_base_url',
    );
  }
  return url.toString().replace(/\/$/, '');
}
