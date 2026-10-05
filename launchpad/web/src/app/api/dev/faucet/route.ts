import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";

// Local development only: sends test SOL and stand-in wGRAM to a wallet. Disabled
// unless the site runs against the local validator with the seed's admin key.
export async function POST(req: Request) {
  const keypairPath = process.env.DEV_ADMIN_KEYPAIR;
  if (process.env.NEXT_PUBLIC_NETWORK !== "localnet" || !keypairPath) {
    return NextResponse.json({ error: "Faucet is only available on the local test network." }, { status: 404 });
  }
  const body = (await req.json().catch(() => null)) as { address?: string } | null;
  let owner: PublicKey;
  try {
    owner = new PublicKey(body?.address ?? "");
  } catch {
    return NextResponse.json({ error: "Invalid address." }, { status: 400 });
  }

  const connection = new Connection(process.env.NEXT_PUBLIC_RPC!, "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(keypairPath, "utf8"))));
  const mint = new PublicKey(process.env.NEXT_PUBLIC_WGRAM_MINT!);

  const sig = await connection.requestAirdrop(owner, 5 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash()) }, "confirmed");
  const ata = await getOrCreateAssociatedTokenAccount(connection, admin, mint, owner);
  await mintTo(connection, admin, mint, ata.address, admin, BigInt(5_000) * 10n ** 9n);
  return NextResponse.json({ sol: 5, wgram: 5_000 });
}
