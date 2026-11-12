import { describe, expect, it } from 'vitest';
import { buildChain, splitAssemble } from './chain';
import { computeCounters, planDisputes, priority } from './planner';
import { ms, addWorkingMinutes, workingMinutesBetween } from './time';
import type { Dispute } from './types';

const NOW = '2026-11-12T09:00';

function dispute(id: string, amount: number, deadline: string, over: Partial<Dispute> = {}): Dispute {
  const base = { id, merchantId: 'm', assignedTo: 'owner', evidenceSource: 'tracking' as const };
  return {
    ...base,
    buyer: 'B',
    item: 'I',
    amount,
    currency: 'USD',
    reason: 'Item not received',
    facts: [],
    deadline,
    evidenceReadiness: 0.5,
    evidenceAvailable: ['tracking'],
    source: 'seed',
    status: 'open',
    autoResolved: false,
    chain: buildChain(base), // 45 + 60 + 30 = 2h15
    state: 'safe',
    ...over,
  };
}

const byId = (ds: Dispute[], id: string) => ds.find((d) => d.id === id)!;

describe('working time', () => {
  it('skips nights when adding and measuring working minutes', () => {
    expect(addWorkingMinutes(ms('2026-11-12T16:00'), 120)).toBe(ms('2026-11-13T10:00'));
    expect(workingMinutesBetween(ms('2026-11-12T16:00'), ms('2026-11-13T10:00'))).toBe(120);
  });

  it('carries work over the night instead of scheduling outside 09:00-17:00', async () => {
    const { disputes } = await planDisputes([dispute('a', 100, '2026-11-13T16:00')], '2026-11-12T16:00');
    expect(disputes[0].chain.map((t) => [t.start, t.end])).toEqual([
      ['2026-11-12T16:00', '2026-11-12T16:45'],
      ['2026-11-12T16:45', '2026-11-13T09:45'],
      ['2026-11-13T09:45', '2026-11-13T10:15'],
    ]);
  });
});

describe('planner ordering', () => {
  it('ranks by amount x win probability x deadline pressure', () => {
    const now = ms(NOW);
    const big = dispute('big', 400, '2026-11-13T12:00');
    const small = dispute('small', 40, '2026-11-13T12:00');
    const urgent = dispute('urgent', 400, '2026-11-12T12:00');
    const unlikely = dispute('unlikely', 400, '2026-11-13T12:00', { winProbability: 0.1 });
    expect(priority(big, now)).toBeGreaterThan(priority(small, now));
    expect(priority(urgent, now)).toBeGreaterThan(priority(big, now));
    expect(priority(big, now)).toBeGreaterThan(priority(unlikely, now));
  });

  it('gives the highest priority dispute the earliest slot on a shared lane', async () => {
    const { disputes } = await planDisputes(
      [dispute('small', 40, '2026-11-13T12:00'), dispute('big', 400, '2026-11-13T12:00')],
      NOW,
    );
    expect(byId(disputes, 'big').slot!.start).toBe('2026-11-12T09:00');
    expect(byId(disputes, 'small').slot!.start).toBe('2026-11-12T11:15');
  });

  it('keeps chain order and never overlaps blocks on one lane', async () => {
    const { disputes } = await planDisputes(
      [dispute('a', 100, '2026-11-13T12:00'), dispute('b', 90, '2026-11-13T12:00')],
      NOW,
    );
    for (const d of disputes) {
      for (const t of d.chain) {
        for (const dep of t.dependsOn) {
          expect(ms(t.start!)).toBeGreaterThanOrEqual(ms(d.chain.find((c) => c.id === dep)!.end!));
        }
      }
    }
    const blocks = disputes.flatMap((d) => d.chain).sort((x, y) => ms(x.start!) - ms(y.start!));
    for (let i = 1; i < blocks.length; i++) {
      expect(ms(blocks[i].start!)).toBeGreaterThanOrEqual(ms(blocks[i - 1].end!));
    }
  });
});

describe('deadlines', () => {
  it('lands a placeable chain before its deadline', async () => {
    const { disputes, counters } = await planDisputes([dispute('a', 100, '2026-11-12T12:00')], NOW);
    const a = byId(disputes, 'a');
    expect(ms(a.slot!.end)).toBeLessThanOrEqual(ms(a.deadline));
    expect(a.state).toBe('safe');
    expect(counters.unplaced).toEqual([]);
  });

  it('reports a chain that cannot finish in time as unplaced and late, with the engine conflict', async () => {
    const { disputes, counters } = await planDisputes([dispute('a', 100, '2026-11-12T10:00')], NOW);
    const a = byId(disputes, 'a');
    expect(a.state).toBe('late');
    expect(a.slackMin).toBe(-75);
    expect(a.conflict).toContain('Finish-No-Later-Than');
    expect(counters.unplaced).toEqual(['a']);
  });

  it('marks a plan with little slack as tight', async () => {
    const { disputes } = await planDisputes([dispute('a', 100, '2026-11-12T11:30')], NOW);
    expect(byId(disputes, 'a').state).toBe('tight');
  });

  it('pushes the lower priority dispute past its deadline when the lane is full', async () => {
    const { counters } = await planDisputes(
      [dispute('big', 400, '2026-11-12T12:00'), dispute('small', 40, '2026-11-12T12:00')],
      NOW,
    );
    expect(counters.unplaced).toEqual(['small']);
  });

  it('shortens a chain when the evidence block is split across two lanes', async () => {
    const d = dispute('a', 100, '2026-11-12T11:00');
    expect((await planDisputes([d], NOW)).disputes[0].state).toBe('late');
    expect(splitAssemble(d, 2)).toBeNull();
    d.chain.find((t) => t.id === 'a:assemble:2')!.workerId = 'maya';
    const after = (await planDisputes([d], NOW)).disputes[0];
    expect(after.slot!.end).toBe('2026-11-12T10:45');
    expect(after.state).not.toBe('late');
  });

  it('honours a pinned start and plans other work around it', async () => {
    const pinned = dispute('pinned', 40, '2026-11-13T16:00');
    pinned.chain[0].pinnedStart = '2026-11-12T09:00';
    pinned.chain[0].pinnedBy = 'human';
    const { disputes } = await planDisputes([pinned, dispute('big', 400, '2026-11-13T16:00')], NOW);
    expect(byId(disputes, 'pinned').chain[0].start).toBe('2026-11-12T09:00');
    expect(byId(disputes, 'big').slot!.start).toBe('2026-11-12T09:45');
  });
});

describe('counters', () => {
  it('splits dollars into at risk, protected and resolved', async () => {
    const { disputes, counters } = await planDisputes(
      [
        dispute('late', 100, '2026-11-12T09:30'),
        dispute('safe', 250, '2026-11-13T16:00'),
        dispute('refund', 30, '2026-11-13T16:00', { decision: 'refund' }),
        dispute('done', 20, '2026-11-12T16:00', { status: 'resolved', chain: [] }),
      ],
      NOW,
    );
    expect(counters.atRiskUsd).toBe(100);
    expect(counters.protectedUsd).toBe(250);
    expect(counters.resolvedUsd).toBe(20);
    expect(counters.earliestDeadline?.disputeId).toBe('late');
    expect(computeCounters(disputes)).toEqual(counters);
  });
});
