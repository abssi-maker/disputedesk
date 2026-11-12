import Desk from '@/components/Desk';

export const dynamic = 'force-dynamic';

/** `/?demo=1` resets the board to the scripted demo state. */
export default async function Home({ searchParams }: { searchParams: Promise<{ demo?: string }> }) {
  const { demo } = await searchParams;
  return <Desk demo={demo === '1'} />;
}
