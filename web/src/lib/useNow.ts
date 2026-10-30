import { useEffect, useState } from 'react';

export function useNow(intervalMs = 250) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((x) => x + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}
