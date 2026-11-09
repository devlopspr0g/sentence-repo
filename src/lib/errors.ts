/** Error carrying an HTTP status and an OpenAI-style error payload. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly type: string = 'api_error',
    public readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  toJSON(): { error: { message: string; type: string; code: string | null } } {
    return { error: { message: this.message, type: this.type, code: this.code } };
  }
}

/** Convert a failed upstream provider response into an HttpError. */
export async function upstreamError(provider: string, res: Response): Promise<HttpError> {
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 500);
  } catch {
    detail = '';
  }
  const status = res.status >= 500 ? 502 : res.status;
  return new HttpError(
    status,
    `Upstream provider "${provider}" returned ${res.status}${detail ? `: ${detail}` : ''}`,
    status === 429 ? 'rate_limit_error' : 'upstream_error',
    `upstream_${res.status}`,
  );
}
