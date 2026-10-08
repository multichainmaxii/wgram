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
// Users only ever come with SOL, so a burst of net buying drains the wGRAM side. Two
// wGRAM-only backstop positions stacked above the core keep a SOL buy quotable up to
// ~+55% (it just gets pricier) until the refill bot or arbitrage restocks the core.
const BACKSTOP_LAYERS = 2
const BACKSTOP_WIDTH = 69 // bins per layer
const CORE_SHARE_PCT = 67 // of the wGRAM; the rest is split evenly across the backstop

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
  const coreX = xAmount.muln(CORE_SHARE_PCT).divn(100)
  const layerX = xAmount.sub(coreX).divn(BACKSTOP_LAYERS)
  const top = HALF_WIDTH + BACKSTOP_LAYERS * BACKSTOP_WIDTH
  const fmtUnits = (v: BN) => (Number(v.toString()) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 })
  console.log(`  core      ${edge(-HALF_WIDTH).toPrecision(6)} to ${edge(HALF_WIDTH).toPrecision(6)} SOL per wGRAM (bins ${minBin}..${maxBin}): ${fmtUnits(coreX)} wGRAM + ${solAmount} SOL`)
  console.log(`  backstop ${BACKSTOP_LAYERS} wGRAM-only layers up to ${edge(top).toPrecision(6)} SOL per wGRAM (+${((edge(top) / price - 1) * 100).toFixed(0)}%): ${fmtUnits(layerX)} wGRAM each`)
  if (BigInt(xAmount.toString()) > wgramHeld) fail(`owner holds ${Number(wgramHeld) / 1e9} wGRAM, less than --wgram-amount`)
  if (BigInt(yAmount.toString()) + 100_000_000n > BigInt(sol)) fail('owner needs --sol-amount plus ~0.1 SOL for rent and fees')

  // Pools made from a preset sit at an address derived from (preset, wGRAM, SOL); reuse
  // it if it already exists.
  const [pairAddress] = dlmmModule.deriveLbPairWithPresetParamWithIndexKey(PRESET, wgram, NATIVE_MINT, new PublicKey(dlmmModule.LBCLMM_PROGRAM_IDS['mainnet-beta']))
  let pair: PublicKey | null = (await connection.getAccountInfo(pairAddress)) ? pairAddress : null
  if (pair) {
    console.log(`  pool      ${pair.toBase58()} (exists)`)
  } else {
    const createTx: Transaction = await DLMM.createLbPair2(connection, owner.publicKey, wgram, NATIVE_MINT, PRESET, new BN(activeId))
    await sendOrSimulate(connection, createTx, [owner], send!, 'create pool')
    if (!send) {
      console.log('\nDry run only: nothing was sent. Re-run with --send to create the pool and add the liquidity.')
      return
    }
    pair = (await connection.getAccountInfo(pairAddress)) ? pairAddress : null
    if (!pair) fail('pool was created but could not be found')
    console.log(`  pool      ${pair!.toBase58()} (created)`)
  }

  const dlmm = await DLMM.create(connection, pair!)
  const active = await dlmm.getActiveBin()
  if (Math.abs(active.binId - activeId) > HALF_WIDTH / 2) {
    fail(`the pool's price (bin ${active.binId}) is far from the market (bin ${activeId}); check before adding liquidity`)
  }
  // Core: both sides, spread evenly around the pool's price.
  const a = active.binId
  const layers = [
    { label: 'core', min: a - HALF_WIDTH, max: a + HALF_WIDTH, x: coreX, y: yAmount, singleSidedX: false },
    ...Array.from({ length: BACKSTOP_LAYERS }, (_, i) => ({
      label: `backstop ${i + 1}`,
      min: a + HALF_WIDTH + 1 + i * BACKSTOP_WIDTH,
      max: a + HALF_WIDTH + (i + 1) * BACKSTOP_WIDTH,
      x: layerX,
      y: new BN(0),
      singleSidedX: true,
    })),
  ]
  const positions: PublicKey[] = []
  for (const layer of layers) {
    const position = Keypair.generate()
    const tx: Transaction = await dlmm.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: position.publicKey,
      totalXAmount: layer.x,
      totalYAmount: layer.y,
      strategy: { minBinId: layer.min, maxBinId: layer.max, strategyType: StrategyType.Spot, singleSidedX: layer.singleSidedX },
      user: owner.publicKey,
      slippage: 1,
    })
    await sendOrSimulate(connection, tx, [owner, position], send!, `add ${layer.label} (bins ${layer.min}..${layer.max})`)
    positions.push(position.publicKey)
  }
  if (send) {
    console.log(`\nPositions owned by ${owner.publicKey.toBase58()}:`)
    for (const [i, p] of positions.entries()) console.log(`  ${layers[i].label.padEnd(11)} ${p.toBase58()}`)
    console.log(`Pool: https://app.meteora.ag/dlmm/${pair!.toBase58()}`)
  }
}

main().catch((e) => {
  console.error(e instanceof Abort ? `\nerror: ${e.message}` : e)
  process.exitCode = 1
})
