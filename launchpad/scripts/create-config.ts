// Creates our Meteora bonding-curve config on a network. Every coin launched on the
// site uses it: priced in wGRAM, with the curve and fees from curve.ts. The platform
// wallet pays for it and becomes its fee claimer (see claim-fees.ts).
//
// Dry run by default: checks the wGRAM mint, simulates the transaction and prints the
// result. Only --send creates the config. Runbook: DEPLOY.md.
//
//   pnpm create-config --rpc <url> --wgram <mint> --platform-keypair <path> [--send]

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  VersionedTransaction,
  sendAndConfirmTransaction,
  type Signer,
  type Transaction,
} from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, unpackMint, type Mint } from '@solana/spl-token'
import type BN from 'bn.js'
import { DynamicBondingCurveClient, PROTOCOL_FEE_PERCENT } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CREATOR_FEE_SHARE_PCT, INITIAL_MCAP_WGRAM, LAUNCH_FEE_SOL, MIGRATION_MCAP_WGRAM, TRADING_FEE_BPS, WGRAM_DECIMALS, launchpadCurve } from './curve.ts'

const USAGE = 'usage: pnpm create-config --rpc <url> --wgram <mint> --platform-keypair <path> [--send]'

// Genesis hashes of the public clusters, so the output says where it is writing.
const CLUSTERS: Record<string, string> = {
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet',
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: 'devnet',
}

class Abort extends Error {}
function fail(message: string): never {
  throw new Abort(message)
}

function readArgs() {
  try {
    return parseArgs({
      args: process.argv.slice(2).filter((a) => a !== '--'), // pnpm can pass a bare `--` through
      options: {
        rpc: { type: 'string' },
        wgram: { type: 'string' },
        'platform-keypair': { type: 'string' },
        send: { type: 'boolean', default: false },
      },
    }).values
  } catch (e) {
    return fail(`${(e as Error).message}\n${USAGE}`)
  }
}

function address(value: string, flag: string): PublicKey {
  try {
    return new PublicKey(value)
  } catch {
    return fail(`${flag} ${value} is not a valid address`)
  }
}

// pnpm runs scripts from launchpad/, so relative paths are taken from where it was invoked.
const fromInvocation = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path)

function loadKeypair(path: string): Keypair {
  if (!existsSync(path)) fail(`no keypair file at ${path}`)
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))))
  } catch {
    // Parse errors can quote the file's contents, so they are never printed.
    return fail(`${path} is not a JSON keypair (64 numbers, as written by solana-keygen)`)
  }
}

// API keys often sit in the RPC URL's path or query, so only the host is printed.
const rpcHost = (rpc: string) => new URL(rpc).host

async function clusterName(connection: Connection, rpc: string) {
  try {
    return CLUSTERS[await connection.getGenesisHash()] ?? 'local or private cluster'
  } catch (e) {
    return fail(`can't reach the RPC at ${rpcHost(rpc)}: ${(e as Error).message}`)
  }
}

// Omni Bridge mints wGRAM as a classic SPL token with 9 decimals; the curve assumes both.
async function checkWgramMint(connection: Connection, mint: PublicKey): Promise<Mint> {
  const info = await connection.getAccountInfo(mint)
  if (!info) fail(`wGRAM mint ${mint.toBase58()} does not exist on this network`)
  if (!info.owner.equals(TOKEN_PROGRAM_ID)) {
    fail(`${mint.toBase58()} is owned by ${info.owner.toBase58()}, not the classic SPL Token program ${TOKEN_PROGRAM_ID.toBase58()}`)
  }
  let parsed: Mint
  try {
    parsed = unpackMint(mint, info, TOKEN_PROGRAM_ID)
  } catch {
    return fail(`${mint.toBase58()} is not a token mint`)
  }
  if (!parsed.isInitialized) fail(`mint ${mint.toBase58()} is not initialized`)
  if (parsed.decimals !== WGRAM_DECIMALS) fail(`${mint.toBase58()} has ${parsed.decimals} decimals; wGRAM has ${WGRAM_DECIMALS}`)
  return parsed
}

async function simulate(connection: Connection, tx: Transaction, signers: Signer[]) {
  tx.feePayer = signers[0].publicKey
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
  const signed = new VersionedTransaction(tx.compileMessage())
  signed.sign(signers)
  return (await connection.simulateTransaction(signed, { sigVerify: true })).value
}

const fmt = (raw: bigint | BN | number, decimals = WGRAM_DECIMALS) =>
  (Number(raw.toString()) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: 4 })

function printEnv(config: PublicKey, wgram: PublicKey) {
  console.log('\nWebsite env for this network (see DEPLOY.md):')
  console.log(`NEXT_PUBLIC_CONFIG=${config.toBase58()}`)
  console.log(`NEXT_PUBLIC_WGRAM_MINT=${wgram.toBase58()}`)
}

async function main() {
  const { rpc, wgram: wgramArg, 'platform-keypair': keypairArg, send } = readArgs()
  if (!rpc || !wgramArg || !keypairArg) fail(USAGE)
  if (!URL.canParse(rpc) || !/^https?:$/.test(new URL(rpc).protocol)) fail('--rpc must be an http(s) URL')
  const wgram = address(wgramArg, '--wgram')
  const keypairPath = fromInvocation(keypairArg)
  const platform = loadKeypair(keypairPath)
  const connection = new Connection(rpc, 'confirmed')
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed')

  console.log(send ? 'create-config: SEND' : 'create-config: DRY RUN (simulates only; add --send to create the config)')
  console.log(`  network   ${await clusterName(connection, rpc)} (${rpcHost(rpc)})`)

  const mint = await checkWgramMint(connection, wgram)
  console.log(`  wGRAM     ${wgram.toBase58()}  classic SPL Token, ${mint.decimals} decimals, supply ${fmt(mint.supply)}`)
  console.log(`            mint authority ${mint.mintAuthority?.toBase58() ?? 'none'}, freeze authority ${mint.freezeAuthority?.toBase58() ?? 'none'}`)

  // Saved next to the platform keypair, so a re-run finds the config it already made
  // instead of creating a second one.
  const configPath = join(dirname(keypairPath), `${basename(keypairPath, '.json')}-config.json`)
  const saved = existsSync(configPath) ? loadKeypair(configPath) : null
  const config = saved ?? Keypair.generate()
  if (saved && (await connection.getAccountInfo(config.publicKey))) {
    const existing = await dbc.state.getPoolConfig(config.publicKey).catch(() => null)
    if (!existing?.quoteMint.equals(wgram) || !existing.feeClaimer.equals(platform.publicKey)) {
      fail(
        `${config.publicKey.toBase58()} (keypair ${configPath}) already exists here, but not as a config for this ` +
          'wGRAM mint and platform. Move that file aside to create a new config.',
      )
    }
    console.log(`\nConfig ${config.publicKey.toBase58()} already exists on this network (keypair ${configPath}); nothing to do.`)
    printEnv(config.publicKey, wgram)
    return
  }

  const rent = await connection.getMinimumBalanceForRentExemption(dbc.state.getProgram().account.poolConfig.size)
  const needed = rent + 10_000 // plus two signatures
  const balance = await connection.getBalance(platform.publicKey)
  console.log(`  platform  ${platform.publicKey.toBase58()}  ${fmt(balance, 9)} SOL (pays ${fmt(rent, 9)} SOL rent, then claims the fees)`)
  if (balance < needed) console.log(`            needs at least ${needed / LAMPORTS_PER_SOL} SOL: fund it before --send`)
  console.log(`  config    ${saved ? `${config.publicKey.toBase58()}  (keypair ${configPath})` : `new keypair, saved to ${configPath} by --send`}`)

  const curve = launchpadCurve()
  console.log('\nCurve (scripts/curve.ts)')
  console.log(`  launch market cap   ${INITIAL_MCAP_WGRAM.toLocaleString()} wGRAM`)
  console.log(`  graduates at        ${MIGRATION_MCAP_WGRAM.toLocaleString()} wGRAM market cap, once ${fmt(curve.migrationQuoteThreshold)} wGRAM is raised`)
  console.log(`  trading fee         ${TRADING_FEE_BPS / 100}% in wGRAM; Meteora keeps ${PROTOCOL_FEE_PERCENT}%, creators get ${CREATOR_FEE_SHARE_PCT}% of the rest`)
  console.log(`  launch fee          ${LAUNCH_FEE_SOL} SOL per coin`)

  const tx = await dbc.partner.createConfig({
    config: config.publicKey,
    feeClaimer: platform.publicKey,
    leftoverReceiver: platform.publicKey,
    payer: platform.publicKey,
    quoteMint: wgram,
    ...curve,
  })
  const sim = await simulate(connection, tx, [platform, config])
  if (sim.err) {
    console.log(`\nSimulation FAILED: ${JSON.stringify(sim.err)}`)
    for (const line of (sim.logs ?? []).slice(-12)) console.log(`  ${line}`)
    fail(send ? 'nothing was sent' : 'fix the error above before sending')
  }
  console.log(`\nSimulation OK (${sim.unitsConsumed?.toLocaleString() ?? '?'} compute units)`)
  if (!send) {
    console.log('Dry run only: nothing was sent. Re-run with --send to create the config.')
    return
  }

  if (!saved) {
    writeFileSync(configPath, JSON.stringify(Array.from(config.secretKey)), { mode: 0o600, flag: 'wx' })
    console.log(`Saved the config keypair to ${configPath}`)
  }
  try {
    console.log(`Sent: ${await sendAndConfirmTransaction(connection, tx, [platform, config], { commitment: 'confirmed' })}`)
  } catch (e) {
    // A confirmation timeout doesn't mean it failed; only give up if the config isn't there.
    if (!(await connection.getAccountInfo(config.publicKey))) {
      fail(`${(e as Error).message}\nThe config isn't on chain. Re-running is safe: it reuses ${configPath}, so it can't create a duplicate.`)
    }
    console.log('Confirmation timed out, but the config account exists.')
  }

  const onchain = await dbc.state.getPoolConfig(config.publicKey)
  if (!onchain?.quoteMint.equals(wgram) || !onchain.feeClaimer.equals(platform.publicKey)) {
    fail(`config ${config.publicKey.toBase58()} on chain doesn't match what was sent`)
  }
  console.log(`\nCreated config ${config.publicKey.toBase58()}`)
  console.log(`  quote mint ${onchain.quoteMint.toBase58()} (wGRAM), fee claimer ${onchain.feeClaimer.toBase58()}`)
  console.log(`  graduation at ${fmt(onchain.migrationQuoteThreshold)} wGRAM raised, launch fee ${fmt(onchain.poolCreationFee, 9)} SOL`)
  printEnv(config.publicKey, wgram)
}

main().catch((e) => {
  console.error(e instanceof Abort ? `\nerror: ${e.message}` : e)
  process.exitCode = 1
})
