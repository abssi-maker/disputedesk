# DisputeDesk

Air traffic control for PayPal seller disputes. Every dispute is a chain of work (get proof, assemble evidence, submit) that must land before PayPal's response deadline. A Gemini agent decides what to do with each dispute and re-plans the board; the Bryntum Scheduler Pro engine checks every move it makes.

## How it works

- **Board:** Bryntum Scheduler Pro. Lanes are You, Maya and the agent's Auto-resolver lane.
- **Deterministic layer:** the Scheduler Pro engine runs on the server (`src/lib/planner.ts`) with a 09:00-17:00 calendar, chain dependencies and the deadline as a "finish no later than" constraint. A move that would miss a deadline is rejected and the engine's conflict message is returned to the agent.
- **Agent:** Gemini function calling (`src/lib/agent.ts`). Tools: `setDecision`, `swapEvidenceSource`, `splitBlock`, `assignDispute`, `moveBlock`, `flagForHuman`, `makeRefundOffer`, `acceptClaim`, `provideEvidence`. Each call is streamed to the browser over server-sent events.
- **Guardrails:** PayPal writes at or under the auto-resolve limit are sent; anything above, and all evidence, waits for **Approve & send**.
- **Triggers:** a verified `CUSTOMER.DISPUTE.CREATED` / `UPDATED` webhook starts an agent run. Unverified deliveries are logged and ignored.

## Run it

Node 22 or newer.

```
npm install
cp .env.example .env      # fill in what you have; everything is optional
npm run build && npm start
```

Open http://localhost:3000. `/?demo=1` resets the board to the scripted demo state with the clock frozen at 09:00.

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
- **Not real, and labeled in the UI:** seed disputes, the "Simulate dispute" event, and writes on those (the log says no PayPal call was made).

Bryntum packages are the trial builds (watermarked).
