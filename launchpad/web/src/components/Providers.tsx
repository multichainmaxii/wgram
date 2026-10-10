"use client";

import { useMemo } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { UnsafeBurnerWalletAdapter } from "@solana/wallet-adapter-unsafe-burner";
import "@solana/wallet-adapter-react-ui/styles.css";
import { NETWORK, PRIVY_APP_ID, rpcEndpoint } from "@/lib/config";
import { PriceProvider } from "@/lib/price";
import { AdapterWalletBridge, PrivyWalletBridge } from "@/lib/wallet";

// Privy handles sign-in on real networks: email, Telegram or a Solana wallet, and it
// creates a wallet for people who don't have one. The local test chain keeps the wallet
// adapter and its burner wallet, which need no account.
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <PriceProvider>
      {PRIVY_APP_ID && NETWORK !== "localnet" ? <PrivyWallets>{children}</PrivyWallets> : <AdapterWallets>{children}</AdapterWallets>}
    </PriceProvider>
  );
}

function PrivyWallets({ children }: { children: React.ReactNode }) {
  const connectors = useMemo(() => toSolanaWalletConnectors({ shouldAutoConnect: true }), []);
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        appearance: { theme: "dark", accentColor: "#2AABEE", logo: "/logo.svg", walletChainType: "solana-only", landingHeader: "Sign in to ongram.fun" },
        loginMethods: ["telegram", "email", "wallet"],
        embeddedWallets: { solana: { createOnLogin: "users-without-wallets" }, ethereum: { createOnLogin: "off" } },
        externalWallets: { solana: { connectors } },
      }}
    >
      <PrivyWalletBridge>{children}</PrivyWalletBridge>
    </PrivyProvider>
  );
}

// Wallet Standard wallets (Phantom, Solflare, Backpack) are detected automatically; the
// local test network adds a throwaway burner wallet.
function AdapterWallets({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(() => (NETWORK === "localnet" ? [new UnsafeBurnerWalletAdapter()] : []), []);
  return (
    <ConnectionProvider endpoint={rpcEndpoint()} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <AdapterWalletBridge>{children}</AdapterWalletBridge>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
