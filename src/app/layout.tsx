import './globals.css';

export const metadata = {
  title: 'DisputeDesk',
  description: 'Air traffic control for PayPal seller disputes',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
