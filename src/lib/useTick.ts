import { useEffect, useState } from 'react';

/** Re-renders every 30 seconds so "4 min ago" stays true. */
export function useTick(): void {
  const [, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);
}
