// Direct REST client for the PayPal APIs that @paypal/paypal-server-sdk does not cover
// (Disputes, webhook signature verification).

const base = () =>
  process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

export const paypalConfigured = () =>
  Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

let cached: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const basic = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`,
  ).toString('base64');
  const res = await fetch(`${base()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status}`);
  const json = await res.json();
  cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cached.token;
}

export async function paypalRequest<T = any>(path: string, init?: RequestInit): Promise<T> {
  const token = await accessToken();
  const res = await fetch(`${base()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PayPal ${path} ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Verify a webhook delivery with PayPal's verify-webhook-signature endpoint. */
export async function verifyWebhookSignature(headers: Headers, event: unknown): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId || !paypalConfigured()) return false;
  const result = await paypalRequest<{ verification_status: string }>(
    '/v1/notifications/verify-webhook-signature',
    {
      method: 'POST',
      body: JSON.stringify({
        auth_algo: headers.get('paypal-auth-algo'),
        cert_url: headers.get('paypal-cert-url'),
        transmission_id: headers.get('paypal-transmission-id'),
        transmission_sig: headers.get('paypal-transmission-sig'),
        transmission_time: headers.get('paypal-transmission-time'),
        webhook_id: webhookId,
        webhook_event: event,
      }),
    },
  );
  return result.verification_status === 'SUCCESS';
}
