// Stress test of the wGRAM/SOL pool plus refill bot on the local validator (DLMM cloned
// from mainnet). Each scenario: a fresh stand-in wGRAM and pool seeded like mainnet
// ($900 of wGRAM + $100 of SOL, core + backstop via create-pool), then $TOTAL_USD of
// SOL buys spread over DURATION minutes in 5-minute windows. After each window the refill
// bot runs once (its NEAR Intents + bridge leg is simulated at 0.55% + $0.32 per cycle).
//
//   RPC=http://127.0.0.1:11899 pnpm exec tsx scripts/stress-pool.ts [minutes...]   (default 1440 360 60)

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { NATIVE_MINT, createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import BN from 'bn.js'
import { DLMM, poolPrice, refillOnce } from './refill.ts'

const RPC = process.env.RPC ?? 'http://127.0.0.1:11899'
const TOTAL_USD = Number(process.env.TOTAL_USD ?? 250_000)
const SOL_USD = 126
const GRAM_USD = 1.54
const FAIR = GRAM_USD / SOL_USD // SOL per wGRAM
const SEED_USD = Number(process.env.SEED_USD ?? 1_000) // 90% wGRAM, 10% SOL
const SEED_WGRAM = (SEED_USD * 0.9) / GRAM_USD
const SEED_SOL = (SEED_USD * 0.1) / SOL_USD
const MAX_BUY_USD = 1_000 // one swap per $1k, like many separate traders
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
  await mintTo(connection, authority, mint, ownerAta.address, authority, BigInt(Math.round(SEED_WGRAM * 1e9)))
  const ownerFile = join(dir, `owner-${minutes}.json`)
  writeFileSync(ownerFile, JSON.stringify(Array.from(owner.secretKey)))

  const create = spawnSync('pnpm', ['exec', 'tsx', 'scripts/create-pool.ts', '--rpc', RPC, '--owner-keypair', ownerFile,
    '--wgram', mint.toBase58(), '--wgram-amount', SEED_WGRAM.toFixed(6), '--sol-amount', SEED_SOL.toFixed(6),
    '--price', FAIR.toString(), '--send'], { encoding: 'utf8' })
  if (create.status !== 0) throw new Error(`create-pool failed:\n${create.stdout}\n${create.stderr}`)
  const pair = new PublicKey(/Pool: https:\/\/app\.meteora\.ag\/dlmm\/(\w+)/.exec(create.stdout)![1])
  const dlmm = await DLMM.create(connection, pair)

  // Simulated bridge-in: the SOL leaves the owner wallet; wGRAM arrives at the fair price, less costs.
  let bridgeCostSol = 0
  const convert = async (lamports: bigint) => {
    await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: sink, lamports })), [owner])
    const sol = Number(lamports) / 1e9
    const net = sol * (1 - BRIDGE_COST) - BRIDGE_FIXED_SOL
    bridgeCostSol += sol - net
    const wgram = BigInt(Math.max(0, Math.floor((net / FAIR) * 1e9)))
    await mintTo(connection, authority, mint, ownerAta.address, authority, wgram)
    return wgram
  }

  const windows = Math.max(1, Math.round(minutes / WINDOW_MIN))
  const perWindowUsd = TOTAL_USD / windows
  let spentSol = 0, gotWgram = 0, unfilledUsd = 0, maxPremium = 0, cycles = 0, failedTxs = 0
  for (let w = 0; w < windows; w++) {
    for (let left = perWindowUsd; left > 0.01; left -= MAX_BUY_USD) {
      const usd = Math.min(MAX_BUY_USD, left)
      const lamports = new BN(Math.round((usd / SOL_USD) * 1e9))
      try {
        await dlmm.refetchStates()
        const binArrays = await dlmm.getBinArrayForSwap(false, 8)
        const q = dlmm.swapQuote(lamports, false, new BN(300), binArrays, true)
        const consumed = Number(q.consumedInAmount.toString()) / 1e9
        if (consumed * SOL_USD < usd * 0.999) unfilledUsd += usd - consumed * SOL_USD
        if (q.consumedInAmount.isZero()) continue
        const tx = await dlmm.swap({ inToken: NATIVE_MINT, outToken: mint, inAmount: q.consumedInAmount, minOutAmount: q.minOutAmount,
          lbPair: pair, user: trader.publicKey, binArraysPubkey: q.binArraysPubkey })
        await sendAndConfirmTransaction(connection, tx, [trader], { commitment: 'confirmed' })
        spentSol += consumed
        gotWgram += Number(q.outAmount.toString()) / 1e9
        if (process.env.DEBUG) {
          const before = Number((await dlmm.getActiveBin()).pricePerToken)
          console.log(`      buy $${usd.toFixed(0)}: paid ${((consumed / (Number(q.outAmount.toString()) / 1e9) / FAIR - 1) * 100).toFixed(2)}% over fair; quote fee ${(Number(q.fee.toString()) / 1e9).toFixed(5)} SOL; price now ${((before / FAIR - 1) * 100).toFixed(2)}%`)
        }
        const { price } = await poolPrice(dlmm)
        maxPremium = Math.max(maxPremium, price / FAIR - 1)
      } catch (e) {
        failedTxs++
        unfilledUsd += usd
      }
    }
    try {
      const r = await refillOnce(connection, dlmm, owner, FAIR, convert, BigInt(Math.round(SEED_SOL * 1e9)))
      if (r.action === 'refilled') cycles++
      if (process.env.DEBUG) {
        const { userPositions } = await dlmm.getPositionsByUserAndLbPair(owner.publicKey)
        const comp = userPositions.map((p: any) => `[${p.positionData.lowerBinId}..${p.positionData.upperBinId}] X ${(Number(p.positionData.totalXAmount) / 1e9).toFixed(1)} Y ${(Number(p.positionData.totalYAmount) / 1e9).toFixed(3)}`).join('  ')
        const ab = await dlmm.getActiveBin()
        console.log(`    bot: ${JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? Number(v) / 1e9 : v))}\n    active ${ab.binId} ${((Number(ab.pricePerToken) / FAIR - 1) * 100).toFixed(2)}%  ${comp}`)
      }
    } catch (e) {
      console.log(`    bot error in window ${w}: ${(e as Error).message.split('\n')[0]}`)
    }
    if (w % Math.max(1, Math.floor(windows / 6)) === 0 || w === windows - 1) {
      const { price } = await poolPrice(dlmm)
      console.log(`    t+${String((w + 1) * WINDOW_MIN).padStart(4)}m  bought $${Math.round(spentSol * SOL_USD).toLocaleString().padStart(8)}  wGRAM price ${((price / FAIR - 1) * 100).toFixed(1).padStart(5)}% vs fair  unfilled $${Math.round(unfilledUsd).toLocaleString()}`)
    }
  }

  // Value check for the pool owner: everything it holds, at the fair price.
  const { userPositions } = await dlmm.getPositionsByUserAndLbPair(owner.publicKey)
  let x = 0, y = 0
  for (const p of userPositions) {
    x += Number(p.positionData.totalXAmount) / 1e9 + Number(p.positionData.feeX.toString()) / 1e9
    y += Number(p.positionData.totalYAmount) / 1e9 + Number(p.positionData.feeY.toString()) / 1e9
  }
  const wallet = (await connection.getBalance(owner.publicKey)) / 1e9 - RENT_SOL // rent is not part of the pool's value
  const ownerUsd = (x * FAIR + y + wallet) * SOL_USD + 0
  const vwapPremium = spentSol / (gotWgram * FAIR) - 1
  const { price } = await poolPrice(dlmm)
  return {
    minutes,
    filledUsd: Math.round(spentSol * SOL_USD),
    unfilledUsd: Math.round(unfilledUsd),
    failedTxs,
    avgPremiumPct: +(vwapPremium * 100).toFixed(2),
    maxPremiumPct: +(maxPremium * 100).toFixed(1),
    endPremiumPct: +((price / FAIR - 1) * 100).toFixed(1),
    botCycles: cycles,
    bridgeCostUsd: Math.round(bridgeCostSol * SOL_USD),
    seedUsd: SEED_USD,
    ownerValueUsd: Math.round(ownerUsd),
  }
}

const durations = process.argv.slice(2).map(Number).filter(Boolean)
const results = []
for (const minutes of durations.length ? durations : [1440, 360, 60]) {
  console.log(`\n$${TOTAL_USD.toLocaleString()} of SOL buys over ${minutes} minutes (pool: $${SEED_USD.toLocaleString()}, 90% wGRAM)`)
  results.push(await scenario(minutes))
}
console.log('\nResults (owner value = pool + wallet at fair price, started at ~$1,000 plus rent):')
console.table(results)
