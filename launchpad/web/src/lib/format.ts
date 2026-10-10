const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

// `gramUsd` comes from useGramUsd() in components, or getGramUsd() on the server.
export function usd(wgram: number, gramUsd: number): string {
  const value = wgram * gramUsd;
  if (value >= 1000) return `$${compact.format(value)}`;
  // Coin prices are fractions of a cent: keep three significant digits instead of rounding to $0.0000.
  if (value > 0 && value < 0.01) return `$${value.toPrecision(3)}`;
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

export function wgram(amount: number): string {
  if (amount >= 1000) return `${compact.format(amount)} wGRAM`;
  return `${amount.toLocaleString("en-US", { maximumFractionDigits: amount < 1 ? 6 : 2 })} wGRAM`;
}

export function tokens(amount: number): string {
  return amount >= 1000 ? compact.format(amount) : amount.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function age(unixSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
