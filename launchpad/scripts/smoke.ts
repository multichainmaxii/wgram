// Launchpad smoke test on a local validator running Meteora's mainnet programs
// (start it with `pnpm validator`). Several creators launch coins paired with a
// stand-in wGRAM, traders buy and sell across all of them, one coin graduates
// into a DAMM v2 pool, and platform and creator fees are claimed.
//
// The stand-in wGRAM matches what Omni Bridge mints on Solana: a classic SPL token
// with 9 decimals. On mainnet, set QUOTE_MINT to the real wGRAM mint instead.

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  type Signer,
} from '@solana/web3.js'
import { createMint, getAccount, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import BN from 'bn.js'
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DynamicBondingCurveClient,
  SwapMode,
  deriveDammV2PoolAddress,
  deriveDammV2PoolAuthority,
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { GRADUATED_POOL_FEE_OPTION, launchpadCurve } from './curve.ts'

const RPC = process.env.RPC ?? 'http://127.0.0.1:11899'
const CREATORS = Number(process.env.CREATORS ?? 5)
const TRADERS = Number(process.env.TRADERS ?? 8)
const TRADES = Number(process.env.TRADES ?? 60)

const WGRAM = 10 ** 9
const connection = new Connection(RPC, 'confirmed')
const dbc = new DynamicBondingCurveClient(connection, 'confirmed')

let failures = 0
function check(ok: boolean, what: string) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) failures++
}

async function send(tx: Transaction, signers: Signer[], computeUnits?: number) {
  // Only add a compute budget if the SDK didn't; a duplicate is rejected.
  const hasBudget = tx.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId))
  if (computeUnits && !hasBudget) tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }))
  tx.feePayer = signers[0].publicKey
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' })
}

async function airdrop(to: PublicKey, sol: number) {
  const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL)
  const bh = await connection.getLatestBlockhash()
  await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed')
}

async function tokenBalance(mint: PublicKey, owner: PublicKey): Promise<bigint> {
  try {
    return (await getAccount(connection, getAssociatedTokenAddressSync(mint, owner, true))).amount
  } catch {
    return 0n
  }
}

const fmt = (raw: bigint | BN, decimals = 9) => (Number(raw.toString()) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: 4 })
const rand = (min: number, max: number) => min + Math.random() * (max - min)
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]

async function main() {
  console.log(`RPC ${RPC}  (cluster version ${(await connection.getVersion())['solana-core']})`)

  // ---- Actors ----
  const admin = Keypair.generate() // stands in for Omni's mint authority
  const platform = Keypair.generate() // our launchpad: owns the config, earns fees
  const creators = Array.from({ length: CREATORS }, () => Keypair.generate())
  const traders = Array.from({ length: TRADERS }, () => Keypair.generate())
  for (const k of [admin, platform, ...creators, ...traders]) await airdrop(k.publicKey, 100)
  // On mainnet Meteora pre-funds these authorities (68.6 and 175 SOL today) to pay
  // rent when a curve graduates into a DAMM v2 pool. Mirror that locally.
  await airdrop(deriveDbcPoolAuthority(), 10)
  await airdrop(deriveDammV2PoolAuthority(), 10)

  // ---- Stand-in wGRAM ----
  console.log('\n1. Stand-in wGRAM (classic SPL, 9 decimals)')
  const wgram = await createMint(connection, admin, admin.publicKey, null, 9)
  for (const t of traders) {
    const ata = await getOrCreateAssociatedTokenAccount(connection, admin, wgram, t.publicKey)
    await mintTo(connection, admin, wgram, ata.address, admin, BigInt(50_000 * WGRAM))
  }
  console.log(`  mint ${wgram.toBase58()}, 50,000 wGRAM to each of ${TRADERS} traders`)

  // ---- Platform config priced in wGRAM ----
  console.log('\n2. Launchpad config priced in wGRAM')
  const curve = launchpadCurve()
  const threshold = BigInt(curve.migrationQuoteThreshold.toString())
  const config = Keypair.generate()
  await send(
    await dbc.partner.createConfig({
      config: config.publicKey,
      feeClaimer: platform.publicKey,
      leftoverReceiver: platform.publicKey,
      payer: platform.publicKey,
      quoteMint: wgram,
      ...curve,
    }),
    [platform, config],
  )
  const onchainConfig = await dbc.state.getPoolConfig(config.publicKey)
  check(onchainConfig?.quoteMint.equals(wgram) ?? false, `config ${config.publicKey.toBase58().slice(0, 8)}… is priced in wGRAM`)
  console.log(`  graduation needs ${fmt(threshold)} wGRAM raised on a curve`)

  // ---- Many launches ----
  console.log(`\n3. ${CREATORS} creators launch coins paired with wGRAM`)
  const pools: { pool: PublicKey; mint: PublicKey; creator: Keypair; symbol: string }[] = []
  for (const [i, creator] of creators.entries()) {
    const baseMint = Keypair.generate()
    const symbol = `GRAMCOIN${i + 1}`
    const solBefore = await connection.getBalance(creator.publicKey)
    await send(
      await dbc.creator.createPool({
        baseMint: baseMint.publicKey,
        config: config.publicKey,
        name: `Gram Coin ${i + 1}`,
        symbol,
        uri: 'https://example.com/metadata.json',
        payer: creator.publicKey,
        poolCreator: creator.publicKey,
      }),
      [creator, baseMint],
    )
    const cost = (solBefore - (await connection.getBalance(creator.publicKey))) / LAMPORTS_PER_SOL
    const pool = deriveDbcPoolAddress(wgram, baseMint.publicKey, config.publicKey)
    pools.push({ pool, mint: baseMint.publicKey, creator, symbol })
    console.log(`  ${symbol}: pool ${pool.toBase58().slice(0, 8)}…, launch cost ${cost.toFixed(4)} SOL`)
  }
  check((await dbc.state.getPoolsByConfig(config.publicKey)).length === CREATORS, `all ${CREATORS} pools exist under our config`)

  // ---- Random trading across all curves ----
  console.log(`\n4. ${TRADES} random buys and sells across all curves`)
  let buys = 0
  let sells = 0
  let badTrades = 0
  for (let n = 0; n < TRADES; n++) {
    const trader = pick(traders)
    const target = pick(pools.slice(1)) // pool 0 is reserved for graduation below
    const held = await tokenBalance(target.mint, trader.publicKey)
    const isSell = held > 0n && Math.random() < 0.35
    const amountIn = isSell ? (held * BigInt(Math.floor(rand(20, 100)))) / 100n : BigInt(Math.floor(rand(5, 800) * WGRAM))
    const [inMint, outMint] = isSell ? [target.mint, wgram] : [wgram, target.mint]
    const inBefore = await tokenBalance(inMint, trader.publicKey)
    const outBefore = await tokenBalance(outMint, trader.publicKey)
    try {
      await send(
        await dbc.pool.swap({
          owner: trader.publicKey,
          pool: target.pool,
          amountIn: new BN(amountIn.toString()),
          minimumAmountOut: new BN(0),
          swapBaseForQuote: isSell,
          referralTokenAccount: null,
        }),
        [trader],
      )
      const spent = inBefore - (await tokenBalance(inMint, trader.publicKey))
      const got = (await tokenBalance(outMint, trader.publicKey)) - outBefore
      if (spent !== amountIn || got <= 0n) badTrades++
      isSell ? sells++ : buys++
    } catch (e) {
      badTrades++
      console.log(`  trade failed: ${(e as Error).message.split('\n')[0]}`)
    }
  }
  check(badTrades === 0, `${buys} buys and ${sells} sells settled exactly (${badTrades} bad)`)
  for (const p of pools.slice(1)) {
    const progress = await dbc.state.getPoolQuoteTokenCurveProgress(p.pool)
    console.log(`  ${p.symbol}: ${(progress * 100).toFixed(1)}% of the way to graduation`)
  }

  // ---- Graduation ----
  console.log(`\n5. Push ${pools[0].symbol} to graduation and migrate to a DAMM v2 pool`)
  const grad = pools[0]
  const whale = traders[0]
  for (let i = 0; i < 20; i++) {
    const vp = await dbc.state.getPool(grad.pool)
    if (!vp) throw new Error('graduating pool missing')
    const raised = BigInt(vp.poolState.quoteReserve.toString())
    if (raised >= threshold) break
    // An exact-in buy larger than what's left on the curve is rejected
    // (InsufficientLiquidity), so the graduating buy must use PartialFill: it fills up
    // to the threshold and refunds the rest. The launchpad UI has to do the same.
    const need = ((threshold - raised) * 110n) / 100n + BigInt(WGRAM)
    const whaleBefore = await tokenBalance(wgram, whale.publicKey)
    await send(
      await dbc.pool.swap2({
        owner: whale.publicKey,
        pool: grad.pool,
        swapBaseForQuote: false,
        referralTokenAccount: null,
        swapMode: SwapMode.PartialFill,
        amountIn: new BN(need.toString()),
        minimumAmountOut: new BN(0),
      }),
      [whale],
    )
    const spent = whaleBefore - (await tokenBalance(wgram, whale.publicKey))
    console.log(`  graduating buy: offered ${fmt(need)} wGRAM, spent ${fmt(spent)} (rest refunded)`)
  }
  const before = await dbc.state.getPool(grad.pool)
  check(BigInt(before!.poolState.quoteReserve.toString()) >= threshold, `curve raised ${fmt(BigInt(before!.poolState.quoteReserve.toString()))} wGRAM (threshold ${fmt(threshold)})`)

  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[GRADUATED_POOL_FEE_OPTION]
  const mig = await dbc.migration.migrateToDammV2({ pool: grad.pool, dammConfig, payer: platform.publicKey })
  await send(mig.transaction, [platform, mig.firstPositionNftKeypair, mig.secondPositionNftKeypair], 1_000_000)
  const after = await dbc.state.getPool(grad.pool)
  check(Number(after!.poolState.isMigrated) === 1, `${grad.symbol} is marked migrated`)
  const dammPool = deriveDammV2PoolAddress(dammConfig, grad.mint, wgram)
  const dammInfo = await connection.getAccountInfo(dammPool)
  check(dammInfo !== null, `DAMM v2 pool ${dammPool.toBase58().slice(0, 8)}… exists (${grad.symbol}/wGRAM)`)

  // ---- Fees ----
  console.log('\n6. Claim trading fees in wGRAM')
  const platformBefore = await tokenBalance(wgram, platform.publicKey)
  for (const p of pools) {
    try {
      await send(
        await dbc.partner.claimPartnerTradingFee({
          feeClaimer: platform.publicKey,
          payer: platform.publicKey,
          pool: p.pool,
          maxBaseAmount: new BN('18446744073709551615'),
          maxQuoteAmount: new BN('18446744073709551615'),
        }),
        [platform],
      )
    } catch (e) {
      console.log(`  platform claim on ${p.symbol} failed: ${(e as Error).message.split('\n')[0]}`)
    }
  }
  const platformEarned = (await tokenBalance(wgram, platform.publicKey)) - platformBefore
  check(platformEarned > 0n, `platform earned ${fmt(platformEarned)} wGRAM in trading fees`)

  const c = pools[1]
  const creatorBefore = await tokenBalance(wgram, c.creator.publicKey)
  await send(
    await dbc.creator.claimCreatorTradingFee({
      creator: c.creator.publicKey,
      payer: c.creator.publicKey,
      pool: c.pool,
      maxBaseAmount: new BN('18446744073709551615'),
      maxQuoteAmount: new BN('18446744073709551615'),
    }),
    [c.creator],
  )
  const creatorEarned = (await tokenBalance(wgram, c.creator.publicKey)) - creatorBefore
  check(creatorEarned > 0n, `creator of ${c.symbol} earned ${fmt(creatorEarned)} wGRAM`)

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
