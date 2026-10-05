"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { GRAM_USD } from "./config";
import type { PriceResponse } from "./types";

const PriceContext = createContext<number>(GRAM_USD);

// Live GRAM/USD from /api/price, refreshed every minute; the configured fallback is
// used until the first response (or if the route is unavailable).
export function PriceProvider({ children }: { children: React.ReactNode }) {
  const [gramUsd, setGramUsd] = useState(GRAM_USD);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/price");
        if (!res.ok) return;
        const body = (await res.json()) as PriceResponse;
        if (alive && body.gramUsd > 0) setGramUsd(body.gramUsd);
      } catch {
        // keep the last known price
      }
    };
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return <PriceContext.Provider value={gramUsd}>{children}</PriceContext.Provider>;
}

export const useGramUsd = () => useContext(PriceContext);
