// Refill bot core for the wGRAM/SOL DLMM pool (see create-pool.ts).
//
// Users only ever come with SOL, so net buying pulls wGRAM out of the pool, leaves SOL
// in its place and pushes wGRAM's price above GRAM's. One refill cycle:
//   1. withdraw half of the SOL buyers left below the active bin (the other half must
//      stay so step 3 has something to sell into),
//   2. convert it, plus any SOL carried from the last cycle, to wGRAM at the fair GRAM
//      price (mainnet: bridge-in.sh),
//   3. sell wGRAM back into the pool, at most down to the fair price,
//   4. put all remaining wGRAM back into the core position, and SOL only up to the
//      pool's SOL target. The sale's other SOL is carried and converted next cycle, so
//      the pool's wGRAM side is rebuilt instead of slowly turning into SOL.

import { createRequire } from 'node:module'
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import BN from 'bn.js'

const dlmmModule = createRequire(import.meta.url)('@meteora-ag/dlmm')
export const DLMM = dlmmModule.DLMM ?? dlmmModule.default ?? dlmmModule
export const { StrategyType } = dlmmModule

export const RECYCLE_BPS = 5_000 // withdraw half of the buyers' SOL per cycle
export const MIN_PREMIUM = 0.01 // act once the pool trades 1% above fair
const SOL_RESERVE = 50_000_000n // lamports kept in the owner wallet for fees and rent

export type Convert = (lamports: bigint) => Promise<bigint> // returns wGRAM (raw units) received

export const DUST_LAMPORTS = 10_000_000n // 0.01 SOL
export const RESTOCK_BINS = 4 // restock within ~1% of the price
export const MIN_CONVERT = 200_000_000n // lamports; smaller carries wait for the next cycle

export type CycleResult =
  | { action: 'idle'; premium: number }
  | { action: 'refilled'; premium: number; after: number; solConverted: bigint; wgramBought: bigint; wgramSold: bigint; solCarried: bigint }

async function send(connection: Connection, tx: Transaction, signers: Keypair[]) {
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed', skipPreflight: false })
}

export async function poolPrice(dlmm: any): Promise<{ binId: number; price: number }> {
  await dlmm.refetchStates()
  const active = await dlmm.getActiveBin()
  return { binId: active.binId, price: Number(active.pricePerToken) }
}

async function wgramBalance(connection: Connection, mint: PublicKey, owner: PublicKey): Promise<bigint> {
  return getAccount(connection, getAssociatedTokenAddressSync(mint, owner)).then((a) => a.amount, () => 0n)
}

export async function refillOnce(
  connection: Connection,
  dlmm: any,
  owner: Keypair,
  fair: number,
  convert: Convert,
  targetSol: bigint, // lamports the pool should hold on its SOL side
  minConvert: bigint = MIN_CONVERT, // smaller amounts wait: each bridge-in costs a fixed relayer fee
): Promise<CycleResult> {
  const { binId, price } = await poolPrice(dlmm)
  const premium = price / fair - 1
  const wgram: PublicKey = dlmm.lbPair.tokenXMint
  const spare = async () => BigInt(await connection.getBalance(owner.publicKey)) - SOL_RESERVE
  const carried = await spare()
  if (premium < MIN_PREMIUM && carried < minConvert) return { action: 'idle', premium }

  // 1. Withdraw half of the SOL sitting below the active bin, from every position.
  const { userPositions } = await dlmm.getPositionsByUserAndLbPair(owner.publicKey)
  // If last cycle's conversion failed, its SOL is still waiting in the wallet: convert
  // that first instead of pulling more out of the pool.
  if (premium >= MIN_PREMIUM && carried < minConvert) {
    for (const p of userPositions) {
      const { lowerBinId, upperBinId, positionBinData } = p.positionData
      const below = positionBinData
        .filter((b: any) => b.binId < binId && b.binId >= lowerBinId && b.binId <= upperBinId)
        .sort((a: any, b: any) => a.binId - b.binId)
      if (!below.some((b: any) => BigInt(b.positionYAmount) > 0n)) continue
      // Halving a bin again and again leaves dust the program refuses to touch, so only
      // runs of bins holding at least DUST_LAMPORTS are withdrawn from; dust is left alone.
      const ranges: [number, number, number][] = []
      let start: number | null = null
      for (const [i, bin] of below.entries()) {
        const real = BigInt(bin.positionYAmount) >= DUST_LAMPORTS
        if (real && start === null) start = bin.binId
        const next = below[i + 1]
        const runEnds = !real || !next || next.binId !== bin.binId + 1 || BigInt(next.positionYAmount) < DUST_LAMPORTS
        if (start !== null && runEnds) {
          ranges.push([start, real ? bin.binId : bin.binId - 1, RECYCLE_BPS])
          start = null
        }
      }
      const remove = async (from: number, to: number, bps: number) => {
        const txs: Transaction[] = await dlmm.removeLiquidity({
          user: owner.publicKey,
          position: p.publicKey,
          fromBinId: from,
          toBinId: to,
          bps: new BN(bps),
          shouldClaimAndClose: false,
        })
        for (const tx of txs) await send(connection, tx, [owner])
      }
      for (const [from, to, bps] of ranges) {
        await remove(from, to, bps).catch((e: unknown) => console.warn(`  skipped bins ${from}..${to}: ${(e as Error).message.split('\n')[0]}`))
      }
    }
  }

  // 2. Convert everything spare (this withdrawal plus last cycle's carry) to wGRAM.
  const toConvert = await spare()
  const wgramBefore = await wgramBalance(connection, wgram, owner.publicKey)
  if (toConvert >= minConvert) await convert(toConvert)
  const bought = (await wgramBalance(connection, wgram, owner.publicKey)) - wgramBefore

  // 3. Sell wGRAM into the pool, stopping at the fair price (binary search on quotes).
  await dlmm.refetchStates()
  const held = await wgramBalance(connection, wgram, owner.publicKey)
  const binArrays = await dlmm.getBinArrayForSwap(true, 8)
  const endPrice = (amount: bigint) => Number(dlmm.swapQuote(new BN(amount.toString()), true, new BN(100), binArrays, true).endPrice)
  let sell = 0n
  if ((await poolPrice(dlmm)).price > fair * (1 + MIN_PREMIUM / 2) && held > 0n) {
    let lo = 0n
    let hi = held
    if (endPrice(hi) >= fair) lo = hi
    else for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2n
      if (endPrice(mid) >= fair) lo = mid
      else hi = mid
    }
    sell = lo
  }
  if (sell > 0n) {
    const quote = dlmm.swapQuote(new BN(sell.toString()), true, new BN(100), binArrays, true)
    const tx: Transaction = await dlmm.swap({
      inToken: wgram,
      outToken: dlmm.lbPair.tokenYMint,
      inAmount: quote.consumedInAmount,
      minOutAmount: quote.minOutAmount,
      lbPair: dlmm.pubkey,
      user: owner.publicKey,
      binArraysPubkey: quote.binArraysPubkey,
    })
    await send(connection, tx, [owner])
  }

  // 4. All remaining wGRAM back into the core (lowest) position; SOL only up to target.
  await dlmm.refetchStates()
  const { binId: activeAfter, price: after } = await poolPrice(dlmm)
  const { userPositions: now } = await dlmm.getPositionsByUserAndLbPair(owner.publicKey)
  const poolSol = now.reduce((sum: bigint, p: any) => sum + BigInt(p.positionData.totalYAmount.split('.')[0]), 0n)
  // Restock the position the price sits in (or the nearest one): extra positions can sit
  // below the price (SOL added for sellers) or above it (the backstop).
  const distance = (p: any) => Math.max(0, p.positionData.lowerBinId - activeAfter, activeAfter - p.positionData.upperBinId)
  const core = now.reduce((a: any, b: any) => (distance(b) < distance(a) || (distance(b) === distance(a) && b.positionData.lowerBinId < a.positionData.lowerBinId) ? b : a))
  const { lowerBinId, upperBinId } = core.positionData
  const deficit = targetSol > poolSol ? targetSol - poolSol : 0n
  const sparesol = await spare()
  const addY = deficit > 0n && sparesol > 0n ? (deficit < sparesol ? deficit : sparesol) : 0n
  const addX = activeAfter <= upperBinId ? await wgramBalance(connection, wgram, owner.publicKey) : 0n
  // Buyers take wGRAM from the bins just above the price, so restock exactly those;
  // spreading it over the whole range would thin the bins that matter every cycle.
  if (addX > 0n) {
    const tx: Transaction = await dlmm.addLiquidityByStrategy({
      positionPubKey: core.publicKey,
      totalXAmount: new BN(addX.toString()),
      totalYAmount: new BN(0),
      strategy: { minBinId: activeAfter, maxBinId: Math.min(upperBinId, activeAfter + RESTOCK_BINS), strategyType: StrategyType.Spot, singleSidedX: true },
      user: owner.publicKey,
      slippage: 1,
    })
    await send(connection, tx, [owner])
  }
  if (addY > 0n && activeAfter > lowerBinId) {
    const tx: Transaction = await dlmm.addLiquidityByStrategy({
      positionPubKey: core.publicKey,
      totalXAmount: new BN(0),
      totalYAmount: new BN(addY.toString()),
      strategy: { minBinId: Math.max(lowerBinId, activeAfter - RESTOCK_BINS), maxBinId: activeAfter - 1, strategyType: StrategyType.Spot },
      user: owner.publicKey,
      slippage: 1,
    })
    await send(connection, tx, [owner])
  }
  return { action: 'refilled', premium, after: after / fair - 1, solConverted: toConvert >= minConvert ? toConvert : 0n, wgramBought: bought, wgramSold: sell, solCarried: await spare() }
}
