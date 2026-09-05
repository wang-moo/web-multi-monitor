// Keep only the latest layout while native WebView operations are in flight.
export function createLayoutSync(send, onError) {
  const applied = new Map();
  let pending;
  let running = false;
  return async (layouts) => {
    pending = layouts;
    if (running) return;
    running = true;
    try {
      while (pending) {
        const current = pending;
        pending = undefined;
        const labels = new Set(current.map(({ label }) => label));
        for (const label of applied.keys()) if (!labels.has(label)) applied.delete(label);
        for (const layout of current) {
          if (pending) break;
          const key = JSON.stringify(layout);
          if (applied.get(layout.label) === key) continue;
          try {
            await send(layout);
            applied.set(layout.label, key);
          } catch (error) {
            applied.delete(layout.label);
            onError(String(error));
          }
        }
      }
    } finally {
      running = false;
    }
  };
}
