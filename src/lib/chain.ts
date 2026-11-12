// Builds and reshapes a dispute's evidence chain: proof -> assemble -> submit.
import { EVIDENCE_SOURCES, type ChainTask, type Dispute, type EvidenceSource } from './types';

export const ASSEMBLE_MIN = 60;
export const SUBMIT_MIN = 30;
export const RESOLVE_MIN = 30;
const MIN_PART_MIN = 15;

const proofFields = (source: EvidenceSource | null) =>
  source
    ? { name: `Proof: ${EVIDENCE_SOURCES[source].label}`, durationMin: EVIDENCE_SOURCES[source].minutes }
    : { name: 'Look for evidence', durationMin: 60 };

export function buildChain(
  d: Pick<Dispute, 'id' | 'merchantId' | 'assignedTo' | 'evidenceSource'>,
  assembleMin = ASSEMBLE_MIN,
): ChainTask[] {
  const base = { disputeId: d.id, merchantId: d.merchantId, workerId: d.assignedTo };
  const proof: ChainTask = { ...base, id: `${d.id}:proof`, kind: 'proof', dependsOn: [], ...proofFields(d.evidenceSource) };
  const assemble: ChainTask = {
    ...base,
    id: `${d.id}:assemble`,
    kind: 'assemble',
    name: 'Assemble evidence',
    durationMin: assembleMin,
    dependsOn: [proof.id],
  };
  const submit: ChainTask = {
    ...base,
    id: `${d.id}:submit`,
    kind: 'submit',
    name: 'Submit to PayPal',
    durationMin: SUBMIT_MIN,
    dependsOn: [assemble.id],
  };
  return [proof, assemble, submit];
}

/** Replace the whole chain with one short block on the agent lane (refund offer or accepted claim). */
export function collapseToResolve(d: Dispute, workerId: string, name: string) {
  d.chain = [
    {
      id: `${d.id}:resolve`,
      disputeId: d.id,
      merchantId: d.merchantId,
      kind: 'resolve',
      name,
      durationMin: RESOLVE_MIN,
      workerId,
      dependsOn: [],
    },
  ];
  d.assignedTo = workerId;
}

export function setEvidenceSource(d: Dispute, source: EvidenceSource) {
  d.evidenceSource = source;
  const proof = d.chain.find((t) => t.kind === 'proof');
  if (proof) Object.assign(proof, proofFields(source));
}

export const assembleParts = (d: Dispute) => d.chain.filter((t) => t.kind === 'assemble');

/** Split the assemble step into equal parts that can run in parallel on different lanes. */
export function splitAssemble(d: Dispute, parts: number): string | null {
  const current = assembleParts(d);
  if (!current.length) return 'this dispute has no evidence block to split';
  const total = current.reduce((sum, t) => sum + t.durationMin, 0);
  const each = Math.ceil(total / parts / 5) * 5;
  if (each < MIN_PART_MIN) return `parts would be shorter than ${MIN_PART_MIN} minutes`;
  const first = current[0];
  const pieces: ChainTask[] = Array.from({ length: parts }, (_, i) => ({
    ...first,
    id: `${d.id}:assemble:${i + 1}`,
    name: `Assemble evidence (${i + 1}/${parts})`,
    durationMin: each,
    pinnedStart: undefined,
    pinnedBy: undefined,
    start: undefined,
    end: undefined,
  }));
  const at = d.chain.indexOf(first);
  d.chain = d.chain.filter((t) => t.kind !== 'assemble');
  d.chain.splice(at, 0, ...pieces);
  const submit = d.chain.find((t) => t.kind === 'submit');
  if (submit) submit.dependsOn = pieces.map((p) => p.id);
  return null;
}
