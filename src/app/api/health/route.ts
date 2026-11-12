import { paypalConfigured } from '@/lib/paypal-rest';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({
    ok: true,
    paypal: paypalConfigured() ? 'configured' : 'missing',
    gemini: process.env.GEMINI_API_KEY ? 'configured' : 'missing',
  });
}
