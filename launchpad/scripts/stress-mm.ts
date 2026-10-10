// Stress test of the wGRAM/SOL pool plus the market maker (mm.ts) on the local validator (DLMM cloned
// from mainnet). Each scenario: a fresh stand-in wGRAM and pool seeded like mainnet
// (SEED_USD, 90% wGRAM / 10% SOL, core + backstop via create-pool), then TOTAL_USD of
// trading spread over DURATION minutes in 5-minute windows. The bot corrects the price from
// its reserve after every third of a window (~100 s); a bridge refill of the reserve lands one
// window after it starts, at 0.55% + $0.32 per trip.
//
// Scenarios (SCENARIO): buy (all SOL buys), sell (all sells to SOL), roundtrip (buys,
// then the same amount sold), mixed (each window a random split of buys and sells).
//
//   SCENARIO=mixed SEED_SOL_PCT=50 RPC=http://127.0.0.1:11899 pnpm exec tsx scripts/stress-mm.ts [minutes...]

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { NATIVE_MINT, burn, createMint, getAccount, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import BN from 'bn.js'
import { DLMM, correct, harvest, needsRecenter, poolPrice, recenter, reserveTarget, wallet } from './mm.ts'

const RPC = process.env.RPC ?? 'http://127.0.0.1:11899'
const TOTAL_USD = Number(process.env.TOTAL_USD ?? 250_000)
const SCENARIO = (process.env.SCENARIO ?? 'buy') as 'buy' | 'sell' | 'roundtrip' | 'mixed'
const SOL_USD = 126
const GRAM_USD = 1.54
const FAIR = GRAM_USD / SOL_USD // SOL per wGRAM
const SEED_USD = Number(process.env.SEED_USD ?? 1_000)
const SEED_SOL_PCT = Number(process.env.SEED_SOL_PCT ?? 10) // share of the seed put in as SOL
const SEED_WGRAM = (SEED_USD * (100 - SEED_SOL_PCT)) / 100 / GRAM_USD
const SEED_SOL = (SEED_USD * SEED_SOL_PCT) / 100 / SOL_USD
const MAX_TRADE_USD = 1_000 // one swap per $1k, like many separate traders
// Trading window, and how long a bridge trip takes to land (one window). Real Omni trips have
// taken 5 to 20 minutes.
const WINDOW_MIN = Number(process.env.WINDOW_MIN ?? 5)
const RENT_SOL = 0.5 // pool and position rent plus fees, on top of the seed
const BRIDGE_COST = 0.0055 // NEAR Intents spread + fees
const BRIDGE_FIXED_SOL = 0.32 / SOL_USD // Omni relayer fee per trip
const MIN_CONVERT = 1_000_000_000n // lamports: the bot's --min-convert

const connection = new Connection(RPC, 'confirmed')
const dir = join(import.meta.dirname, '..', '.local', 'stress')
mkdirSync(dir, { recursive: true })

async function airdrop(to: PublicKey, sol: number) {
  for (let left = sol; left > 0; left -= 500) {
    const sig = await connection.requestAirdrop(to, Math.round(Math.min(500, left) * LAMPORTS_PER_SOL))
    await connection.confirmTransaction(sig, 'confirmed')
  }
}

// Deterministic randomness so runs are comparable.
let seed = 42
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)

async function scenario(minutes: number) {
  const owner = Keypair.generate()
  const authority = Keypair.generate()
  const trader = Keypair.generate()
  const sink = Keypair.generate().publicKey
  await airdrop(owner.publicKey, SEED_SOL + RENT_SOL)
  await airdrop(authority.publicKey, 5)
  await airdrop(trader.publicKey, Math.ceil((TOTAL_USD / SOL_USD) * 1.6) + 10)

  const mint = await createMint(connection, authority, authority.publicKey, null, 9)
  const ownerAta = await getOrCreateAssociatedTokenAccount(connection, owner, mint, owner.publicKey)
  const traderAta = await getOrCreateAssociatedTokenAccount(connection, trader, mint, trader.publicKey)
  await mintTo(connection, authority, mint, ownerAta.address, authority, BigInt(Math.round(SEED_WGRAM * 1e9)))
  // Sellers hold wGRAM from selling coins; give the trader enough to sell everything planned.
  if (SCENARIO !== 'buy') await mintTo(connection, authority, mint, traderAta.address, authority, BigInt(Math.round((TOTAL_USD / GRAM_USD) * 1.2 * 1e9)))
  const ownerFile = join(dir, `owner-${SCENARIO}-${minutes}.json`)
  writeFileSync(ownerFile, JSON.stringify(Array.from(owner.secretKey)))

  const create = spawnSync('pnpm', ['exec', 'tsx', 'scripts/create-pool.ts', '--rpc', RPC, '--owner-keypair', ownerFile,
    '--wgram', mint.toBase58(), '--wgram-amount', (Math.floor(SEED_WGRAM * 1e6) / 1e6).toFixed(6), '--sol-amount', (Math.floor(SEED_SOL * 1e6) / 1e6).toFixed(6),
    '--price', FAIR.toString(), '--send'], { encoding: 'utf8' })
  if (create.status !== 0) throw new Error(`create-pool failed:\n${create.stdout}\n${create.stderr}`)
  const pair = new PublicKey(/Pool: https:\/\/app\.meteora\.ag\/dlmm\/(\w+)/.exec(create.stdout)![1])
  const dlmm = await DLMM.create(connection, pair)

  let bridgeCostSol = 0

  const windows = Math.max(1, Math.round(minutes / WINDOW_MIN))
  const perWindowUsd = TOTAL_USD / windows
  const side = { buy: { usd: 0, fair: 0, unfilled: 0 }, sell: { usd: 0, fair: 0, unfilled: 0 } }
  let worstHigh = 0, worstLow = 0, failedTxs = 0
  const cycles: Record<string, number> = {}

  async function trade(kind: 'buy' | 'sell', usd: number) {
    for (let left = usd; left > 0.01; left -= MAX_TRADE_USD) {
      const chunk = Math.min(MAX_TRADE_USD, left)
      const forY = kind === 'sell' // selling wGRAM for SOL
      const amount = new BN(Math.round((forY ? chunk / GRAM_USD : chunk / SOL_USD) * 1e9))
      try {
        await dlmm.refetchStates()
        const binArrays = await dlmm.getBinArrayForSwap(forY, 8)
        const q = dlmm.swapQuote(amount, forY, new BN(300), binArrays, true)
        const consumed = Number(q.consumedInAmount.toString()) / 1e9
        const out = Number(q.outAmount.toString()) / 1e9
        const filledUsd = consumed * (forY ? GRAM_USD : SOL_USD)
        side[kind].unfilled += chunk - filledUsd
        if (q.consumedInAmount.isZero()) continue
        const tx = await dlmm.swap({ inToken: forY ? mint : NATIVE_MINT, outToken: forY ? NATIVE_MINT : mint, inAmount: q.consumedInAmount,
          minOutAmount: q.minOutAmount, lbPair: pair, user: trader.publicKey, binArraysPubkey: q.binArraysPubkey })
        await sendAndConfirmTransaction(connection, tx, [trader], { commitment: 'confirmed' })
        side[kind].usd += filledUsd
        // Value at the fair price of what the trader got, to measure how much worse than fair.
        side[kind].fair += forY ? out * SOL_USD : out * GRAM_USD
        const { price } = await poolPrice(dlmm)
        worstHigh = Math.max(worstHigh, price / FAIR - 1)
        worstLow = Math.min(worstLow, price / FAIR - 1)
      } catch {
        failedTxs++
        side[kind].unfilled += chunk
      }
    }
  }

  // Bridge refills in flight: they leave the wallet now and land one window later.
  const MAX_PENDING = Number(process.env.MAX_PENDING ?? 1)
  let inflight: { kind: 'in' | 'out'; amount: bigint; due: number }[] = []
  const startBridge = async (w: number) => {
    // Count what is already on its way, or the reserve would bridge back and forth.
    const w0 = await wallet(connection, dlmm, owner)
    const coming = inflight.reduce(
      (acc, p) => (p.kind === 'in' ? { ...acc, wgram: acc.wgram + BigInt(Math.floor(Number(p.amount) / FAIR)) } : { ...acc, sol: acc.sol + BigInt(Math.floor(Number(p.amount) * FAIR)) }),
      { sol: 0n, wgram: 0n },
    )
    const t = reserveTarget({ sol: w0.sol + coming.sol, wgram: w0.wgram + coming.wgram }, FAIR, MIN_CONVERT)
    if (t.bridgeIn > 0n) {
      await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: sink, lamports: t.bridgeIn })), [owner])
      inflight.push({ kind: 'in', amount: t.bridgeIn, due: w + 1 })
    } else if (t.bridgeOut > 0n) {
      await burn(connection, owner, ownerAta.address, mint, owner, t.bridgeOut)
      inflight.push({ kind: 'out', amount: t.bridgeOut, due: w + 1 })
    }
  }
  const landBridge = async (w: number) => {
    const due = inflight.filter((p) => p.due <= w)
    inflight = inflight.filter((p) => p.due > w)
    for (const p of due) await landOne(p)
  }
  const landOne = async (p: { kind: 'in' | 'out'; amount: bigint; due: number }) => {
    if (p.kind === 'in') {
      const sol = Number(p.amount) / 1e9
      const net = sol * (1 - BRIDGE_COST) - BRIDGE_FIXED_SOL
      bridgeCostSol += sol - net
      if (net > 0) await mintTo(connection, authority, mint, ownerAta.address, authority, BigInt(Math.floor((net / FAIR) * 1e9)))
    } else {
      const sol = (Number(p.amount) / 1e9) * FAIR
      const net = sol * (1 - BRIDGE_COST) - BRIDGE_FIXED_SOL
      bridgeCostSol += sol - net
      if (net > 0) await airdrop(owner.publicKey, net)
    }
    cycles.bridge = (cycles.bridge ?? 0) + 1
  }
  const bot = async () => {
    try {
      const r = await correct(connection, dlmm, owner, FAIR)
      cycles[r.side] = (cycles[r.side] ?? 0) + 1
      const h = await harvest(connection, dlmm, owner, FAIR, MIN_CONVERT)
      if (h.side !== 'none') cycles[`harvest-${h.side}`] = (cycles[`harvest-${h.side}`] ?? 0) + 1
    } catch (e) {
      console.log(`    bot error: ${(e as Error).message.split('\n')[0]}`)
    }
  }

  // Start the way mainnet will: re-centre into the concentrated core and form the reserve.
  await recenter(connection, dlmm, owner, FAIR)

  for (let w = 0; w < windows; w++) {
    const share = SCENARIO === 'buy' ? 1 : SCENARIO === 'sell' ? 0 : SCENARIO === 'roundtrip' ? (w < windows / 2 ? 1 : 0) : rand()
    for (let slice = 0; slice < 3; slice++) {
      await trade('buy', (perWindowUsd * share) / 3)
      await trade('sell', (perWindowUsd * (1 - share)) / 3)
      await bot()
      if (inflight.length < MAX_PENDING) await startBridge(w)
    }
    await landBridge(w)
    if (inflight.length < MAX_PENDING) await startBridge(w)
    if (!inflight.length && (await needsRecenter(dlmm, owner, FAIR))) {
      await recenter(connection, dlmm, owner, FAIR)
      cycles.recenter = (cycles.recenter ?? 0) + 1
    }
    if (w % Math.max(1, Math.floor(windows / 6)) === 0 || w === windows - 1) {
      const { price } = await poolPrice(dlmm)
      console.log(`    t+${String((w + 1) * WINDOW_MIN).padStart(4)}m  bought $${Math.round(side.buy.usd).toLocaleString().padStart(8)}  sold $${Math.round(side.sell.usd).toLocaleString().padStart(8)}  wGRAM ${((price / FAIR - 1) * 100).toFixed(1).padStart(5)}% vs fair  unfilled buy $${Math.round(side.buy.unfilled)} sell $${Math.round(side.sell.unfilled)}`)
    }
  }

  // Pool owner's value at the fair price: positions + wallet, minus what was given for rent.
  const { userPositions } = await dlmm.getPositionsByUserAndLbPair(owner.publicKey)
  let x = 0, y = 0
  for (const p of userPositions) {
    x += Number(p.positionData.totalXAmount) / 1e9 + Number(p.positionData.feeX.toString()) / 1e9
    y += Number(p.positionData.totalYAmount) / 1e9 + Number(p.positionData.feeY.toString()) / 1e9
  }
  const walletSol = (await connection.getBalance(owner.publicKey)) / 1e9 - RENT_SOL
  const walletWgram = Number((await getAccount(connection, ownerAta.address)).amount) / 1e9
  const ownerUsd = ((x + walletWgram) * FAIR + y + walletSol) * SOL_USD
  const pct = (s: { usd: number; fair: number }) => (s.usd ? +(((s.usd - s.fair) / s.usd) * 100).toFixed(2) : 0)
  return {
    scenario: SCENARIO,
    minutes,
    seedUsd: SEED_USD,
    boughtUsd: Math.round(side.buy.usd),
    buyUnfilledUsd: Math.round(side.buy.unfilled),
    buyCostPct: pct(side.buy),
    soldUsd: Math.round(side.sell.usd),
    sellUnfilledUsd: Math.round(side.sell.unfilled),
    sellCostPct: pct(side.sell),
    worstPct: `${(worstLow * 100).toFixed(1)}..+${(worstHigh * 100).toFixed(1)}`,
    failedTxs,
    cycles: JSON.stringify(cycles),
    bridgeCostUsd: Math.round(bridgeCostSol * SOL_USD),
    ownerValueUsd: Math.round(ownerUsd),
  }
}

const durations = process.argv.slice(2).map(Number).filter(Boolean)
const results = []
for (const minutes of durations.length ? durations : [1440]) {
  console.log(`\n${SCENARIO}: $${TOTAL_USD.toLocaleString()} over ${minutes} minutes (pool: $${SEED_USD.toLocaleString()}, ${100 - SEED_SOL_PCT}% wGRAM)`)
  results.push(await scenario(minutes))
}
console.log('\nResults (cost = how much worse than the fair price traders got; owner value = pool + wallet at fair price):')
console.table(results)
