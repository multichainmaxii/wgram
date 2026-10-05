// Sets up a local chain for developing the website: stand-in wGRAM, our launchpad
// config, and demo coins at different stages (one graduated). Writes the site's
// web/.env.local so `pnpm dev` points at it. Run after `pnpm validator`.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import BN from 'bn.js'
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DynamicBondingCurveClient,
  SwapMode,
  deriveDammV2PoolAuthority,
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { GRADUATED_POOL_FEE_OPTION, launchpadCurve } from './curve.ts'

const RPC = process.env.RPC ?? 'http://127.0.0.1:11899'
const SITE = process.env.SITE_URL ?? 'http://localhost:3000'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL = join(ROOT, '.local')
const WEB = join(ROOT, 'web')
const METADATA_DIR = join(WEB, '.data', 'metadata')
const WGRAM = 10 ** 9

const DEMO = [
  { name: 'Durov Dog', symbol: 'DUROV', description: 'The dog that runs Telegram (allegedly).', buys: [900, 1400, 700, 2600] },
  { name: 'Gram Cat', symbol: 'GCAT', description: 'Paired with GRAM, purring on Solana.', buys: [300, 250, 600] },
  { name: 'Notcoin Not', symbol: 'NOTNOT', description: 'Not a coin. Definitely not.', buys: [120, 80] },
  { name: 'Ton Ape', symbol: 'TAPE', description: 'Apes together, bridged.', buys: [1500, 900, 400] },
  { name: 'Blue Check', symbol: 'BLUE', description: 'For the verified ones.', buys: [60] },
  { name: 'Graduated Gram', symbol: 'GRAD', description: 'Already graduated to a Meteora pool.', buys: [], graduate: true },
]

const connection = new Connection(RPC, 'confirmed')
const dbc = new DynamicBondingCurveClient(connection, 'confirmed')

async function send(tx: Transaction, signers: Signer[], computeUnits?: number) {
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

function loadOrCreateKeypair(name: string): Keypair {
  const path = join(LOCAL, `${name}.json`)
  if (existsSync(path)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))))
  const kp = Keypair.generate()
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)))
  return kp
}

// Same store the website's /api/metadata uses in development.
function saveMetadata(meta: { name: string; symbol: string; description: string; image: string }): string {
  const id = `${meta.symbol.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(join(METADATA_DIR, `${id}.json`), JSON.stringify(meta))
  return `${SITE}/api/metadata/${id}`
}

async function buy(trader: Keypair, pool: PublicKey, wgramAmount: number, partialFill = false) {
  const amountIn = new BN(Math.floor(wgramAmount * WGRAM).toString())
  const tx = partialFill
    ? await dbc.pool.swap2({
        owner: trader.publicKey,
        pool,
        swapBaseForQuote: false,
        referralTokenAccount: null,
        swapMode: SwapMode.PartialFill,
        amountIn,
        minimumAmountOut: new BN(0),
      })
    : await dbc.pool.swap({ owner: trader.publicKey, pool, amountIn, minimumAmountOut: new BN(0), swapBaseForQuote: false, referralTokenAccount: null })
  await send(tx, [trader])
}

async function main() {
  mkdirSync(LOCAL, { recursive: true })
  mkdirSync(METADATA_DIR, { recursive: true })
  console.log(`RPC ${RPC}`)

  const admin = loadOrCreateKeypair('admin') // mint authority of the stand-in wGRAM
  const platform = loadOrCreateKeypair('platform') // owns the config, earns fees
  const trader = Keypair.generate()
  for (const k of [admin, platform, trader]) await airdrop(k.publicKey, 100)
  await airdrop(deriveDbcPoolAuthority(), 10) // pre-funded by Meteora on mainnet
  await airdrop(deriveDammV2PoolAuthority(), 10)

  const wgram = await createMint(connection, admin, admin.publicKey, null, 9)
  const traderAta = await getOrCreateAssociatedTokenAccount(connection, admin, wgram, trader.publicKey)
  await mintTo(connection, admin, wgram, traderAta.address, admin, BigInt(100_000 * WGRAM))
  console.log(`stand-in wGRAM ${wgram.toBase58()}`)

  const config = Keypair.generate()
  await send(
    await dbc.partner.createConfig({
      config: config.publicKey,
      feeClaimer: platform.publicKey,
      leftoverReceiver: platform.publicKey,
      payer: platform.publicKey,
      quoteMint: wgram,
      ...launchpadCurve(),
    }),
    [platform, config],
  )
  console.log(`launchpad config ${config.publicKey.toBase58()}`)

  for (const coin of DEMO) {
    const creator = Keypair.generate()
    await airdrop(creator.publicKey, 2)
    const baseMint = Keypair.generate()
    const uri = saveMetadata({ name: coin.name, symbol: coin.symbol, description: coin.description, image: '' })
    await send(
      await dbc.creator.createPool({
        baseMint: baseMint.publicKey,
        config: config.publicKey,
        name: coin.name,
        symbol: coin.symbol,
        uri,
        payer: creator.publicKey,
        poolCreator: creator.publicKey,
      }),
      [creator, baseMint],
    )
    const pool = deriveDbcPoolAddress(wgram, baseMint.publicKey, config.publicKey)
    for (const amount of coin.buys) await buy(trader, pool, amount)
    if (coin.graduate) {
      await buy(trader, pool, 8_000, true) // fills to the threshold, refunds the rest
      const mig = await dbc.migration.migrateToDammV2({
        pool,
        dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[GRADUATED_POOL_FEE_OPTION],
        payer: platform.publicKey,
      })
      await send(mig.transaction, [platform, mig.firstPositionNftKeypair, mig.secondPositionNftKeypair], 1_000_000)
    }
    console.log(`  ${coin.symbol}  ${baseMint.publicKey.toBase58()}${coin.graduate ? '  (graduated)' : ''}`)
  }

  writeFileSync(
    join(WEB, '.env.local'),
    [
      '# Written by launchpad/scripts/seed-local.ts',
      'NEXT_PUBLIC_NETWORK=localnet',
      `NEXT_PUBLIC_RPC=${RPC}`,
      `NEXT_PUBLIC_CONFIG=${config.publicKey.toBase58()}`,
      `NEXT_PUBLIC_WGRAM_MINT=${wgram.toBase58()}`,
      'NEXT_PUBLIC_GRAM_USD=1.51',
      `NEXT_PUBLIC_SITE_URL=${SITE}`,
      '# Local-only faucet signer (mints stand-in wGRAM). Never set this on devnet/mainnet.',
      `DEV_ADMIN_KEYPAIR=${join(LOCAL, 'admin.json')}`,
      '',
    ].join('\n'),
  )
  console.log(`\nwrote ${join(WEB, '.env.local')}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
