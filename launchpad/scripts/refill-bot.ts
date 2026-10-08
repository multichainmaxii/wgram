// Mainnet runner for the refill bot (core logic in refill.ts). Every --interval seconds
// it compares the wGRAM/SOL pool's price with the fair GRAM price (a live NEAR Intents
// quote) and, when the pool trades at a premium or SOL has piled up, recycles that SOL
// into wGRAM through contracts/scripts/bridge-in.sh and restocks the pool.
//
// Watch-only by default: it logs what it would do and sends nothing. --live acts.
//
//   pnpm refill-bot --rpc <url> --owner-keypair <buyback.json> --wgram <mint> \
//     --near-account <id> --near-key-file <path> --target-sol <n> [--min-convert 1] [--interval 60] [--live]
//
// The owner wallet pays SOL into bridge-in and receives the wGRAM. The NEAR account pays
// NEAR gas and the Omni relayer fee (~0.07 NEAR per cycle), so keep a few NEAR on it.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { DLMM, MIN_PREMIUM, poolPrice, refillOnce } from './refill.ts'

const dlmmModule = createRequire(import.meta.url)('@meteora-ag/dlmm')
const PRESET = new PublicKey('w1rfAh2zApVM55NnpEUxZL5L9EjP4RyAyhjwHraLBQE') // same tier as create-pool
const BRIDGE_IN = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts/scripts/bridge-in.sh')
const ONECLICK = 'https://1click.chaindefuser.com/v0'
const GRAM_ASSET = 'nep245:v2_1.omni.hot.tg:1117_'
const SOL_ASSET = 'nep141:sol.omft.near'

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    rpc: { type: 'string' },
    'owner-keypair': { type: 'string' },
    wgram: { type: 'string' },
    'near-account': { type: 'string' },
    'near-key-file': { type: 'string' },
    'target-sol': { type: 'string' },
    'min-convert': { type: 'string', default: '1' }, // SOL
    interval: { type: 'string', default: '60' },
    live: { type: 'boolean', default: false },
    once: { type: 'boolean', default: false },
  },
})

const log = (msg: string) => console.log(`${new Date().toISOString()}  ${msg}`)
const fromInvocation = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path)

function loadKeypair(path: string): Keypair {
  if (!existsSync(path)) throw new Error(`no keypair file at ${path}`)
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))))
}

// Fair price in SOL per wGRAM: what 1 SOL actually buys on NEAR Intents right now.
async function fairPrice(nearAccount: string, refundTo: string): Promise<number> {
  const deadline = new Date(Date.now() + 3_600_000).toISOString()
  const res = await fetch(`${ONECLICK}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 100,
      originAsset: SOL_ASSET, depositType: 'ORIGIN_CHAIN', destinationAsset: GRAM_ASSET, amount: '1000000000',
      recipient: nearAccount, recipientType: 'INTENTS', refundTo, refundType: 'ORIGIN_CHAIN', deadline,
    }),
  })
  if (!res.ok) throw new Error(`NEAR Intents quote failed (${res.status})`)
  const out = Number((await res.json()).quote.amountOut) / 1e9 // GRAM per SOL
  if (!(out > 0)) throw new Error('NEAR Intents returned no GRAM for 1 SOL')
  return 1 / out
}

// Runs bridge-in.sh for this many lamports, unattended. It waits until the wGRAM is on Solana.
function bridgeIn(lamports: bigint, env: NodeJS.ProcessEnv): Promise<bigint> {
  const sol = (Number(lamports) / 1e9).toFixed(9)
  log(`bridge-in ${sol} SOL`)
  return new Promise((ok, fail) => {
    const child = spawn('bash', [BRIDGE_IN, sol], { env: { ...process.env, ...env, YES: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d) => process.stdout.write(`    ${d}`))
    child.stderr.on('data', (d) => process.stdout.write(`    ${d}`))
    child.on('exit', (code) => (code === 0 ? ok(0n) : fail(new Error(`bridge-in exited with ${code}; it resumes from its saved state next cycle`))))
  })
}

async function main() {
  const { rpc, 'owner-keypair': ownerPath, wgram: wgramArg, 'near-account': nearAccount, 'near-key-file': nearKey, 'target-sol': targetArg } = args
  if (!rpc || !ownerPath || !wgramArg || !nearAccount || !nearKey || !targetArg) {
    throw new Error('usage: pnpm refill-bot --rpc <url> --owner-keypair <path> --wgram <mint> --near-account <id> --near-key-file <path> --target-sol <n> [--interval 60] [--live] [--once]')
  }
  const ownerFile = fromInvocation(ownerPath)
  const owner = loadKeypair(ownerFile)
  const wgram = new PublicKey(wgramArg)
  const targetSol = BigInt(Math.round(Number(targetArg) * 1e9))
  const minConvert = BigInt(Math.round(Number(args['min-convert']) * 1e9))
  const connection = new Connection(rpc, 'confirmed')
  const [pair] = dlmmModule.deriveLbPairWithPresetParamWithIndexKey(PRESET, wgram, NATIVE_MINT, new PublicKey(dlmmModule.LBCLMM_PROGRAM_IDS['mainnet-beta']))
  while (!(await connection.getAccountInfo(pair))) {
    log(`waiting: no wGRAM/SOL pool at ${pair.toBase58()} yet (create-pool makes it)`)
    if (args.once) return
    await new Promise((r) => setTimeout(r, Number(args.interval) * 1000))
  }
  const dlmm = await DLMM.create(connection, pair)
  const env = { NEAR_ACCOUNT: nearAccount, NEAR_KEY_FILE: fromInvocation(nearKey), SOL_KEYPAIR: ownerFile, SOL_RECIPIENT: owner.publicKey.toBase58() }
  const convert = (lamports: bigint) => bridgeIn(lamports, env)

  log(`refill-bot ${args.live ? 'LIVE' : 'WATCH-ONLY (add --live to act)'}: pool ${pair.toBase58()}, owner ${owner.publicKey.toBase58()}`)
  for (;;) {
    try {
      const fair = await fairPrice(nearAccount, owner.publicKey.toBase58())
      const { price } = await poolPrice(dlmm)
      const premium = price / fair - 1
      const spare = BigInt(await connection.getBalance(owner.publicKey))
      const status = `pool ${price.toPrecision(5)} vs fair ${fair.toPrecision(5)} SOL/wGRAM (${(premium * 100).toFixed(2)}%), owner ${(Number(spare) / 1e9).toFixed(3)} SOL`
      if (!args.live) {
        const act = premium >= MIN_PREMIUM || spare > minConvert + 50_000_000n
        log(`${status}${act ? '  -> would refill' : ''}`)
      } else {
        const r = await refillOnce(connection, dlmm, owner, fair, convert, targetSol, minConvert)
        log(r.action === 'idle' ? `${status}  idle`
          : `${status}  refilled: converted ${Number(r.solConverted) / 1e9} SOL, sold ${Number(r.wgramSold) / 1e9} wGRAM, now ${(r.after * 100).toFixed(2)}%, carrying ${Number(r.solCarried) / 1e9} SOL`)
      }
    } catch (e) {
      log(`error: ${(e as Error).message.split('\n')[0]}`)
    }
    if (args.once) return
    await new Promise((r) => setTimeout(r, Number(args.interval) * 1000))
  }
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`)
  process.exitCode = 1
})
