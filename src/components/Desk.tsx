'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SOURCE_LABEL, STATE_LABEL, dayAndClock, duration, planLine, toDate, usd } from '@/lib/format';
import { EVIDENCE_SOURCES, type AgentAction, type Dispute, type Snapshot } from '@/lib/types';
import type { Override } from './Board';

const Board = dynamic(() => import('./Board'), { ssr: false, loading: () => <div className="board-loading">Loading board…</div> });

const post = (url: string, body?: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

/** Live state over server-sent events. In demo mode the board is reset first. */
function useDesk(demo: boolean) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let source: EventSource | undefined;
    let cancelled = false;
    (async () => {
      if (demo) await post('/api/reset', { demo: true });
      if (cancelled) return;
      source = new EventSource('/api/agent/stream');
      source.onopen = () => setConnected(true);
      source.onerror = () => setConnected(false);
      source.onmessage = (e) => setSnapshot(JSON.parse(e.data));
    })();
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [demo]);
  return { snapshot, connected };
}

/** A dollar figure that counts to its new value instead of jumping. */
function Counter({ value, tone, label, testId }: { value: number; tone: 'risk' | 'protected' | 'resolved'; label: string; testId: string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    if (start === value) return;
    const began = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - began) / 700);
      const eased = 1 - Math.pow(1 - t, 3);
      const current = start + (value - start) * eased;
      from.current = current;
      setShown(current);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return (
    <div className={`counter counter-${tone}${value > 0 ? ' counter-on' : ''}`} data-testid={testId} data-value={value}>
      <span className="counter-value">{usd(shown)}</span>
      <span className="counter-label">{label}</span>
    </div>
  );
}

function useNow(snapshot: Snapshot | null) {
  const [, force] = useState(0);
  const skew = useMemo(() => (snapshot ? toDate(snapshot.now).getTime() - Date.now() : 0), [snapshot?.now, snapshot?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const timer = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  // The demo clock is frozen; the real clock keeps running between server updates.
  return snapshot?.demo ? toDate(snapshot.now).getTime() : Date.now() + skew;
}

const ACTOR: Record<AgentAction['by'], string> = {
  gemini: 'Gemini',
  heuristic: 'Offline rules',
  planner: 'Planner',
  human: 'You',
  system: 'System',
};

function LogRow({ action, onSelect }: { action: AgentAction; onSelect: (id: string) => void }) {
  const rejected = !action.ok;
  return (
    <li className={`log-row log-${action.by}${rejected ? ' log-rejected' : ''}`} data-tool={action.tool}>
      <div className="log-head">
        <span className={`actor actor-${action.by}`}>{ACTOR[action.by]}</span>
        <code>{action.tool}</code>
        {action.disputeId && (
          <button className="link" onClick={() => onSelect(action.disputeId!)}>
            {action.disputeId}
          </button>
        )}
        {rejected && <span className="chip chip-late">Rejected</span>}
      </div>
      <p className="log-message">{action.message}</p>
      {action.reason && <p className="log-why">Why: {action.reason}</p>}
      {action.paypal && (
        <p className={`log-paypal ${action.paypal.live ? 'live' : 'sim'}`}>
          {action.paypal.live
            ? `PayPal sandbox call: ${action.paypal.method} ${action.paypal.path} → ${action.paypal.ok ? 'accepted' : 'rejected'}`
            : 'Simulated: no PayPal call was made'}
        </p>
      )}
    </li>
  );
}

function AgentLog({ actions, running, onSelect }: { actions: AgentAction[]; running: boolean; onSelect: (id: string) => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [actions.length]);
  return (
    <section className="rail-section" data-testid="agent-log">
      <header className="rail-title">
        <h2>Agent log</h2>
        {running && <span className="pulse">working</span>}
      </header>
      {actions.length === 0 ? (
        <p className="empty">Nothing yet. Press Plan with agent, or wait for a dispute event.</p>
      ) : (
        <ol className="log">
          {actions.map((a) => (
            <LogRow key={a.id} action={a} onSelect={onSelect} />
          ))}
          <div ref={end} />
        </ol>
      )}
    </section>
  );
}

function DisputePanel({ dispute, now, onClose }: { dispute: Dispute; now: number; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approve = async () => {
    setBusy(true);
    setError(null);
    const res = await post(`/api/disputes/${encodeURIComponent(dispute.id)}/approve`);
    const body = await res.json();
    if (!body.ok) setError(body.message);
    setBusy(false);
  };
  const minutesLeft = (toDate(dispute.deadline).getTime() - now) / 60_000;
  const pending = dispute.pendingAction;
  const sendLabel = { makeRefundOffer: 'refund offer', acceptClaim: 'claim acceptance', provideEvidence: 'evidence' };
  return (
    <section className="rail-section panel" data-testid="dispute-panel">
      <header className="rail-title">
        <h2>{dispute.id}</h2>
        <span className={`badge badge-${dispute.source}`}>{SOURCE_LABEL[dispute.source]}</span>
        <button className="close" onClick={onClose} aria-label="Close panel">
          ×
        </button>
      </header>

      <div className="panel-amount">
        <strong>{usd(dispute.amount)}</strong>
        <span className={`chip chip-${dispute.state}`}>{STATE_LABEL[dispute.state]}</span>
      </div>
      <dl className="facts">
        <dt>Reason</dt>
        <dd>{dispute.reason}</dd>
        <dt>Buyer</dt>
        <dd>{dispute.buyer}</dd>
        <dt>Item</dt>
        <dd>{dispute.item}</dd>
        <dt>Deadline</dt>
        <dd>
          {dayAndClock(dispute.deadline)}
          {dispute.deadlineEstimated ? ' (estimated)' : ''}
          {dispute.status === 'open' && minutesLeft > 0 ? ` · in ${duration(minutesLeft)}` : ''}
        </dd>
        <dt>Plan</dt>
        <dd>{planLine(dispute)}</dd>
        <dt>Proof</dt>
        <dd>{dispute.evidenceSource ? EVIDENCE_SOURCES[dispute.evidenceSource].label : 'None on file'}</dd>
        {dispute.paypal && (
          <>
            <dt>PayPal</dt>
            <dd>
              {dispute.paypal.status} · {dispute.paypal.stage}
            </dd>
          </>
        )}
      </dl>

      <h3>Facts on file</h3>
      <ul className="bullets">
        {dispute.facts.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>

      <h3>Agent decision</h3>
      {dispute.decision ? (
        <div className="decision">
          <div className="decision-head">
            <span className={`chip chip-decision-${dispute.decision}`}>{dispute.decision}</span>
            <span className="win">{Math.round((dispute.winProbability ?? 0) * 100)}% win chance</span>
          </div>
          <div className="meter">
            <span style={{ width: `${Math.round((dispute.winProbability ?? 0) * 100)}%` }} />
          </div>
          <p>{dispute.rationale}</p>
        </div>
      ) : (
        <p className="empty">No decision yet.</p>
      )}
      {dispute.flaggedForHuman && <p className="flag">Needs you: {dispute.flaggedForHuman}</p>}

      {dispute.draft && (
        <>
          <h3>{dispute.decision === 'fight' ? 'Evidence draft' : 'Note to buyer'}</h3>
          <blockquote className="draft">{dispute.draft}</blockquote>
        </>
      )}

      {pending && (
        <div className="approve">
          <p>
            The agent prepared the {sendLabel[pending.kind]} but did not send it: {pending.heldBecause}.
          </p>
          <button className="btn btn-primary" onClick={approve} disabled={busy} data-testid="approve">
            {busy ? 'Sending…' : 'Approve & send'}
          </button>
          <p className="fineprint">
            {dispute.source === 'paypal'
              ? 'This sends a real request to the PayPal sandbox.'
              : `${SOURCE_LABEL[dispute.source]}: approving records the decision, no PayPal call is made.`}
          </p>
          {error && <p className="error">{error}</p>}
        </div>
      )}
    </section>
  );
}

function PolicyPanel({ snapshot }: { snapshot: Snapshot }) {
  const [open, setOpen] = useState(false);
  const { autoResolveLimitUsd, neverConcedeAboveUsd } = snapshot.policy;
  const set = (key: 'autoResolveLimitUsd' | 'neverConcedeAboveUsd') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(e.target.value);
    if (Number.isFinite(value) && value >= 0) void post('/api/policy', { [key]: value });
  };
  return (
    <div className="policy">
      <button className="btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Guardrails · {usd(autoResolveLimitUsd)}
      </button>
      {open && (
        <div className="popover" data-testid="policy">
          <label>
            Agent may act alone up to
            <span className="money-input">
              $<input type="number" min={0} step={5} defaultValue={autoResolveLimitUsd} onChange={set('autoResolveLimitUsd')} />
            </span>
          </label>
          <label>
            Never concede alone above
            <span className="money-input">
              $<input type="number" min={0} step={5} defaultValue={neverConcedeAboveUsd} onChange={set('neverConcedeAboveUsd')} />
            </span>
          </label>
          <p className="fineprint">Anything above these waits for Approve &amp; send. Evidence always waits.</p>
        </div>
      )}
    </div>
  );
}

function Strip({ dispute, now, selected, onSelect }: { dispute: Dispute; now: number; selected: boolean; onSelect: (id: string) => void }) {
  const minutesLeft = (toDate(dispute.deadline).getTime() - now) / 60_000;
  return (
    <button className={`strip strip-${dispute.state}${selected ? ' strip-selected' : ''}`} onClick={() => onSelect(dispute.id)} data-state={dispute.state}>
      <span className="strip-top">
        <strong>{dispute.id}</strong>
        <span className="strip-amount">{usd(dispute.amount)}</span>
      </span>
      <span className="strip-item">{dispute.item}</span>
      <span className="strip-bottom">
        <span className={`chip chip-${dispute.state}`}>{STATE_LABEL[dispute.state]}</span>
        <span className="strip-due">
          {dispute.status === 'resolved' ? (dispute.decision ?? 'done') : minutesLeft > 0 ? `due in ${duration(minutesLeft)}` : 'overdue'}
        </span>
      </span>
      <span className={`badge badge-${dispute.source}`}>{SOURCE_LABEL[dispute.source]}</span>
    </button>
  );
}

export default function Desk({ demo }: { demo: boolean }) {
  const { snapshot, connected } = useDesk(demo);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const now = useNow(snapshot);

  const onOverride = useCallback((change: Override) => void post('/api/override', change), []);
  const selected = snapshot?.disputes.find((d) => d.id === selectedId) ?? null;
  const strips = useMemo(
    () => [...(snapshot?.disputes ?? [])].sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved') || a.deadline.localeCompare(b.deadline)),
    [snapshot?.disputes],
  );

  if (!snapshot) return <main className="desk desk-loading">Connecting to DisputeDesk…</main>;

  const { counters } = snapshot;
  const earliest = counters.earliestDeadline;
  const earliestLeft = earliest ? (toDate(earliest.deadline).getTime() - now) / 60_000 : 0;

  return (
    <main className="desk" data-running={snapshot.running} data-version={snapshot.version}>
      <header className="top">
        <div className="brand">
          <h1>DisputeDesk</h1>
          <p>Air traffic control for PayPal seller disputes</p>
        </div>

        <div className="counters">
          <Counter value={counters.atRiskUsd} tone="risk" label="at risk" testId="at-risk" />
          <Counter value={counters.protectedUsd} tone="protected" label="protected" testId="protected" />
          <Counter value={counters.resolvedUsd} tone="resolved" label="resolved" testId="resolved" />
          <div className="countdown">
            <span className="counter-value">{earliest && earliestLeft > 0 ? duration(earliestLeft) : '—'}</span>
            <span className="counter-label">{earliest ? `to next deadline · ${earliest.disputeId}` : 'no open deadlines'}</span>
          </div>
        </div>

        <div className="actions">
          <div className="badges">
            <span className={`badge ${snapshot.agentMode === 'gemini' ? 'badge-live' : 'badge-offline'}`} data-testid="agent-badge">
              {snapshot.agentMode === 'gemini' ? `Agent: ${snapshot.agentModel}` : 'Offline agent (no Gemini key)'}
            </span>
            <span className={`badge ${snapshot.paypal === 'configured' ? 'badge-live' : 'badge-offline'}`}>
              {snapshot.paypal === 'configured' ? 'PayPal sandbox connected' : 'PayPal not configured'}
            </span>
            {snapshot.demo && <span className="badge badge-simulated">Demo mode · clock frozen at 09:00</span>}
            {!connected && <span className="badge badge-offline">Reconnecting…</span>}
          </div>
          <div className="buttons">
            <PolicyPanel snapshot={snapshot} />
            <button className="btn btn-sim" onClick={() => void post('/api/simulate')} disabled={snapshot.running} data-testid="simulate">
              Simulate dispute <small>simulated event</small>
            </button>
            <button className="btn btn-primary" onClick={() => void post('/api/agent/run')} disabled={snapshot.running} data-testid="plan">
              {snapshot.running ? 'Agent working…' : 'Plan with agent'}
            </button>
          </div>
        </div>
      </header>

      <div className="body">
        <div className="main">
          <div className="board">
            <Board snapshot={snapshot} selectedId={selectedId} onSelect={setSelectedId} onOverride={onOverride} />
          </div>
          <div className="legend">
            <span><i className="dot dot-late" /> Misses deadline</span>
            <span><i className="dot dot-tight" /> Tight</span>
            <span><i className="dot dot-safe" /> On time</span>
            <span><i className="dot dot-resolved" /> Resolved</span>
            <span className="legend-note">Vertical lines are PayPal response deadlines. Drag or resize a block to override the agent.</span>
          </div>
          <div className="strips" data-testid="strips">
            {strips.map((d) => (
              <Strip key={d.id} dispute={d} now={now} selected={d.id === selectedId} onSelect={setSelectedId} />
            ))}
          </div>
        </div>

        <aside className="rail">
          {selected ? (
            <DisputePanel key={selected.id} dispute={selected} now={now} onClose={() => setSelectedId(null)} />
          ) : (
            <AgentLog actions={snapshot.actions} running={snapshot.running} onSelect={setSelectedId} />
          )}
        </aside>
      </div>
    </main>
  );
}
