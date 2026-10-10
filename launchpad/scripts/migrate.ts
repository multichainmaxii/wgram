// Graduates finished coins: moves every completed curve under our config into its Meteora
// DAMM v2 pool (COIN/wGRAM, liquidity locked). Meteora's own keepers only do this for quote
// tokens on their list (SOL, USDC, JUP and a few more) or Jupiter-verified tokens with an
// Organic Score above 50, which wGRAM isn't yet, so mm-bot runs this every cycle. Anyone may
// call the migration; the payer covers the new pool's rent (a few hundredths of a SOL). If
// Meteora's keeper gets there first, ours simply finds nothing left to do.
//
// Dry run by default (lists what would graduate). --send migrates.
//
//   pnpm migrate-graduated --rpc <url> --config <address> --payer-keypair <path> [--send]

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js'
import { DAMM_V2_MIGRATION_FEE_ADDRESS, DynamicBondingCurveClient, deriveDammV2PoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { GRADUATED_POOL_FEE_OPTION } from './curve.ts'

export type Graduation = { pool: string; mint: string; dammPool: string; signature?: string; error?: string }

// Migrating creates the DAMM v2 pool and two locked positions in one transaction.
const MIGRATION_COMPUTE_UNITS = 1_000_000

export async function migrateGraduated(connection: Connection, payer: Keypair, config: PublicKey, send: boolean): Promise<Graduation[]> {
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
  const poolConfig = await dbc.state.getPoolConfig(config)
  if (!poolConfig) throw new Error(`launchpad config ${config.toBase58()} not found`)
  const threshold = BigInt(poolConfig.migrationQuoteThreshold.toString())
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[GRADUATED_POOL_FEE_OPTION]
  const ready = (await dbc.state.getPoolsByConfig(config)).filter(
    ({ account: { poolState: s } }) => Number(s.isMigrated) === 0 && BigInt(s.quoteReserve.toString()) >= threshold,
  )

  const results: Graduation[] = []
  for (const { publicKey: pool, account: { poolState: s } } of ready) {
    const g: Graduation = { pool: pool.toBase58(), mint: s.baseMint.toBase58(), dammPool: deriveDammV2PoolAddress(dammConfig, s.baseMint, poolConfig.quoteMint).toBase58() }
    if (send) {
      try {
        const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await dbc.migration.migrateToDammV2({ pool, dammConfig, payer: payer.publicKey })
        if (!transaction.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId))) {
          transaction.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: MIGRATION_COMPUTE_UNITS }))
        }
        transaction.feePayer = payer.publicKey
        g.signature = await sendAndConfirmTransaction(connection, transaction, [payer, firstPositionNftKeypair, secondPositionNftKeypair], { commitment: 'confirmed' })
      } catch (e) {
        g.error = (e as Error).message.split('\n')[0]
      }
    }
    results.push(g)
  }
  return results
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: { rpc: { type: 'string' }, config: { type: 'string' }, 'payer-keypair': { type: 'string' }, send: { type: 'boolean', default: false } },
  })
  if (!values.rpc || !values.config || !values['payer-keypair']) {
    throw new Error('usage: pnpm migrate-graduated --rpc <url> --config <address> --payer-keypair <path> [--send]')
  }
  const path = resolve(process.env.INIT_CWD ?? process.cwd(), values['payer-keypair'])
  if (!existsSync(path)) throw new Error(`no keypair file at ${path}`)
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))))
  const connection = new Connection(values.rpc, 'confirmed')
  console.log(values.send ? 'migrate-graduated: SEND' : 'migrate-graduated: DRY RUN (add --send to migrate)')
  const results = await migrateGraduated(connection, payer, new PublicKey(values.config), values.send)
  if (results.length === 0) console.log('No finished curves waiting to graduate.')
  for (const r of results) {
    console.log(`  ${r.mint}  ->  DAMM v2 ${r.dammPool}  ${r.signature ? `migrated (${r.signature})` : r.error ? `FAILED: ${r.error}` : 'would migrate'}`)
  }
  if (results.some((r) => r.error)) process.exitCode = 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`error: ${(e as Error).message}`)
    process.exitCode = 1
  })
}
