// Ground-truth check: can we authenticate against PayPal and list disputes?
// Run: npm run check:paypal   (prints ids, statuses and amounts only; never credentials)
import { paypalConfigured, paypalRequest } from '../src/lib/paypal-rest';

interface DisputeSummary {
  dispute_id: string;
  status?: string;
  reason?: string;
  dispute_life_cycle_stage?: string;
  dispute_amount?: { currency_code: string; value: string };
  create_time?: string;
  update_time?: string;
}

async function main() {
  console.log(`PAYPAL_ENV=${process.env.PAYPAL_ENV ?? '(unset, defaults to sandbox)'}`);
  if (!paypalConfigured()) {
    console.log('RESULT: PayPal credentials missing. The app will run on seeded data only.');
    return;
  }
  console.log(`PAYPAL_WEBHOOK_ID: ${process.env.PAYPAL_WEBHOOK_ID ? 'configured' : 'missing'}`);

  try {
    const list = await paypalRequest<{ items?: DisputeSummary[] }>('/v1/customer/disputes?page_size=20');
    const items = list.items ?? [];
    console.log(`RESULT: token OK, GET /v1/customer/disputes OK, ${items.length} dispute(s).`);
    for (const d of items) {
      console.log(
        `  ${d.dispute_id}  ${d.status}  ${d.reason}  ${d.dispute_life_cycle_stage}  ` +
          `${d.dispute_amount?.value} ${d.dispute_amount?.currency_code}  updated ${d.update_time}`,
      );
    }
    if (items[0]) {
      const detail = await paypalRequest<Record<string, unknown>>(`/v1/customer/disputes/${items[0].dispute_id}`);
      console.log(`Detail keys for ${items[0].dispute_id}: ${Object.keys(detail).join(', ')}`);
      const links = (detail.links as { rel: string; method: string }[] | undefined) ?? [];
      console.log(`Allowed actions (HATEOAS): ${links.map((l) => `${l.method} ${l.rel}`).join(' | ')}`);
    }
  } catch (e) {
    console.log(`RESULT: PayPal call failed: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

main();
