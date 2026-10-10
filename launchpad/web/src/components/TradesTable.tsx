import { NETWORK } from "@/lib/config";
import { age, shortAddress, tokens } from "@/lib/format";
import type { Trade } from "@/lib/types";

// Same precision as format.wgram() without the unit, which the column header carries.
const wgramAmount = (amount: number) =>
  amount >= 1000 ? tokens(amount) : amount.toLocaleString("en-US", { maximumFractionDigits: amount < 1 ? 6 : 2 });

export function TradesTable({ trades, symbol, error }: { trades: Trade[] | null; symbol: string; error?: string | null }) {
  return (
    <div className="border border-line bg-panel p-5">
      <h2 className="hud mb-3 text-muted">Trades</h2>
      {!trades ? (
        <p className="text-sm text-muted">{error ? "Couldn't load trades." : "Loading trades…"}</p>
      ) : trades.length === 0 ? (
        <p className="text-sm text-muted">No trades yet.</p>
      ) : (
        <div className="max-h-[28rem] overflow-auto">
          <table className="w-full whitespace-nowrap text-sm">
            <thead className="sticky top-0 bg-panel text-xs text-muted">
              <tr>
                <th className="pb-2 pr-3 text-left font-medium">Time</th>
                <th className="pb-2 pr-3 text-left font-medium">Side</th>
                <th className="pb-2 pr-3 text-right font-medium">wGRAM</th>
                <th className="pb-2 pr-3 text-right font-medium">${symbol}</th>
                <th className="pb-2 text-right font-medium">Trader</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {trades.map((t) => (
                <tr key={t.signature} className="border-t border-line">
                  <td className="py-2 pr-3 text-muted">{age(t.time)}</td>
                  <td className={`py-2 pr-3 font-medium ${t.side === "buy" ? "text-up" : "text-down"}`}>{t.side === "buy" ? "Buy" : "Sell"}</td>
                  <td className="py-2 pr-3 text-right">{wgramAmount(t.wgram)}</td>
                  <td className="py-2 pr-3 text-right">{tokens(t.tokens)}</td>
                  <td className="py-2 text-right">
                    <Trader address={t.trader} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Explorers can't see the local test chain, so addresses only link on devnet and mainnet.
function Trader({ address }: { address: string }) {
  if (NETWORK === "localnet") return <span className="font-mono text-xs text-muted">{shortAddress(address)}</span>;
  const cluster = NETWORK === "devnet" ? "?cluster=devnet" : "";
  return (
    <a
      href={`https://solscan.io/account/${address}${cluster}`}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-xs text-muted hover:text-accent"
    >
      {shortAddress(address)}
    </a>
  );
}
