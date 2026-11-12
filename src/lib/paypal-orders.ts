// Sandbox test purchases through the PayPal server SDK (Orders API). A captured test payment is
// what the sandbox buyer can then dispute in the Resolution Center.
import { CheckoutPaymentIntent, Client, Environment, OrdersController } from '@paypal/paypal-server-sdk';

export const TEST_ITEM = { name: 'DisputeDesk test item: ceramic mug', amount: '24.00', currency: 'USD' };

let controller: OrdersController | undefined;

function orders(): OrdersController {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) throw new Error('PayPal credentials are not configured');
  return (controller ??= new OrdersController(
    new Client({
      environment: process.env.PAYPAL_ENV === 'live' ? Environment.Production : Environment.Sandbox,
      clientCredentialsAuthCredentials: {
        oAuthClientId: process.env.PAYPAL_CLIENT_ID,
        oAuthClientSecret: process.env.PAYPAL_CLIENT_SECRET,
      },
    }),
  ));
}

export async function createTestOrder(): Promise<{ id: string; status?: string }> {
  const { result } = await orders().createOrder({
    body: {
      intent: CheckoutPaymentIntent.Capture,
      purchaseUnits: [
        {
          description: TEST_ITEM.name,
          amount: {
            currencyCode: TEST_ITEM.currency,
            value: TEST_ITEM.amount,
            breakdown: { itemTotal: { currencyCode: TEST_ITEM.currency, value: TEST_ITEM.amount } },
          },
          items: [{ name: TEST_ITEM.name, quantity: '1', unitAmount: { currencyCode: TEST_ITEM.currency, value: TEST_ITEM.amount } }],
        },
      ],
    },
    prefer: 'return=minimal',
  });
  return { id: result.id!, status: result.status };
}

export async function captureOrder(id: string): Promise<{ id: string; status?: string; captureId?: string }> {
  const { result } = await orders().captureOrder({ id, prefer: 'return=representation' });
  return { id: result.id!, status: result.status, captureId: result.purchaseUnits?.[0]?.payments?.captures?.[0]?.id };
}
