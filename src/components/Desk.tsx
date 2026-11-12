'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SOURCE_LABEL, STATE_LABEL, dayAndClock, duration, planLine, toDate, usd } from '@/lib/format';
import { EVIDENCE_SOURCES, type AgentAction, type Dispute, type Snapshot } from '@/lib/types';
import type { Override } from './Board';

const Board = dynamic(() => import('./Board'), { ssr: false, loading: () => <div className="board-loading">Loading the board…</div> });

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

/** A dollar figure that rolls to its new value. */
function Figure({ value, label, tone, testId }: { value: number; label: string; tone: 'risk' | 'kept' | 'closed'; testId: string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    if (start === value) return;
    const began = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - began) / 650);
      const current = start + (value - start) * (1 - Math.pow(1 - t, 3));
      from.current = current;
      setShown(current);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return (
    <div className={`figure figure-${tone}${value > 0 ? ' is-on' : ''}`} data-testid={testId} data-value={value}>
      <span className="figure-label">{label}</span>
      <span className="figure-value">{usd(shown)}</span>
    </div>
  );
}

const ACTOR: Record<AgentAction['by'], string> = {
  gemini: 'Gemini',
  heuristic: 'Rules',
  planner: 'Engine',
  human: 'You',
  system: 'Desk',
};

/** Split a tool result into what happened, what the scheduling engine said, and any warning. */
function parse(message: string) {
  const [head, engine] = message.split(/\s*Engine conflict:\s*/);
  const [what, warning] = head.split(/\.\s*Warning:\s*/);
  return { what: what.replace(/^rejected by the scheduling engine:\s*/, ''), engine, warning };
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function LogEntry({ action, onSelect }: { action: AgentAction; onSelect: (id: string) => void }) {
  const { what, engine, warning } = parse(action.message);
  const quiet = action.by === 'system' && !['simulateDispute', 'paypalWebhook', 'rollback'].includes(action.tool);
  return (
    <li className={`entry entry-${action.by}${action.ok ? '' : ' entry-rejected'}${quiet ? ' entry-quiet' : ''}`} data-tool={action.tool}>
      <div className="entry-head">
        <time>{clock(action.at)}</time>
        <span className="entry-actor">{ACTOR[action.by]}</span>
        <code>{action.tool}</code>
        {action.disputeId && (
          <button className="entry-ref" onClick={() => onSelect(action.disputeId!)}>
            {action.disputeId}
          </button>
        )}
      </div>
      <p className="entry-what">
        {!action.ok && <b>Rejected. </b>}
        {what}
      </p>
      {(engine || warning) && (
        <blockquote className={`engine${action.ok ? ' engine-warn' : ''}`}>
          <span>Scheduling engine</span>
          {warning && <p>{warning}</p>}
          {engine && <p className="engine-raw">{engine}</p>}
        </blockquote>
      )}
      {action.reason && <p className="entry-why">{action.reason}</p>}
      {action.paypal && (
        <p className={`stamp ${action.paypal.live ? 'stamp-live' : 'stamp-sim'}`}>
          {action.paypal.live
            ? `PayPal sandbox · ${action.paypal.method} ${action.paypal.path} · ${action.paypal.ok ? 'accepted' : 'rejected'}`
            : 'No PayPal call: not a PayPal dispute'}
        </p>
      )}
    </li>
  );
}

const SUGGESTIONS = ['Maya leaves at 2pm today', "I'm out 10 to 12", 'Maya is away 13:00 to 15:30'];

/** Plain-language instructions for the agent. */
function TellAgent({ running }: { running: boolean }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const send = async (value: string) => {
    if (!value.trim() || running) return;
    setError(null);
    const res = await post('/api/agent/command', { text: value });
    if (res.ok) setText('');
    else setError((await res.json()).why ?? 'could not send');
  };
  return (
    <form
      className="tell"
      onSubmit={(e) => {
        e.preventDefault();
        void send(text);
      }}
    >
      <label htmlFor="tell">Tell the agent</label>
      <div className="tell-row">
        <input id="tell" value={text} onChange={(e) => setText(e.target.value)} placeholder="Maya leaves at 2pm today" maxLength={280} disabled={running} data-testid="tell" />
        <button className="btn btn-ink" disabled={running || !text.trim()}>
          Send
        </button>
      </div>
      <div className="tell-chips">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" onClick={() => void send(s)} disabled={running}>
            {s}
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function FlightLog({ actions, running, onSelect }: { actions: AgentAction[]; running: boolean; onSelect: (id: string) => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Recent browsers return a Promise from scrollIntoView; an effect must not return it.
    void end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [actions.length]);
  return (
    <section className="rail-section" data-testid="agent-log">
      <header className="rail-head">
        <h2>Agent log</h2>
        <span className={`live-dot${running ? ' is-running' : ''}`}>{running ? 'agent working' : 'idle'}</span>
      </header>
      {actions.length === 0 ? (
        <p className="rail-empty">Nothing yet. Plan with the agent, or wait for a dispute to arrive.</p>
      ) : (
        <ol className="log">
          {actions.map((a) => (
            <LogEntry key={a.id} action={a} onSelect={onSelect} />
          ))}
          <div ref={end} />
        </ol>
      )}
    </section>
  );
}

function DisputeCard({ dispute, now, onClose }: { dispute: Dispute; now: number; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approve = async () => {
    setBusy(true);
    setError(null);
    const body = await (await post(`/api/disputes/${encodeURIComponent(dispute.id)}/approve`)).json();
    if (!body.ok) setError(body.message);
    setBusy(false);
  };
  const minutesLeft = (toDate(dispute.deadline).getTime() - now) / 60_000;
  const pending = dispute.pendingAction;
  const what = { makeRefundOffer: 'refund offer', acceptClaim: 'claim acceptance', provideEvidence: 'evidence' };
  const win = Math.round((dispute.winProbability ?? 0) * 100);
  return (
    <section className="rail-section card" data-testid="dispute-panel">
      <header className="rail-head">
        <h2>{dispute.id}</h2>
        <span className={`src src-${dispute.source}`}>{SOURCE_LABEL[dispute.source]}</span>
        <button className="close" onClick={onClose} aria-label="Back to the agent log">
          Log
        </button>
      </header>

      <div className="card-hero">
        <span className="card-amount">{usd(dispute.amount)}</span>
        <span className={`state state-${dispute.state}`}>{STATE_LABEL[dispute.state]}</span>
      </div>
      <p className="card-plan">{planLine(dispute)}</p>

      <dl className="card-facts">
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
          {dispute.status === 'open' && minutesLeft > 0 ? `, in ${duration(minutesLeft)}` : ''}
        </dd>
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

      {dispute.conflict && (
        <blockquote className="engine">
          <span>Scheduling engine</span>
          <p className="engine-raw">{dispute.conflict}</p>
        </blockquote>
      )}

      <h3>On file</h3>
      <ul className="card-list">
        {dispute.facts.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>

      <h3>Agent&apos;s call</h3>
      {dispute.decision ? (
        <div className="call">
          <div className="call-head">
            <span className={`verdict verdict-${dispute.decision}`}>{dispute.decision}</span>
            <span className="call-odds">{win}% to win</span>
          </div>
          <div className="odds" aria-hidden>
            <span style={{ width: `${win}%` }} />
          </div>
          <p>{dispute.rationale}</p>
        </div>
      ) : (
        <p className="rail-empty">No decision yet.</p>
      )}
      {dispute.flaggedForHuman && <p className="flag">Needs you: {dispute.flaggedForHuman}</p>}

      {dispute.draft && (
        <>
          <h3>{dispute.decision === 'fight' ? 'Evidence statement' : 'Note to the buyer'}</h3>
          <blockquote className="draft">{dispute.draft}</blockquote>
        </>
      )}

      {pending && (
        <div className="gate">
          <p>
            The agent prepared the {what[pending.kind]} and stopped: {pending.heldBecause}.
          </p>
          <button className="btn btn-ink" onClick={approve} disabled={busy} data-testid="approve">
            {busy ? 'Sending…' : 'Approve & send'}
          </button>
          <p className="fine">
            {dispute.source === 'paypal'
              ? 'Sends a real request to the PayPal sandbox.'
              : `${SOURCE_LABEL[dispute.source]}: approving records the decision; no PayPal call is made.`}
          </p>
          {error && <p className="error">{error}</p>}
        </div>
      )}
    </section>
  );
}

function Guardrails({ snapshot }: { snapshot: Snapshot }) {
  const [open, setOpen] = useState(false);
  const { autoResolveLimitUsd, neverConcedeAboveUsd } = snapshot.policy;
  const set = (key: 'autoResolveLimitUsd' | 'neverConcedeAboveUsd') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(e.target.value);
    if (Number.isFinite(value) && value >= 0) void post('/api/policy', { [key]: value });
  };
  return (
    <div className="guard">
      <button className="btn btn-line" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Agent acts alone ≤ {usd(autoResolveLimitUsd)}
      </button>
      {open && (
        <div className="pop" data-testid="policy">
          <label>
            Agent may send on its own up to
            <span className="money">
              $<input type="number" min={0} step={5} defaultValue={autoResolveLimitUsd} onChange={set('autoResolveLimitUsd')} />
            </span>
          </label>
          <label>
            Never concede on its own above
            <span className="money">
              $<input type="number" min={0} step={5} defaultValue={neverConcedeAboveUsd} onChange={set('neverConcedeAboveUsd')} />
            </span>
          </label>
          <p className="fine">Anything above waits for Approve &amp; send. Evidence always waits.</p>
        </div>
      )}
    </div>
  );
}

export default function Desk({ demo }: { demo: boolean }) {
  const { snapshot, connected } = useDesk(demo);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const onOverride = useCallback((change: Override) => void post('/api/override', change), []);

  const focusId = useMemo(() => {
    if (!snapshot?.running) return null;
    return [...snapshot.actions].reverse().find((a) => a.disputeId)?.disputeId ?? null;
  }, [snapshot?.running, snapshot?.actions]);

  if (!snapshot) return <main className="desk desk-loading">Connecting…</main>;

  const { counters } = snapshot;
  const selected = snapshot.disputes.find((d) => d.id === selectedId) ?? null;
  const now = toDate(snapshot.now).getTime();
  const next = counters.earliestDeadline;
  const nextLeft = next ? (toDate(next.deadline).getTime() - now) / 60_000 : 0;

  return (
    <main className="desk" data-running={snapshot.running} data-version={snapshot.version}>
      <header className="top">
        <div className="mark">
          <h1>DisputeDesk</h1>
          <p>Every PayPal dispute lands before its deadline</p>
        </div>

        <div className="figures">
          <Figure value={counters.atRiskUsd} label="At risk" tone="risk" testId="at-risk" />
          <Figure value={counters.protectedUsd} label="On course" tone="kept" testId="protected" />
          <Figure value={counters.resolvedUsd} label="Closed" tone="closed" testId="resolved" />
          <div className="figure figure-next">
            <span className="figure-label">Next deadline</span>
            <span className="figure-value">{next && nextLeft > 0 ? duration(nextLeft) : '—'}</span>
            {next && <span className="figure-note">{next.disputeId}</span>}
          </div>
        </div>

        <div className="controls">
          <div className="status">
            <span className={snapshot.agentMode === 'gemini' ? 'ok' : 'warn'} data-testid="agent-badge">
              {snapshot.agentMode === 'gemini' ? `Gemini · ${snapshot.agentModel}` : 'Offline agent (no Gemini key)'}
            </span>
            <span className={snapshot.paypal === 'configured' ? 'ok' : 'warn'}>{snapshot.paypal === 'configured' ? 'PayPal sandbox' : 'PayPal not configured'}</span>
            <span className={snapshot.demo ? 'sim' : 'ok'}>
              {snapshot.demo ? 'Demo clock' : 'Clock'} {snapshot.now.slice(11)}
            </span>
            {!connected && <span className="warn">reconnecting</span>}
          </div>
          <div className="buttons">
            <Guardrails snapshot={snapshot} />
            <button className="btn btn-line btn-sim" onClick={() => void post('/api/simulate')} disabled={snapshot.running} data-testid="simulate">
              Simulate a dispute
            </button>
            <button className="btn btn-ink" onClick={() => void post('/api/agent/run')} disabled={snapshot.running} data-testid="plan">
              {snapshot.running ? 'Agent working…' : 'Plan with agent'}
            </button>
          </div>
        </div>
      </header>

      <div className="body">
        <div className="main">
          <Board snapshot={snapshot} selectedId={selectedId} focusId={focusId} onSelect={setSelectedId} onOverride={onOverride} />
          <footer className="key">
            <span>
              <i className="sw sw-step" /> work
            </span>
            <span>
              <i className="sw sw-wait" /> waiting on carrier, nobody booked
            </span>
            <span>
              <i className="sw sw-ghost" /> before the agent moved it
            </span>
            <span>
              <i className="sw sw-zone" /> past the PayPal deadline
            </span>
            <span className="key-note">Drag or stretch a step to overrule the agent. The scheduling engine re-plans everything else.</span>
          </footer>
        </div>
        <aside className="rail">
          <TellAgent running={snapshot.running} />
          {selected ? (
            <DisputeCard key={selected.id} dispute={selected} now={now} onClose={() => setSelectedId(null)} />
          ) : (
            <FlightLog actions={snapshot.actions} running={snapshot.running} onSelect={setSelectedId} />
          )}
        </aside>
      </div>
    </main>
  );
}
