# DisputeDesk

Air traffic control for PayPal seller disputes. Every dispute is a chain of work (get proof, assemble evidence, submit) that must land before PayPal's response deadline. A Gemini agent decides what to do with each dispute and re-plans the board; the Bryntum Scheduler Pro engine checks every move it makes.

## How it works

- **Board:** one Bryntum project shown in two views. A **Gantt** has one row per dispute: its evidence chain, its PayPal deadline and a no-fly zone after it. A **Scheduler Pro** has one row per person, showing the same steps. Drag a step in either view to overrule the agent.
- **Deterministic layer:** the Bryntum Gantt engine also runs on the server (`src/lib/planner.ts`). It applies working hours, chain dependencies (waiting on a carrier is dependency lag, not work), each person's calendar (time they said they are away) and the PayPal deadline as a "finish no later than" constraint. A move that would make a dispute miss its deadline is rejected, and the engine's own conflict message goes back to the agent.
- **Agent:** Gemini function calling (`src/lib/agent.ts`). Tools: `setDecision`, `swapEvidenceSource`, `splitBlock`, `assignDispute`, `moveBlock`, `setAvailability`, `flagForHuman`, `makeRefundOffer`, `acceptClaim`, `provideEvidence`. Each call is streamed to the browser over server-sent events. If a run would leave a dispute late that was on time when it started, it is rolled back.
- **Tell the agent:** plain-language instructions such as "Maya is out from 11 to 3pm" become engine calendars, and the agent re-plans around them.
- **Guardrails:** PayPal writes at or under the auto-resolve limit are sent; anything above, and all evidence, waits for **Approve & send**.
- **Triggers:** a verified `CUSTOMER.DISPUTE.CREATED` / `UPDATED` webhook starts an agent run. Unverified deliveries are logged and ignored.

## Run it

Node 22 or newer.

```
npm install
cp .env.example .env      # fill in what you have; everything is optional
npm run build && npm start
```

Open http://localhost:3000. `/?demo=1` resets the board to the scripted demo state, with the clock frozen at 09:00 and a **Simulate a dispute** button for a repeatable test event.

Without `GEMINI_API_KEY` the board uses a rule-based offline agent (shown as a badge). Without PayPal credentials it runs on seed data.

```
npm test                  # unit tests
npm run check:paypal      # PayPal auth + disputes list
npm run check:gemini      # Gemini model + function calling
npm run e2e -- http://localhost:3000 3     # browser check, needs a running server
```

## Environment

| Key | Purpose |
| --- | --- |
| `APP_BASE_URL` | Public URL of the app |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Agent (default model `gemini-3.8-flash`) |
| `PAYPAL_ENV`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal sandbox app |
| `PAYPAL_WEBHOOK_ID` | Webhook registered at `<APP_BASE_URL>/api/webhooks/paypal` |
| `AUTO_RESOLVE_LIMIT_USD` | Agent may send PayPal writes alone up to this amount |
| `MERCHANT_TZ` | IANA zone for working hours (default: server zone) |
| `BRYNTUM_NPM_TOKEN` | Only for licensed Bryntum packages; the trial needs none |

## What is real

- **Real:** Gemini calls, PayPal OAuth, loading sandbox disputes on boot, webhook signature verification, PayPal dispute writes for disputes that come from PayPal, Bryntum engine scheduling.
- **Not real, and labelled in the UI:** seed disputes (SEED), the demo-mode simulated dispute (SIM), and writes on those (the log says no PayPal call was made).
- `/checkout` makes a real sandbox payment with the PayPal buttons, which a sandbox buyer can then dispute.

Bryntum packages are the Gantt trial build (watermarked). Builds use webpack (`next build --webpack`).
