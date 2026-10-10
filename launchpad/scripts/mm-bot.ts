// Mainnet runner for the market maker (mm.ts). Every --interval seconds it:
//   1. corrects the pool back to the fair GRAM price from the wallet reserve (seconds),
//   2. moves the pool's surplus side into the reserve when the pool is lopsided,
//   3. starts a bridge to rebalance the reserve if none is running (bridge-in.sh /
//      bridge-out.sh, in the background: the loop keeps correcting meanwhile),
//   4. re-centres the core when GRAM/SOL has moved and no bridge is running,
//   5. graduates finished coins under --config into their Meteora pools (migrate.ts), since
//      Meteora's keepers don't yet do it for coins paired with wGRAM.
//
// Watch-only by default: it logs what it would do and sends nothing. --live acts.
//
//   pnpm mm-bot --rpc <url> --owner-keypair <buyback.json> --wgram <mint> \
//     --near-account <id> --near-key-file <path> [--config <launchpad config>] [--min-convert 1] [--interval 30] [--live]

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { DLMM, TOLERANCE, correct, harvest, holdings, needsRecenter, poolPrice, recenter, reserveTarget, wallet } from './mm.ts'
import { migrateGraduated } from './migrate.ts'

const dlmmModule = createRequire(import.meta.url)('@meteora-ag/dlmm')
const PRESET = new PublicKey('w1rfAh2zApVM55NnpEUxZL5L9EjP4RyAyhjwHraLBQE') // same tier as create-pool
const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts/scripts')
const ONECLICK = 'https://1click.chaindefuser.com/v0'

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    rpc: { type: 'string' },
    'owner-keypair': { type: 'string' },
    wgram: { type: 'string' },
    'near-account': { type: 'string' },
    'near-key-file': { type: 'string' },
    config: { type: 'string' }, // the launchpad's bonding-curve config; enables graduations
    'min-convert': { type: 'string', default: '1' }, // SOL; smaller bridge trips aren't worth the fee
    interval: { type: 'string', default: '30' },
    live: { type: 'boolean', default: false },
    once: { type: 'boolean', default: false },
  },
})

const log = (msg: string) => console.log(`${new Date().toISOString()}  ${msg}`)
const fromInvocation = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path)
const loadKeypair = (path: string) => {
  if (!existsSync(path)) throw new Error(`no keypair file at ${path}`)
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))))
}

// Fair price in SOL per wGRAM: what 1 SOL buys on NEAR Intents right now.
async function fairPrice(nearAccount: string, refundTo: string): Promise<number> {
  const res = await fetch(`${ONECLICK}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 100,
      originAsset: 'nep141:sol.omft.near', depositType: 'ORIGIN_CHAIN', destinationAsset: 'nep245:v2_1.omni.hot.tg:1117_',
      amount: '1000000000', recipient: nearAccount, recipientType: 'INTENTS', refundTo, refundType: 'ORIGIN_CHAIN',
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  })
  if (!res.ok) throw new Error(`NEAR Intents quote failed (${res.status})`)
  const out = Number((await res.json()).quote.amountOut) / 1e9
  if (!(out > 0)) throw new Error('NEAR Intents returned no GRAM for 1 SOL')
  return 1 / out
}

// Every bridge trip pays NEAR gas and Omni's relayer fee (about 0.06 NEAR), so a dry NEAR
// account silently stops all bridging. Checked every 10 minutes; warns below LOW_NEAR.
const LOW_NEAR = 1.5
let nearCheckedAt = 0
async function warnIfLowNear(nearAccount: string) {
  if (Date.now() - nearCheckedAt < 10 * 60_000) return
  nearCheckedAt = Date.now()
  const res = await fetch('https://rpc.mainnet.near.org', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: nearAccount } }),
  })
  const near = Number(BigInt((await res.json()).result.amount) / 10n ** 20n) / 1e4
  if (near < LOW_NEAR) log(`LOW NEAR: ${nearAccount} has ${near} NEAR; bridging stops when it runs out (about 0.06 NEAR per trip). Send it NEAR.`)
}

// One bridge trip at a time, run in the background.
let bridge: null | { kind: string; started: number; done: Promise<void> } = null
function startBridge(script: string, amount: string, kind: string, env: NodeJS.ProcessEnv) {
  log(`${kind} ${amount} (background)`)
  const done = new Promise<void>((ok) => {
    const child = spawn('bash', [resolve(SCRIPTS, script), amount], { env: { ...process.env, ...env, YES: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d) => process.stdout.write(`    [${kind}] ${d}`))
    child.stderr.on('data', (d) => process.stdout.write(`    [${kind}] ${d}`))
    child.on('exit', (code) => {
      log(`${kind} ${code === 0 ? 'finished' : `exited with ${code}; it resumes from its saved state next time`}`)
      bridge = null
      ok()
    })
  })
  bridge = { kind, started: Date.now(), done }
}

async function main() {
  const { rpc, 'owner-keypair': ownerPath, wgram: wgramArg, 'near-account': nearAccount, 'near-key-file': nearKey } = args
  if (!rpc || !ownerPath || !wgramArg || !nearAccount || !nearKey) {
    throw new Error('usage: pnpm mm-bot --rpc <url> --owner-keypair <path> --wgram <mint> --near-account <id> --near-key-file <path> [--min-convert 1] [--interval 30] [--live] [--once]')
  }
  const ownerFile = fromInvocation(ownerPath)
  const owner = loadKeypair(ownerFile)
  const minConvert = BigInt(Math.round(Number(args['min-convert']) * 1e9))
  const connection = new Connection(rpc, 'confirmed')
  const [pair] = dlmmModule.deriveLbPairWithPresetParamWithIndexKey(PRESET, new PublicKey(wgramArg), NATIVE_MINT, new PublicKey(dlmmModule.LBCLMM_PROGRAM_IDS['mainnet-beta']))
  const dlmm = await DLMM.create(connection, pair)
  const env = { NEAR_ACCOUNT: nearAccount, NEAR_KEY_FILE: fromInvocation(nearKey), SOL_KEYPAIR: ownerFile, SOL_RECIPIENT: owner.publicKey.toBase58() }
  log(`mm-bot ${args.live ? 'LIVE' : 'WATCH-ONLY (add --live to act)'}: pool ${pair.toBase58()}, owner ${owner.publicKey.toBase58()}`)
  const launchpadConfig = args.config ? new PublicKey(args.config) : null
  if (launchpadConfig) log(`graduating finished coins under config ${launchpadConfig.toBase58()}`)

  for (;;) {
    await warnIfLowNear(nearAccount).catch(() => {})
    // Graduations first and on their own: a stuck migration must never stop market making.
    if (launchpadConfig) {
      try {
        for (const g of await migrateGraduated(connection, owner, launchpadConfig, args.live)) {
          log(g.signature ? `graduated ${g.mint} into DAMM v2 ${g.dammPool} (${g.signature})` : g.error ? `graduation of ${g.mint} failed: ${g.error}` : `would graduate ${g.mint}`)
        }
      } catch (e) {
        log(`graduation check failed: ${(e as Error).message.split('\n')[0]}`)
      }
    }
    try {
      const fair = await fairPrice(nearAccount, owner.publicKey.toBase58())
      const { price } = await poolPrice(dlmm)
      const gap = price / fair - 1
      const w = await wallet(connection, dlmm, owner)
      const pool = await holdings(dlmm, owner)
      const status = `pool ${(gap * 100).toFixed(2)}% vs fair | pool ${(Number(pool.x) / 1e9).toFixed(1)} wGRAM + ${(Number(pool.y) / 1e9).toFixed(3)} SOL | reserve ${(Number(w.wgram) / 1e9).toFixed(1)} wGRAM + ${(Number(w.sol) / 1e9).toFixed(3)} SOL${bridge ? ` | ${bridge.kind} running` : ''}`
      if (!args.live) {
        log(`${status}${Math.abs(gap) > TOLERANCE ? '  -> would correct' : ''}`)
      } else {
        const actions: string[] = []
        const c = await correct(connection, dlmm, owner, fair)
        if (c.amount > 0n) actions.push(`corrected ${c.side} ${(c.gap * 100).toFixed(2)}% -> ${(c.after * 100).toFixed(2)}%`)
        if (!bridge) {
          const h = await harvest(connection, dlmm, owner, fair, minConvert)
          if (h.side !== 'none') actions.push(`harvested ${h.side} ${Number(h.amount) / 1e9}`)
          const t = reserveTarget(await wallet(connection, dlmm, owner), fair, minConvert)
          if (t.bridgeIn > 0n) startBridge('bridge-in.sh', (Number(t.bridgeIn) / 1e9).toFixed(9), 'bridge-in', env)
          else if (t.bridgeOut > 0n) startBridge('bridge-out.sh', (Number(t.bridgeOut) / 1e9).toFixed(9), 'bridge-out', env)
          else if (await needsRecenter(dlmm, owner, fair)) {
            await correct(connection, dlmm, owner, fair)
            const r = await recenter(connection, dlmm, owner, fair)
            actions.push(`re-centred core (${Number(r.x) / 1e9} wGRAM + ${Number(r.y) / 1e9} SOL)`)
          }
        }
        log(`${status}${actions.length ? `  ${actions.join('; ')}` : ''}`)
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
