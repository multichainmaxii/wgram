// Market maker for the wGRAM/SOL DLMM pool: keeps the pool at the fair GRAM price for
// traders who come with SOL, both ways, without them ever waiting on a bridge.
//
//   - Reserve: part of the money sits in the owner wallet as wGRAM + SOL. Every cycle the
//     bot trades from it against the pool, straight back to the fair price: buyers drained
//     wGRAM (price above fair), so sell reserve wGRAM in; sellers drained SOL (price below
//     fair), so buy wGRAM with reserve SOL. That takes seconds.
//   - Bridges (bridge-in.sh / bridge-out.sh) only refill the reserve, in the background, when
//     one side of it runs heavy. Traders never wait for them.
//   - Concentrated core: one position across ±CORE_HALF bins (~±9%) around the fair price,
//     shaped as a Curve so most liquidity sits within a few percent of fair and thins toward
//     the edges (no gap before the backstop). Re-centered when GRAM/SOL moves; the backstop
//     positions above it stay.

import { createRequire } from 'node:module'
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import BN from 'bn.js'

const dlmmModule = createRequire(import.meta.url)('@meteora-ag/dlmm')
export const DLMM = dlmmModule.DLMM ?? dlmmModule.default ?? dlmmModule
const { StrategyType } = dlmmModule

export const BIN_STEP = 25 // basis points per bin, the pool's tier
export const CORE_HALF = 34 // bins each side of fair: 1.0025^34 ≈ ±9% (one position holds 69 bins)
export const TOLERANCE = 0.005 // leave the price alone within ±0.5% of fair
export const RESERVE_SHARE = Number(process.env.RESERVE_SHARE ?? 0.3) // of everything the owner holds, kept in the wallet
const CORE_SHAPE = process.env.CORE_SHAPE === 'spot' ? 'Spot' : 'Curve'
const SOL_RESERVE = 50_000_000n // lamports always left for fees and rent
const DUST = 1_000n // raw units below which nothing is moved

const send = (c: Connection, tx: Transaction, signers: Keypair[]) => sendAndConfirmTransaction(c, tx, signers, { commitment: 'confirmed' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function poolPrice(dlmm: any): Promise<{ binId: number; price: number }> {
  await dlmm.refetchStates()
  const active = await dlmm.getActiveBin()
  return { binId: active.binId, price: Number(active.pricePerToken) }
}

export function fairBin(fair: number): number {
  return DLMM.getBinIdFromPrice(DLMM.getPricePerLamport(9, 9, fair), BIN_STEP, false)
}

export type Wallet = { sol: bigint; wgram: bigint } // spare SOL (above the fee reserve) and wGRAM

export async function wallet(connection: Connection, dlmm: any, owner: Keypair): Promise<Wallet> {
  const mint: PublicKey = dlmm.lbPair.tokenXMint
  const sol = BigInt(await connection.getBalance(owner.publicKey, 'confirmed')) - SOL_RESERVE
  const wgram = await getAccount(connection, getAssociatedTokenAddressSync(mint, owner.publicKey), 'confirmed').then((a) => a.amount, () => 0n)
  return { sol: sol > 0n ? sol : 0n, wgram }
}

// RPC nodes can lag a few seconds behind a confirmed transaction; wait until the wallet moves.
async function settled(connection: Connection, dlmm: any, owner: Keypair, before: Wallet): Promise<Wallet> {
  let now = await wallet(connection, dlmm, owner)
  for (let i = 0; i < 15 && now.sol === before.sol && now.wgram === before.wgram; i++) {
    await sleep(2_000)
    now = await wallet(connection, dlmm, owner)
  }
  return now
}

export async function positions(dlmm: any, owner: Keypair): Promise<any[]> {
  return (await dlmm.getPositionsByUserAndLbPair(owner.publicKey)).userPositions
}

export async function holdings(dlmm: any, owner: Keypair): Promise<{ x: bigint; y: bigint }> {
  let x = 0n
  let y = 0n
  for (const p of await positions(dlmm, owner)) {
    x += BigInt(String(p.positionData.totalXAmount).split('.')[0])
    y += BigInt(String(p.positionData.totalYAmount).split('.')[0])
  }
  return { x, y }
}

// Trades reserve funds against the pool until its price is back at fair (within
// TOLERANCE). Returns what was traded and the price afterwards.
export async function correct(connection: Connection, dlmm: any, owner: Keypair, fair: number) {
  const { price } = await poolPrice(dlmm)
  const gap = price / fair - 1
  if (Math.abs(gap) <= TOLERANCE) return { side: 'none' as const, amount: 0n, gap, after: gap }
  const sellWgram = gap > 0 // too expensive: sell wGRAM in; too cheap: buy wGRAM with SOL
  const funds = await wallet(connection, dlmm, owner)
  const budget = sellWgram ? funds.wgram : funds.sol
  if (budget <= DUST) return { side: sellWgram ? ('sell' as const) : ('buy' as const), amount: 0n, gap, after: gap }

  const binArrays = await dlmm.getBinArrayForSwap(sellWgram, 8)
  const quote = (amount: bigint) => dlmm.swapQuote(new BN(amount.toString()), sellWgram, new BN(100), binArrays, true)
  const reachesFair = (amount: bigint) => {
    const end = Number(quote(amount).endPrice)
    return sellWgram ? end <= fair : end >= fair
  }
  // Smallest amount that gets back to fair, or the whole budget if even that falls short.
  let amount = budget
  if (reachesFair(budget)) {
    let lo = 0n
    let hi = budget
    for (let i = 0; i < 28 && hi - lo > DUST; i++) {
      const mid = (lo + hi) / 2n
      if (reachesFair(mid)) hi = mid
      else lo = mid
    }
    amount = hi
  }
  const q = quote(amount)
  if (q.consumedInAmount.isZero()) return { side: sellWgram ? ('sell' as const) : ('buy' as const), amount: 0n, gap, after: gap }
  const tx: Transaction = await dlmm.swap({
    inToken: sellWgram ? dlmm.lbPair.tokenXMint : dlmm.lbPair.tokenYMint,
    outToken: sellWgram ? dlmm.lbPair.tokenYMint : dlmm.lbPair.tokenXMint,
    inAmount: q.consumedInAmount,
    minOutAmount: q.minOutAmount,
    lbPair: dlmm.pubkey,
    user: owner.publicKey,
    binArraysPubkey: q.binArraysPubkey,
  })
  await send(connection, tx, [owner])
  await settled(connection, dlmm, owner, funds)
  const after = (await poolPrice(dlmm)).price / fair - 1
  return { side: sellWgram ? ('sell' as const) : ('buy' as const), amount: BigInt(q.consumedInAmount.toString()), gap, after }
}

// What the reserve should convert so it holds half its value in each asset. Only amounts
// worth at least minConvert lamports are worth a bridge trip.
export function reserveTarget(w: Wallet, fair: number, minConvert: bigint): { bridgeIn: bigint; bridgeOut: bigint } {
  const solValue = Number(w.sol)
  const wgramValue = Number(w.wgram) * fair
  const excess = (solValue - wgramValue) / 2 // lamports
  if (excess >= Number(minConvert)) return { bridgeIn: BigInt(Math.floor(excess)), bridgeOut: 0n }
  if (-excess >= Number(minConvert)) return { bridgeIn: 0n, bridgeOut: BigInt(Math.floor(-excess / fair)) }
  return { bridgeIn: 0n, bridgeOut: 0n }
}

// Backstop positions sit entirely above the core; everything else is core.
const isBackstop = (p: any, fBin: number) => p.positionData.lowerBinId > fBin + CORE_HALF

// True when the price has drifted out of the core band, or the band no longer centres on fair.
export async function needsRecenter(dlmm: any, owner: Keypair, fair: number): Promise<boolean> {
  const fBin = fairBin(fair)
  const core = (await positions(dlmm, owner)).filter((p) => !isBackstop(p, fBin))
  if (core.length !== 1) return true
  const { lowerBinId, upperBinId } = core[0].positionData
  const centre = (lowerBinId + upperBinId) / 2
  return upperBinId - lowerBinId !== 2 * CORE_HALF || Math.abs(centre - fBin) > 8 // ~2% off-centre
}

// Pulls all core liquidity (closing those positions and getting their rent back), then
// puts (1 - RESERVE_SHARE) of everything into one fresh Curve-shaped core around the
// current price (call correct() first so that is fair): SOL below, wGRAM above. The rest
// stays in the wallet as the reserve.
export async function recenter(connection: Connection, dlmm: any, owner: Keypair, fair: number) {
  const fBin = fairBin(fair)
  const before = await wallet(connection, dlmm, owner)
  for (const p of await positions(dlmm, owner)) {
    if (isBackstop(p, fBin)) continue
    const { lowerBinId, upperBinId } = p.positionData
    const txs: Transaction[] = await dlmm.removeLiquidity({
      user: owner.publicKey,
      position: p.publicKey,
      fromBinId: lowerBinId,
      toBinId: upperBinId,
      bps: new BN(10_000),
      shouldClaimAndClose: true,
    })
    for (const tx of txs) await send(connection, tx, [owner])
  }
  const funds = await settled(connection, dlmm, owner, before)
  const { binId } = await poolPrice(dlmm)
  const keep = 1 - RESERVE_SHARE
  const x = BigInt(Math.floor(Number(funds.wgram) * keep))
  const y = BigInt(Math.floor(Number(funds.sol) * keep)) - 200_000_000n // rent for the new position
  const position = Keypair.generate()
  const tx: Transaction = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey,
    totalXAmount: new BN((x > 0n ? x : 0n).toString()),
    totalYAmount: new BN((y > 0n ? y : 0n).toString()),
    strategy: { minBinId: binId - CORE_HALF, maxBinId: binId + CORE_HALF, strategyType: StrategyType[CORE_SHAPE] },
    user: owner.publicKey,
    slippage: 1,
  })
  await send(connection, tx, [owner, position])
  return { position: position.publicKey, x, y }
}

// Moves the pool's surplus side into the reserve: net buying leaves the pool SOL-heavy
// (buyers' SOL below the price), net selling leaves it wGRAM-heavy. Withdraws from the heavy
// side's bins, nearest the price first, until the pool is back to half its value in each.
export async function harvest(connection: Connection, dlmm: any, owner: Keypair, fair: number, minConvert: bigint) {
  const { x, y } = await holdings(dlmm, owner)
  const excess = (Number(y) - Number(x) * fair) / 2 // lamports of SOL over half the value
  if (Math.abs(excess) < Number(minConvert)) return { side: 'none' as const, amount: 0n }
  const solHeavy = excess > 0
  const { binId } = await poolPrice(dlmm)
  const before = await wallet(connection, dlmm, owner)
  // Share of the heavy side's total to pull, capped at half so the price can still move.
  const heavyTotal = solHeavy ? Number(y) : Number(x) * fair
  const bps = Math.min(5_000, Math.ceil((Math.abs(excess) / heavyTotal) * 10_000))
  for (const p of await positions(dlmm, owner)) {
    const { lowerBinId, upperBinId, positionBinData } = p.positionData
    const bins = positionBinData
      .filter((b: any) => (solHeavy ? b.binId < binId : b.binId > binId) && BigInt(solHeavy ? b.positionYAmount : b.positionXAmount) >= DUST * 1000n)
      .map((b: any) => b.binId)
    if (!bins.length) continue
    const from = Math.max(lowerBinId, Math.min(...bins))
    const to = Math.min(upperBinId, Math.max(...bins))
    const txs: Transaction[] = await dlmm
      .removeLiquidity({ user: owner.publicKey, position: p.publicKey, fromBinId: from, toBinId: to, bps: new BN(bps), shouldClaimAndClose: false })
      .catch(() => [])
    for (const tx of txs) await send(connection, tx, [owner]).catch(() => undefined)
  }
  const after = await settled(connection, dlmm, owner, before)
  return { side: solHeavy ? ('sol' as const) : ('wgram' as const), amount: solHeavy ? after.sol - before.sol : after.wgram - before.wgram }
}
