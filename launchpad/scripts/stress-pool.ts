// Stress test of the wGRAM/SOL pool plus refill bot on the local validator (DLMM cloned
// from mainnet). Each scenario: a fresh stand-in wGRAM and pool seeded like mainnet
// (SEED_USD, 90% wGRAM / 10% SOL, core + backstop via create-pool), then TOTAL_USD of
// trading spread over DURATION minutes in 5-minute windows. After each window the bot runs
// one rebalanceOnce cycle; its bridge legs are simulated at 0.55% + $0.32 per cycle.
//
// Scenarios (SCENARIO): buy (all SOL buys), sell (all sells to SOL), roundtrip (buys,
// then the same amount sold), mixed (each window a random split of buys and sells).
//
//   SCENARIO=mixed RPC=http://127.0.0.1:11899 pnpm exec tsx scripts/stress-pool.ts [minutes...]

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { NATIVE_MINT, burn, createMint, getAccount, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import BN from 'bn.js'
import { DLMM, poolPrice, rebalanceOnce } from './refill.ts'

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
const WINDOW_MIN = 5
const RENT_SOL = 0.5 // pool and position rent plus fees, on top of the seed
const BRIDGE_COST = 0.0055 // NEAR Intents spread + fees
const BRIDGE_FIXED_SOL = 0.32 / SOL_USD // Omni relayer fee per cycle

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
    '--wgram', mint.toBase58(), '--wgram-amount', SEED_WGRAM.toFixed(6), '--sol-amount', SEED_SOL.toFixed(6),
    '--price', FAIR.toString(), '--send'], { encoding: 'utf8' })
  if (create.status !== 0) throw new Error(`create-pool failed:\n${create.stdout}\n${create.stderr}`)
  const pair = new PublicKey(/Pool: https:\/\/app\.meteora\.ag\/dlmm\/(\w+)/.exec(create.stdout)![1])
  const dlmm = await DLMM.create(connection, pair)

  // Simulated bridges at the fair price, less costs.
  let bridgeCostSol = 0
  const convertIn = async (lamports: bigint) => {
    await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: sink, lamports })), [owner])
    const sol = Number(lamports) / 1e9
    const net = sol * (1 - BRIDGE_COST) - BRIDGE_FIXED_SOL
    bridgeCostSol += sol - net
    const wgram = BigInt(Math.max(0, Math.floor((net / FAIR) * 1e9)))
    await mintTo(connection, authority, mint, ownerAta.address, authority, wgram)
    return wgram
  }
  const convertOut = async (wgramRaw: bigint) => {
    await burn(connection, owner, ownerAta.address, mint, owner, wgramRaw)
    const sol = (Number(wgramRaw) / 1e9) * FAIR
    const net = sol * (1 - BRIDGE_COST) - BRIDGE_FIXED_SOL
    bridgeCostSol += sol - net
    if (net > 0) await airdrop(owner.publicKey, net)
  }

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

  for (let w = 0; w < windows; w++) {
    const share = SCENARIO === 'buy' ? 1 : SCENARIO === 'sell' ? 0 : SCENARIO === 'roundtrip' ? (w < windows / 2 ? 1 : 0) : rand()
    await trade('buy', perWindowUsd * share)
    await trade('sell', perWindowUsd * (1 - share))
    try {
      const r = await rebalanceOnce(connection, dlmm, owner, FAIR, convertIn, convertOut, BigInt(Math.round(SEED_SOL * 1e9)))
      cycles[r.direction] = (cycles[r.direction] ?? 0) + 1
    } catch (e) {
      console.log(`    bot error in window ${w}: ${(e as Error).message.split('\n')[0]}`)
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
