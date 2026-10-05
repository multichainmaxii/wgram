"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Loads `fn` now and every `ms`, keeping the last good value while refreshing.
export function usePolling<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false); // true once the first attempt finishes
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });

  const refresh = useCallback(async () => {
    try {
      setData(await fnRef.current());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (alive) await refresh();
    };
    void tick();
    const id = setInterval(tick, ms);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, refresh, ...deps]);

  return { data, error, loaded, refresh };
}
