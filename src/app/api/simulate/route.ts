import { runAgent } from '@/lib/agent';
import { simulatedDispute } from '@/lib/seeds';
import { ensureBooted, logAction, nextSimulatedSequence, planNow, replan, store } from '@/lib/store';
import { ms } from '@/lib/time';

export const dynamic = 'force-dynamic';

/** How long the red board stays up before the agent starts, so the problem is visible first. */
const RED_BOARD_MS = 1500;

/** "Simulate dispute": the same path as a verified webhook, with data labeled as simulated. */
export async function POST() {
  await ensureBooted();
  const s = store();
  if (s.running) return Response.json({ started: false, why: 'a run is already in progress' }, { status: 409 });
  const lateBefore = new Set(s.counters.unplaced);
  const dispute = simulatedDispute(ms(planNow()), nextSimulatedSequence());
  s.disputes.push(dispute);
  await replan();
  // The agent handles the new dispute and any dispute it knocked past its deadline.
  const knockedLate = store().counters.unplaced.filter((id) => id !== dispute.id && !lateBefore.has(id));
  logAction({
    runId: `simulate-${dispute.id}`,
    by: 'system',
    tool: 'simulateDispute',
    args: {},
    disputeId: dispute.id,
    ok: true,
    message: `Simulated dispute ${dispute.id} arrived: $${dispute.amount.toFixed(2)}, ${dispute.reason.toLowerCase()} (not a PayPal event)`,
  });
  setTimeout(() => {
    void runAgent('event', [dispute.id, ...knockedLate]).catch((e) => console.error('[agent] run failed', (e as Error).message));
  }, RED_BOARD_MS);
  return Response.json({ started: true, disputeId: dispute.id });
}
