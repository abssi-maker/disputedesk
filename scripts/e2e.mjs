// End-to-end check of the demo path in a real browser.
// Usage: node scripts/e2e.mjs [baseUrl] [runs] [screenshotDir]
// Needs a running server (npm run build && npm start). Exits non-zero on any failed run.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:3000';
const runs = Number(process.argv[3] ?? 1);
const shots = process.argv[4];
if (shots) mkdirSync(shots, { recursive: true });

const WOW_LIMIT_MS = 15_000;
const value = (page, id) => page.getByTestId(id).getAttribute('data-value').then(Number);
const idle = (page, timeout) => page.waitForFunction(() => document.querySelector('main.desk')?.dataset.running === 'false', null, { timeout });
const busy = (page) => page.waitForFunction(() => document.querySelector('main.desk')?.dataset.running === 'true', null, { timeout: 10_000 });
// A dispute's row carries its state; red bars follow it.
const someLateBars = (page) =>
  page.waitForSelector('[data-flight][data-state="late"]', { timeout: 4_000 }).then(() => true, () => false);
/** Rows repaint just after the counters. */
const noLateBars = (page) =>
  page.waitForFunction(() => document.querySelectorAll('[data-flight][data-state="late"]').length === 0, null, { timeout: 4_000 }).then(() => true, () => false);
const shot = async (page, name) => {
  if (!shots) return;
  await page.waitForTimeout(900); // let bar and counter animations settle
  await page.screenshot({ path: path.join(shots, name) });
};

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function run(browser, n) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const first = n === 1;

  const t0 = Date.now();
  await page.goto(`${base}/?demo=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.b-gantt-task');
  const loadMs = Date.now() - t0;
  await idle(page, 10_000);
  const agent = await page.getByTestId('agent-badge').innerText();

  // 1. The seeded board starts with money at risk.
  const riskAtStart = await value(page, 'at-risk');
  check(riskAtStart > 0 && (await someLateBars(page)), 'seeded board should start with late disputes');
  if (first) await shot(page, '01-board-before-plan.png');

  // 2. Plan with agent: bars change state and the counters update.
  const protectedBefore = await value(page, 'protected');
  await page.getByTestId('plan').click();
  await busy(page);
  const tPlan = Date.now();
  await idle(page, 90_000);
  const planMs = Date.now() - tPlan;
  check((await value(page, 'at-risk')) === 0, 'plan should leave nothing at risk');
  check((await value(page, 'protected')) > protectedBefore, 'plan should raise the protected amount');
  check(await noLateBars(page), 'plan should leave no late bars');
  if (first) await shot(page, '02-board-after-plan.png');

  // 3. The wow moment: a dispute event arrives, the chain goes red, the agent lands it.
  const tWow = Date.now();
  await page.getByTestId('simulate').click();
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="at-risk"]')?.dataset.value) > 0, null, { timeout: 5_000 });
  const riskAfterEvent = await value(page, 'at-risk');
  check(await someLateBars(page), 'the simulated dispute should turn its chain red');
  if (first) await shot(page, '03-red-board-dispute-arrives.png');
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="at-risk"]')?.dataset.value) === 0, null, { timeout: 60_000 });
  const wowMs = Date.now() - tWow;
  await idle(page, 60_000);
  const protectedAfter = await value(page, 'protected');
  check(await noLateBars(page), 'the agent should leave no late bars');
  check((await page.locator('[data-flight="SIM-1"]').getAttribute('data-state')) !== 'late', 'SIM-1 should not be late');
  check(wowMs < WOW_LIMIT_MS, `wow moment took ${wowMs} ms (limit ${WOW_LIMIT_MS})`);
  const tools = await page.locator('[data-testid="agent-log"] .entry').evaluateAll((rows) => rows.map((r) => r.dataset.tool));
  for (const tool of ['swapEvidenceSource', 'splitBlock', 'assignDispute']) check(tools.includes(tool), `agent log should contain ${tool}`);
  if (first) await shot(page, '04-green-board-agent-landed-it.png');
  if (first && shots) await page.getByTestId('agent-log').screenshot({ path: path.join(shots, '05-agent-log.png') });

  // 4. Side panel with the held evidence and the Approve & send gate.
  await page.locator('[data-flight="SIM-1"]').click();
  await page.getByTestId('dispute-panel').waitFor();
  check(await page.getByTestId('approve').isVisible(), 'Approve & send should be offered for the held evidence');
  if (first) await shot(page, '06-side-panel-approve-and-send.png');
  if (first && shots) await page.getByTestId('dispute-panel').screenshot({ path: path.join(shots, '07-side-panel.png') });

  // 5. Tell the agent: a person's absence goes into the scheduling engine.
  await page.getByTestId('dispute-panel').getByRole('button', { name: 'Back to the agent log' }).click();
  await page.getByTestId('tell').fill('Maya is away 13:00 to 15:00');
  await page.keyboard.press('Enter');
  await busy(page);
  await idle(page, 90_000);
  const tools2 = await page.locator('[data-testid="agent-log"] .entry').evaluateAll((rows) => rows.map((r) => r.dataset.tool));
  check(tools2.includes('setAvailability'), 'the agent should record the absence');
  check(await page.locator('.dd-away').first().isVisible(), 'the absence should show on the board');
  if (first) await shot(page, '08-told-the-agent-maya-is-away.png');

  check(errors.length === 0, `page errors: ${errors.join(' | ')}`);
  await page.close();
  return { agent, loadMs, planMs, wowMs, riskAtStart, riskAfterEvent, protectedAfter };
}

const browser = await chromium.launch();
let failed = 0;
for (let n = 1; n <= runs; n++) {
  try {
    const r = await run(browser, n);
    console.log(
      `run ${n}: PASS  [${r.agent}]  board ${r.loadMs} ms | plan ${r.planMs} ms | wow ${r.wowMs} ms | ` +
        `$${r.riskAtStart} at risk at start -> $${r.riskAfterEvent} at risk after event -> $${r.protectedAfter} protected`,
    );
  } catch (e) {
    failed += 1;
    console.log(`run ${n}: FAIL  ${e.message}`);
  }
}
await browser.close();
console.log(failed ? `${failed} of ${runs} run(s) failed` : `all ${runs} run(s) passed`);
process.exit(failed ? 1 : 0);
