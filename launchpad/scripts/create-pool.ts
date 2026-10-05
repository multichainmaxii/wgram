// Creates the wGRAM/SOL Meteora DLMM pool and seeds it with concentrated liquidity
// around the current GRAM/SOL price, so terminals and bots can route SOL -> wGRAM ->
// coin through Jupiter. The owner keypair (the buyback wallet) pays for and owns the
// pool position and earns its trading fees.
//
// Dry run by default: prints the plan and simulates creating the pool. --send creates
// the pool (if it doesn't exist yet) and adds the liquidity. Runbook: DEPLOY.md.
//
//   pnpm create-pool --rpc <url> --owner-keypair <path> --wgram <mint> \
//     --wgram-amount <n> --sol-amount <n> [--price <SOL per wGRAM>] [--send]

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { NATIVE_MINT, getAccount, getAssociatedTokenAddressSync, getMint } from '@solana/spl-token'
import BN from 'bn.js'

// The SDK's ESM build can't import BN from anchor under tsx, so load the CommonJS build.
const dlmmModule = createRequire(import.meta.url)('@meteora-ag/dlmm')
const DLMM = dlmmModule.DLMM ?? dlmmModule.default ?? dlmmModule
const { StrategyType } = dlmmModule

// Meteora's standard tier: 0.25% between bins, 0.25% base fee.
const BIN_STEP = 25
const PRESET = new PublicKey('w1rfAh2zApVM55NnpEUxZL5L9EjP4RyAyhjwHraLBQE')
// 34 bins each side of the price (~ +/-8.9%): one position holds at most 70 bins.
const HALF_WIDTH = 34

const USAGE =
  'usage: pnpm create-pool --rpc <url> --owner-keypair <path> --wgram <mint> --wgram-amount <n> --sol-amount <n> [--price <SOL per wGRAM>] [--send]'

class Abort extends Error {}
const fail = (message: string): never => {
  throw new Abort(message)
}

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    rpc: { type: 'string' },
    'owner-keypair': { type: 'string' },
    wgram: { type: 'string' },
    'wgram-amount': { type: 'string' },
    'sol-amount': { type: 'string' },
    price: { type: 'string' },
    send: { type: 'boolean', default: false },
  },
})

const fromInvocation = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path)
const rpcHost = (rpc: string) => new URL(rpc).host

function loadKeypair(path: string): Keypair {
  if (!existsSync(path)) fail(`no keypair file at ${path}`)
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))))
  } catch {
    return fail(`${path} is not a JSON keypair`) // never print the file's contents
  }
}

function units(amount: string, flag: string): BN {
  if (!/^\d+(\.\d{1,9})?$/.test(amount)) fail(`${flag} must be a positive number with at most 9 decimals`)
  const [whole, frac = ''] = amount.split('.')
  return new BN(whole + frac.padEnd(9, '0'))
}

async function marketPrice(): Promise<number> {
  const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network,solana&vs_currencies=usd')
  if (!res.ok) fail(`CoinGecko price request failed (${res.status}); pass --price`)
  const p = (await res.json()) as Record<string, { usd: number }>
  return p['the-open-network'].usd / p.solana.usd
}

async function sendOrSimulate(connection: Connection, tx: Transaction, signers: Keypair[], send: boolean, label: string) {
  tx.feePayer = signers[0].publicKey
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
  if (send) {
    const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' })
    console.log(`  ${label}: ${sig}`)
    return
  }
  const signed = new VersionedTransaction(tx.compileMessage())
  signed.sign(signers)
  const sim = (await connection.simulateTransaction(signed, { sigVerify: true })).value
  if (sim.err) {
    for (const log of (sim.logs ?? []).slice(-10)) console.log(`    ${log}`)
    fail(`${label} simulation failed: ${JSON.stringify(sim.err)}`)
  }
  console.log(`  ${label}: simulation OK (${sim.unitsConsumed?.toLocaleString()} compute units)`)
}

async function main() {
  const { rpc, 'owner-keypair': ownerPath, wgram: wgramArg, 'wgram-amount': wgramAmount, 'sol-amount': solAmount, send } = args
  if (!rpc || !ownerPath || !wgramArg || !wgramAmount || !solAmount) fail(USAGE)
  const owner = loadKeypair(fromInvocation(ownerPath!))
  const wgram = new PublicKey(wgramArg!)
  const xAmount = units(wgramAmount!, '--wgram-amount')
  const yAmount = units(solAmount!, '--sol-amount')
  const connection = new Connection(rpc!, 'confirmed')

  console.log(send ? 'create-pool: SEND' : 'create-pool: DRY RUN (add --send to create and seed the pool)')
  console.log(`  rpc       ${rpcHost(rpc!)}`)
  const mint = await getMint(connection, wgram)
  if (mint.decimals !== 9) fail(`${wgram.toBase58()} has ${mint.decimals} decimals; wGRAM has 9`)

  const price = args.price ? Number(args.price) : await marketPrice()
  if (!(price > 0)) fail('--price must be a positive number')
  const activeId: number = DLMM.getBinIdFromPrice(DLMM.getPricePerLamport(9, 9, price), BIN_STEP, false)
  const [minBin, maxBin] = [activeId - HALF_WIDTH, activeId + HALF_WIDTH]
  const edge = (bins: number) => price * (1 + BIN_STEP / 10_000) ** bins

  const sol = await connection.getBalance(owner.publicKey)
  const wgramAta = getAssociatedTokenAddressSync(wgram, owner.publicKey)
  const wgramHeld = await getAccount(connection, wgramAta).then((a) => a.amount, () => 0n)
  console.log(`  owner     ${owner.publicKey.toBase58()}  (${(sol / 1e9).toFixed(4)} SOL, ${(Number(wgramHeld) / 1e9).toFixed(4)} wGRAM)`)
  console.log(`  price     ${price.toPrecision(6)} SOL per wGRAM (bin ${activeId})`)
  console.log(`  range     ${edge(-HALF_WIDTH).toPrecision(6)} to ${edge(HALF_WIDTH).toPrecision(6)} SOL per wGRAM (bins ${minBin}..${maxBin})`)
  console.log(`  deposit   ${wgramAmount} wGRAM + ${solAmount} SOL, spread evenly (Spot)`)
  if (BigInt(xAmount.toString()) > wgramHeld) fail(`owner holds ${Number(wgramHeld) / 1e9} wGRAM, less than --wgram-amount`)
  if (BigInt(yAmount.toString()) + 100_000_000n > BigInt(sol)) fail('owner needs --sol-amount plus ~0.1 SOL for rent and fees')

  // One wGRAM/SOL pool per bin step and fee tier; reuse it if someone already made it.
  let pair: PublicKey | null = await DLMM.getPairPubkeyIfExists(connection, wgram, NATIVE_MINT, new BN(BIN_STEP), new BN(10_000), new BN(0))
  if (pair) {
    console.log(`  pool      ${pair.toBase58()} (exists)`)
  } else {
    const createTx: Transaction = await DLMM.createLbPair2(connection, owner.publicKey, wgram, NATIVE_MINT, PRESET, new BN(activeId))
    await sendOrSimulate(connection, createTx, [owner], send!, 'create pool')
    if (!send) {
      console.log('\nDry run only: nothing was sent. Re-run with --send to create the pool and add the liquidity.')
      return
    }
    pair = await DLMM.getPairPubkeyIfExists(connection, wgram, NATIVE_MINT, new BN(BIN_STEP), new BN(10_000), new BN(0))
    if (!pair) fail('pool was created but could not be found')
    console.log(`  pool      ${pair!.toBase58()} (created)`)
  }

  const dlmm = await DLMM.create(connection, pair!)
  const active = await dlmm.getActiveBin()
  if (Math.abs(active.binId - activeId) > HALF_WIDTH / 2) {
    fail(`the pool's price (bin ${active.binId}) is far from the market (bin ${activeId}); check before adding liquidity`)
  }
  const position = Keypair.generate()
  const addTx: Transaction = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey,
    totalXAmount: xAmount,
    totalYAmount: yAmount,
    strategy: { minBinId: active.binId - HALF_WIDTH, maxBinId: active.binId + HALF_WIDTH, strategyType: StrategyType.Spot },
    user: owner.publicKey,
    slippage: 1,
  })
  await sendOrSimulate(connection, addTx, [owner, position], send!, 'add liquidity')
  if (send) {
    console.log(`\nPosition ${position.publicKey.toBase58()} owned by ${owner.publicKey.toBase58()}`)
    console.log(`Pool: https://app.meteora.ag/dlmm/${pair!.toBase58()}`)
  }
}

main().catch((e) => {
  console.error(e instanceof Abort ? `\nerror: ${e.message}` : e)
  process.exitCode = 1
})
