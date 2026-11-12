// Runs once when the server starts: load the Bryntum scheduling engine before any request arrives.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { loadEngine } = await import('./lib/planner');
    await loadEngine();
  }
}
