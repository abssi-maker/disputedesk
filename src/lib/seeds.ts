// Seeded and simulated disputes. Everything here is tagged source 'seed' or 'simulated' and is
// shown with that badge in the UI; none of it is PayPal data.
import { buildChain } from './chain';
import { addWorkingMinutes, wall } from './time';
import type { Dispute, EvidenceSource, Worker } from './types';

export const MERCHANT_ID = 'merchant-1';

export const WORKERS: Worker[] = [
  { id: 'owner', merchantId: MERCHANT_ID, name: 'You', role: 'Owner', kind: 'human' },
  { id: 'maya', merchantId: MERCHANT_ID, name: 'Maya', role: 'Assistant', kind: 'human' },
  { id: 'auto', merchantId: MERCHANT_ID, name: 'Auto-resolver', role: 'Agent lane', kind: 'agent' },
];

interface Template {
  id: string;
  buyer: string;
  item: string;
  amount: number;
  reason: string;
  facts: string[];
  /** Working hours from "now" until the response deadline. */
  deadlineInHours: number;
  evidenceReadiness: number;
  evidenceSource: EvidenceSource | null;
  evidenceAvailable: EvidenceSource[];
  assembleMin?: number;
  assignedTo?: string;
}

const SEEDS: Template[] = [
  {
    id: 'D-4821',
    buyer: 'Jordan Reyes',
    item: 'Used 35mm film camera',
    amount: 289,
    reason: 'Item not received',
    facts: ['Carrier shows delivered 3 days ago', 'Signature on file with carrier', 'Driver delivery photo available'],
    deadlineInHours: 5,
    evidenceReadiness: 0.6,
    evidenceSource: 'signature',
    evidenceAvailable: ['signature', 'delivery_photo', 'tracking'],
  },
  {
    id: 'D-4830',
    buyer: 'Priya Natarajan',
    item: 'Leather camera strap',
    amount: 64.5,
    reason: 'Item not as described',
    facts: ['Buyer says colour differs from listing', 'Listing photos show the same leather colour', 'Buyer chat confirms correct item'],
    deadlineInHours: 12,
    assignedTo: 'maya',
    evidenceReadiness: 0.7,
    evidenceSource: 'listing_photos',
    evidenceAvailable: ['listing_photos', 'chat_log'],
  },
  {
    id: 'D-4833',
    buyer: 'Marcus Bell',
    item: '52mm UV lens filter',
    amount: 18.99,
    reason: 'Item not received',
    facts: ['Sent by untracked letter post', 'No delivery confirmation exists'],
    deadlineInHours: 2,
    evidenceReadiness: 0.1,
    evidenceSource: null,
    evidenceAvailable: [],
  },
  {
    id: 'D-4840',
    buyer: 'Elena Kovacs',
    item: 'Used mirrorless camera body',
    amount: 412,
    reason: 'Unauthorized transaction',
    facts: ['Shipped to the address on the PayPal account', 'Tracking shows delivered', 'Carrier signature can be requested'],
    deadlineInHours: 10,
    evidenceReadiness: 0.5,
    evidenceSource: 'signature',
    evidenceAvailable: ['signature', 'tracking'],
  },
  {
    id: 'D-4847',
    buyer: 'Tom Okafor',
    item: 'Lens hood and cap set',
    amount: 32,
    reason: 'Item not as described',
    facts: ['Buyer sent a photo of a cracked lens hood', 'Chat log shows seller acknowledged the crack'],
    deadlineInHours: 14,
    assignedTo: 'maya',
    evidenceReadiness: 0.2,
    evidenceSource: 'chat_log',
    evidenceAvailable: ['chat_log'],
  },
  {
    id: 'D-4852',
    buyer: 'Sofia Marin',
    item: 'Carbon fibre travel tripod',
    amount: 149,
    reason: 'Item not received',
    facts: ['Tracking shows delivered to parcel locker', 'Carrier signature can be requested'],
    deadlineInHours: 18,
    assignedTo: 'maya',
    evidenceReadiness: 0.5,
    evidenceSource: 'signature',
    evidenceAvailable: ['signature', 'tracking'],
  },
  {
    id: 'D-4858',
    buyer: 'Liam Chen',
    item: 'Speedlight flash',
    amount: 95,
    reason: 'Credit not processed',
    facts: ['Buyer returned the item', 'Chat log shows the refund was issued 6 days ago'],
    deadlineInHours: 22,
    evidenceReadiness: 0.8,
    evidenceSource: 'chat_log',
    evidenceAvailable: ['chat_log'],
  },
];

/** The fixed event behind the "Simulate dispute" button. */
const SIMULATED: Template = {
  id: 'SIM',
  buyer: 'Avery Collins',
  item: '85mm camera lens',
  amount: 640,
  reason: 'Item not received',
  facts: ['Carrier shows delivered yesterday', 'Carrier signature takes about 4 hours to obtain', 'Driver delivery photo is already in the carrier portal'],
  deadlineInHours: 3,
  evidenceReadiness: 0.4,
  evidenceSource: 'signature',
  evidenceAvailable: ['signature', 'delivery_photo'],
  assembleMin: 120,
};

function fromTemplate(t: Template, now: number, source: Dispute['source'], id = t.id): Dispute {
  const base = {
    id,
    merchantId: MERCHANT_ID,
    assignedTo: t.assignedTo ?? 'owner',
    evidenceSource: t.evidenceSource,
  };
  return {
    ...base,
    buyer: t.buyer,
    item: t.item,
    amount: t.amount,
    currency: 'USD',
    reason: t.reason,
    facts: t.facts,
    deadline: wall(addWorkingMinutes(now, t.deadlineInHours * 60)),
    evidenceReadiness: t.evidenceReadiness,
    evidenceAvailable: t.evidenceAvailable,
    source,
    status: 'open',
    autoResolved: false,
    chain: buildChain(base, t.assembleMin),
    state: 'safe',
  };
}

export const seedDisputes = (now: number): Dispute[] => SEEDS.map((t) => fromTemplate(t, now, 'seed'));

export const simulatedDispute = (now: number, sequence: number): Dispute =>
  fromTemplate(SIMULATED, now, 'simulated', `SIM-${sequence}`);
