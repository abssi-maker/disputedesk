import { ensureBooted, snapshot } from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  await ensureBooted();
  return Response.json(snapshot());
}
