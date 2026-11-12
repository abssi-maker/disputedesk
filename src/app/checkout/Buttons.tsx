'use client';

import { useEffect, useRef, useState } from 'react';

interface PayPalButtons {
  Buttons(options: {
    createOrder: () => Promise<string>;
    onApprove: (data: { orderID: string }) => Promise<void>;
    onError: (error: unknown) => void;
  }): { render(target: HTMLElement): Promise<void> };
}

const call = async (url: string) => {
  const res = await fetch(url, { method: 'POST' });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? 'PayPal request failed');
  return body;
};

/** PayPal JS SDK buttons: create the order on our server, capture it after approval. */
export default function Buttons({ clientId, currency }: { clientId: string; currency: string }) {
  const target = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const script = document.createElement('script');
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${currency}&intent=capture`;
    script.onload = () => {
      const paypal = (window as unknown as { paypal?: PayPalButtons }).paypal;
      if (!paypal || !target.current) return setStatus('The PayPal SDK did not load.');
      void paypal
        .Buttons({
          createOrder: async () => (await call('/api/checkout/orders')).id,
          onApprove: async ({ orderID }) => {
            const captured = await call(`/api/checkout/orders/${orderID}/capture`);
            setStatus(`Payment ${captured.status}. Order ${captured.id}, capture ${captured.captureId ?? 'n/a'}. You can now dispute it as the sandbox buyer.`);
          },
          onError: (error) => setStatus(`PayPal error: ${String((error as Error)?.message ?? error).slice(0, 200)}`),
        })
        .render(target.current);
    };
    script.onerror = () => setStatus('The PayPal SDK could not be loaded.');
    document.body.appendChild(script);
    return () => script.remove();
  }, [clientId, currency]);

  return (
    <>
      <div ref={target} className="checkout-buttons" data-testid="paypal-buttons" />
      {status && (
        <p className="checkout-status" data-testid="checkout-status">
          {status}
        </p>
      )}
    </>
  );
}
