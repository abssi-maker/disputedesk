import { setPolicy, snapshot } from '@/lib/store';

export const dynamic = 'force-dynamic';

const amount = (v: unknown) => (typeof v === 'number' && v >= 0 && v <= 100_000 ? v : undefined);

/** Guardrail panel: change the auto-resolve and never-concede limits. */
export async function POST(req: Request) {
  const body = await req.json();
  const autoResolveLimitUsd = amount(body.autoResolveLimitUsd);
  const neverConcedeAboveUsd = amount(body.neverConcedeAboveUsd);
  setPolicy({
    ...(autoResolveLimitUsd !== undefined ? { autoResolveLimitUsd } : {}),
    ...(neverConcedeAboveUsd !== undefined ? { neverConcedeAboveUsd } : {}),
  });
  return Response.json(snapshot().policy);
}
