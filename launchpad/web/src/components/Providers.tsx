"use client";

import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { UnsafeBurnerWalletAdapter } from "@solana/wallet-adapter-unsafe-burner";
import "@solana/wallet-adapter-react-ui/styles.css";
import { NETWORK, RPC_URL } from "@/lib/config";
import { PriceProvider } from "@/lib/price";

// Wallet Standard wallets (Phantom, Solflare, Backpack) are detected automatically.
// On the local test network a throwaway burner wallet is added for testing.
export function Providers({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(() => (NETWORK === "localnet" ? [new UnsafeBurnerWalletAdapter()] : []), []);
  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <PriceProvider>{children}</PriceProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
