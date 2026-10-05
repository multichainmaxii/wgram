// Claims the platform's fees from every coin launched under our config: its share of
// trading fees (in wGRAM) and of each coin's launch fee (in SOL), one transaction per
// coin. The platform keypair must be the config's fee claimer. Half of the wGRAM trading
// fees claimed goes on to the ecosystem buyback wallet (BUYBACK_SHARE_PCT in curve.ts).
//
// Dry run by default: lists what's claimable and simulates each claim. Only --send
// claims. Safe to re-run, since only unclaimed fees are picked up. Runbook: DEPLOY.md.
//
//   pnpm claim-fees --rpc <url> --config <address> --platform-keypair <path> --buyback <address> [--send]

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  Transaction,
  VersionedTransaction,
  sendAndConfirmTransaction,
  type Signer,
} from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token'
import type BN from 'bn.js'
import {
  DynamicBondingCurveClient,
  PROTOCOL_POOL_CREATION_FEE_PERCENT,
  U64_MAX,
  deriveMintMetadata,
  getTokenProgram,
  type VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { BUYBACK_SHARE_PCT } from './curve.ts'

const USAGE = 'usage: pnpm claim-fees --rpc <url> --config <address> --platform-keypair <path> --buyback <address> [--send]'

// Set in a pool's creationFeeBits once the partner has claimed its share of the launch
// fee (PARTNER_CREATION_FEE_CLAIMED_MASK in Meteora's program).
const PARTNER_CREATION_FEE_CLAIMED = 0b10

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
        config: { type: 'string' },
        'platform-keypair': { type: 'string' },
        buyback: { type: 'string' },
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

async function simulate(connection: Connection, tx: Transaction, signers: Signer[]) {
  tx.feePayer = signers[0].publicKey
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
  const signed = new VersionedTransaction(tx.compileMessage())
  signed.sign(signers)
  return (await connection.simulateTransaction(signed, { sigVerify: true })).value
}

const fmt = (raw: bigint | BN | number, decimals: number) =>
  (Number(raw.toString()) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: 6 })
const signed = (raw: bigint, decimals: number) => `${raw < 0n ? '-' : '+'}${fmt(raw < 0n ? -raw : raw, decimals)}`

// Metaplex metadata: key, update authority and mint (65 bytes), then the borsh
// strings name and symbol.
function symbolOf(data: Buffer): string {
  try {
    const nameLength = data.readUInt32LE(65)
    const symbolLength = data.readUInt32LE(69 + nameLength)
    return data.subarray(73 + nameLength, 73 + nameLength + symbolLength).toString('utf8').replace(/\0/g, '').trim() || '?'
  } catch {
    return '?'
  }
}

async function symbols(connection: Connection, mints: PublicKey[]): Promise<string[]> {
  const out: string[] = []
  for (let i = 0; i < mints.length; i += 100) {
    const infos = await connection.getMultipleAccountsInfo(mints.slice(i, i + 100).map((mint) => deriveMintMetadata(mint)))
    out.push(...infos.map((info) => (info ? symbolOf(info.data) : '?')))
  }
  return out
}

type Claim = { pool: PublicKey; state: VirtualPool['poolState']; trading: bigint; creation: bigint }

async function main() {
  const { rpc, config: configArg, 'platform-keypair': keypairArg, buyback: buybackArg, send } = readArgs()
  if (!rpc || !configArg || !keypairArg || !buybackArg) fail(USAGE)
  const buyback = address(buybackArg, '--buyback')
  if (!URL.canParse(rpc) || !/^https?:$/.test(new URL(rpc).protocol)) fail('--rpc must be an http(s) URL')
  const configAddress = address(configArg, '--config')
  const keypairPath = fromInvocation(keypairArg)
  const platform = loadKeypair(keypairPath)
  const connection = new Connection(rpc, 'confirmed')
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed')

  console.log(send ? 'claim-fees: SEND' : 'claim-fees: DRY RUN (simulates only; add --send to claim)')
  console.log(`  network   ${await clusterName(connection, rpc)} (${rpcHost(rpc)})`)

  const config = await dbc.state.getPoolConfig(configAddress).catch(() => null)
  if (!config) fail(`no launchpad config at ${configAddress.toBase58()} on this network`)
  if (!config.feeClaimer.equals(platform.publicKey)) {
    fail(`${keypairPath} is ${platform.publicKey.toBase58()}, but the config's fee claimer is ${config.feeClaimer.toBase58()}`)
  }
  const quoteProgram = getTokenProgram(config.quoteTokenFlag)
  const baseProgram = getTokenProgram(config.tokenType)
  const { decimals } = await getMint(connection, config.quoteMint, 'confirmed', quoteProgram)
  const quoteAta = getAssociatedTokenAddressSync(config.quoteMint, platform.publicKey, true, quoteProgram)
  const balances = async () => ({
    wgram: await getAccount(connection, quoteAta, 'confirmed', quoteProgram).then((a) => a.amount, () => 0n),
    sol: BigInt(await connection.getBalance(platform.publicKey)),
  })
  const before = await balances()
  console.log(`  config    ${configAddress.toBase58()}`)
  console.log(`  wGRAM     ${config.quoteMint.toBase58()}`)
  console.log(`  platform  ${platform.publicKey.toBase58()}  (fee claimer; ${fmt(before.wgram, decimals)} wGRAM, ${fmt(before.sol, 9)} SOL)`)
  if (before.sol === 0n) console.log('            has no SOL for network fees: fund it first')
  if (buyback.equals(platform.publicKey)) fail('--buyback must be a different wallet from the platform')
  console.log(`  buyback   ${buyback.toBase58()}  (gets ${BUYBACK_SHARE_PCT}% of claimed trading fees)`)

  // Meteora keeps a fixed share of each launch fee; ours is what's left.
  const creationFee = BigInt(config.poolCreationFee.toString())
  const ourCreationFee = creationFee - (creationFee * BigInt(PROTOCOL_POOL_CREATION_FEE_PERCENT)) / 100n
  const pools = await dbc.state.getPoolsByConfig(configAddress)
  const claims: Claim[] = pools
    .map(({ publicKey, account: { poolState: state } }) => ({
      pool: publicKey,
      state,
      trading: BigInt(state.partnerQuoteFee.toString()),
      creation: state.creationFeeBits & PARTNER_CREATION_FEE_CLAIMED ? 0n : ourCreationFee,
    }))
    .filter((c) => c.trading > 0n || c.creation > 0n)
    .sort((a, b) => (a.trading === b.trading ? 0 : a.trading > b.trading ? -1 : 1))

  const totalTrading = claims.reduce((sum, c) => sum + c.trading, 0n)
  const totalCreation = claims.reduce((sum, c) => sum + c.creation, 0n)
  console.log(`\n${pools.length} coin(s) under this config, ${claims.length} with fees to claim:`)
  console.log(`  ${fmt(totalTrading, decimals)} wGRAM in trading fees from ${claims.filter((c) => c.trading > 0n).length} coin(s), ${fmt((totalTrading * BigInt(BUYBACK_SHARE_PCT)) / 100n, decimals)} of it for the buyback`)
  console.log(`  ${fmt(totalCreation, 9)} SOL in launch fees from ${claims.filter((c) => c.creation > 0n).length} coin(s)`)
  if (claims.length === 0) return

  const claimTx = async (c: Claim) => {
    const tx = new Transaction()
    if (c.trading > 0n) {
      const claim = await dbc.partner.claimPartnerTradingFee({
        feeClaimer: platform.publicKey,
        payer: platform.publicKey,
        pool: c.pool,
        maxBaseAmount: U64_MAX,
        maxQuoteAmount: U64_MAX,
      })
      tx.add(...claim.instructions)
      // The SDK opens our token account for the coin in case there are fees in it. This
      // config only charges fees in wGRAM, so close the account again in the same
      // transaction and get its rent (~0.002 SOL per coin) back.
      const baseAta = getAssociatedTokenAddressSync(c.state.baseMint, platform.publicKey, true, baseProgram)
      const opensBaseAta = claim.instructions.some((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && ix.keys[1]?.pubkey.equals(baseAta))
      if (opensBaseAta && c.state.partnerBaseFee.isZero()) tx.add(createCloseAccountInstruction(baseAta, platform.publicKey, platform.publicKey, [], baseProgram))
    }
    if (c.creation > 0n) tx.add(...(await dbc.partner.claimPartnerPoolCreationFee({ pool: c.pool, feeReceiver: platform.publicKey })).instructions)
    return tx
  }

  const names = await symbols(connection, claims.map((c) => c.state.baseMint))
  let failed = 0
  console.log('')
  for (const [i, c] of claims.entries()) {
    const line = `  ${names[i].padEnd(10)} ${c.pool.toBase58().padEnd(44)} ${fmt(c.trading, decimals).padStart(14)} wGRAM ${fmt(c.creation, 9).padStart(8)} SOL`
    try {
      const tx = await claimTx(c)
      if (send) {
        console.log(`${line}  claimed ${await sendAndConfirmTransaction(connection, tx, [platform], { commitment: 'confirmed' })}`)
        continue
      }
      const sim = await simulate(connection, tx, [platform])
      console.log(`${line}  ${sim.err ? `simulation FAILED: ${JSON.stringify(sim.err)}` : 'simulated OK'}`)
      if (sim.err) {
        failed++
        for (const log of (sim.logs ?? []).slice(-8)) console.log(`      ${log}`)
      }
    } catch (e) {
      failed++
      const error = e instanceof SendTransactionError ? e.transactionError : { message: (e as Error).message.split('\n')[0], logs: [] }
      console.log(`${line}  FAILED: ${error.message}`)
      for (const log of (error.logs ?? []).slice(-8)) console.log(`      ${log}`)
    }
  }

  if (!send) {
    if (failed) fail(`${failed} of ${claims.length} simulation(s) failed`)
    console.log('\nDry run only: nothing was sent. Re-run with --send to claim.')
    return
  }
  // Pass the buyback's share of what actually arrived (not of what was listed) to its wallet.
  const claimed = (await balances()).wgram - before.wgram
  const toBuyback = claimed > 0n ? (claimed * BigInt(BUYBACK_SHARE_PCT)) / 100n : 0n
  if (toBuyback > 0n) {
    const buybackAta = getAssociatedTokenAddressSync(config.quoteMint, buyback, true, quoteProgram)
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(platform.publicKey, buybackAta, buyback, config.quoteMint, quoteProgram),
      createTransferCheckedInstruction(quoteAta, config.quoteMint, buybackAta, platform.publicKey, toBuyback, decimals, [], quoteProgram),
    )
    const sig = await sendAndConfirmTransaction(connection, tx, [platform], { commitment: 'confirmed' })
    console.log(`\nSent ${fmt(toBuyback, decimals)} wGRAM (${BUYBACK_SHARE_PCT}% of ${fmt(claimed, decimals)} claimed) to the buyback wallet: ${sig}`)
  }
  const after = await balances()
  console.log(`\nClaimed from ${claims.length - failed} of ${claims.length} coin(s).`)
  console.log(`  platform wGRAM  ${fmt(before.wgram, decimals)} -> ${fmt(after.wgram, decimals)}  (${signed(after.wgram - before.wgram, decimals)}, after the buyback share)`)
  console.log(`  platform SOL    ${fmt(before.sol, 9)} -> ${fmt(after.sol, 9)}  (${signed(after.sol - before.sol, 9)}: launch fees, less network fees and new account rent)`)
  if (failed) fail(`${failed} of ${claims.length} claim(s) failed; re-running retries only what is still unclaimed`)
}

main().catch((e) => {
  console.error(e instanceof Abort ? `\nerror: ${e.message}` : e)
  process.exitCode = 1
})
