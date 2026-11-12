import { TEST_ITEM } from '@/lib/paypal-orders';
import Buttons from './Buttons';

export const dynamic = 'force-dynamic';

/** Sandbox test purchase. The payment made here is what the sandbox buyer can dispute. */
export default function Checkout() {
  const clientId = process.env.PAYPAL_CLIENT_ID; // public by design: the PayPal JS SDK needs it in the browser
  return (
    <main className="checkout">
      <a href="/">← Back to the board</a>
      <h1>Sandbox test purchase</h1>
      <p className="checkout-note">
        PayPal sandbox only. No real money moves. Pay with a sandbox buyer account, then open a dispute for this payment in the sandbox Resolution
        Center to see it arrive on the board.
      </p>
      <div className="checkout-item">
        <span>{TEST_ITEM.name}</span>
        <strong>
          ${TEST_ITEM.amount} {TEST_ITEM.currency}
        </strong>
      </div>
      {clientId && process.env.PAYPAL_ENV !== 'live' ? (
        <Buttons clientId={clientId} currency={TEST_ITEM.currency} />
      ) : (
        <p className="error">PayPal sandbox credentials are not configured, so the test purchase is unavailable.</p>
      )}
    </main>
  );
}
