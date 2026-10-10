"use client";

// One wallet interface for the whole site. On mainnet and devnet it is backed by Privy
// (email, Telegram or any Solana wallet, with an embedded wallet for people who have
// none); on the local test chain, or when no Privy app id is set, by the Solana wallet
// adapter with its burner wallet. Components only ever call useAppWallet().

import { createContext, useContext, useMemo } from "react";
import { PublicKey, type Keypair, type Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { usePrivy } from "@privy-io/react-auth";
import { useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { NETWORK } from "./config";
import { connection } from "./chain";

export type AppWallet = {
  ready: boolean;
  publicKey: PublicKey | null;
  // How the signed-in person is shown: their email or Telegram name, else null.
  account: string | null;
  // True for a wallet Privy created for the person (they can export its key from Profile).
  embedded: boolean;
  login: () => void;
  logout: () => Promise<void>;
  // Signs `tx` (fee payer and blockhash already set) plus any extra `signers`, sends it and
  // returns the signature. Confirmation is the caller's job (confirmSignature in chain.ts).
  sendTransaction: (tx: Transaction, signers?: Keypair[]) => Promise<string>;
};

const WalletContext = createContext<AppWallet | null>(null);

export function useAppWallet(): AppWallet {
  const wallet = useContext(WalletContext);
  if (!wallet) throw new Error("useAppWallet must be used inside <Providers>");
  return wallet;
}

// Local chain: the wallet adapter (Phantom, Solflare, Backpack, or the burner wallet).
export function AdapterWalletBridge({ children }: { children: React.ReactNode }) {
  const { connection: conn } = useConnection();
  const adapter = useWallet();
  const { setVisible } = useWalletModal();
  const value = useMemo<AppWallet>(
    () => ({
      ready: true,
      publicKey: adapter.publicKey,
      account: null,
      embedded: false,
      login: () => setVisible(true),
      logout: () => adapter.disconnect(),
      sendTransaction: (tx, signers) => adapter.sendTransaction(tx, conn, signers?.length ? { signers } : undefined),
    }),
    [adapter, conn, setVisible],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

// Mainnet and devnet: Privy. Privy only signs; the site sends through its own RPC relay,
// so every kind of wallet takes the same path.
export function PrivyWalletBridge({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();

  // The wallet the person signed in with, else their embedded wallet, else any.
  const wallet = useMemo(() => {
    const preferred = user?.wallet?.address;
    return wallets.find((w) => w.address === preferred) ?? wallets[0] ?? null;
  }, [wallets, user?.wallet?.address]);

  const value = useMemo<AppWallet>(() => {
    const publicKey = authenticated && wallet ? new PublicKey(wallet.address) : null;
    const account = user?.email?.address ?? (user?.telegram?.username ? `@${user.telegram.username}` : null);
    return {
      ready,
      publicKey,
      account,
      embedded: Boolean(publicKey && user?.wallet?.walletClientType === "privy"),
      login: () => login(),
      logout: () => logout(),
      sendTransaction: async (tx, signers) => {
        if (!wallet) throw new Error("Sign in first");
        if (signers?.length) tx.partialSign(...signers);
        const { signedTransaction } = await signTransaction({
          transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
          wallet,
          chain: NETWORK === "devnet" ? "solana:devnet" : "solana:mainnet",
        });
        return connection().sendRawTransaction(signedTransaction, { preflightCommitment: "confirmed" });
      },
    };
  }, [ready, authenticated, wallet, user, login, logout, signTransaction]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
