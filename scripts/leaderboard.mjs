#!/usr/bin/env node
//
// Event-contract activity from the markets indexer.
//
//   node scripts/leaderboard.mjs                       last 7 days, mainnet
//   node scripts/leaderboard.mjs --since all           since the first fill
//   node scripts/leaderboard.mjs --asset BTC --interval 900
//   node scripts/leaderboard.mjs --network testnet --days 1
//
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { NETWORKS, EC_EPOCH, DEFAULT_LOOKBACK_DAYS } from "../lib/config.mjs"
import { fetchFills, filterFills, dimensions, tally, fmt } from "../lib/ec.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const flag = (name) => process.argv.includes(`--${name}`)

const network = arg("network", "mainnet")
if (!NETWORKS[network]) throw new Error(`unknown network "${network}" (mainnet | testnet)`)
const { decimals, collateral, explorer } = NETWORKS[network]

const now = Math.floor(Date.now() / 1e3)
const sinceArg = arg("since", null)
const since =
  sinceArg === "all"
    ? EC_EPOCH
    : sinceArg
      ? Number(sinceArg)
      : now - (Number(arg("days", DEFAULT_LOOKBACK_DAYS)) || DEFAULT_LOOKBACK_DAYS) * 86400
const until = Number(arg("until", now + 1))
const asset = arg("asset", null)
const interval = Number(arg("interval", 0)) || null

const iso = (ts) => (ts ? new Date(ts * 1e3).toISOString().replace(".000Z", "Z").replace("T", " ") : "-")
const cadence = (s) => (s % 3600 === 0 ? `${s / 3600}h` : `${s / 60}m`)

const all = await fetchFills({ network, since, until })
const menu = dimensions(all)
const fills = filterFills(all, { asset, interval })
const { list, stats, byAsset, byInterval } = tally(fills, { includeSelfTrades: flag("include-self-trades") })

const scope = [asset, interval ? cadence(interval) : null].filter(Boolean).join(" ") || "all markets"

console.log(`\nEvent Contracts activity: ${network} (${collateral})`)
console.log(`window : ${iso(since)} → ${iso(until - 1)}`)
console.log(`scope  : ${scope}`)
console.log(`fills  : ${stats.fills} in window, ${stats.counted} counted` + (stats.selfTrades ? `, ${stats.selfTrades} self-trades excluded` : ""))
console.log(`traders: ${stats.traders} (taker side; ${stats.makerWallets} market-maker wallets)`)
console.log(`volume : ${fmt(stats.volume, decimals)} ${collateral} (collateral moved; each fill once)`)
console.log(`         ${fmt(stats.traderVolume, decimals)} credited across traders, both sides of a direct fill count\n`)

const pad = (s, n) => String(s).padEnd(n)
const padL = (s, n) => String(s).padStart(n)

const table = (title, rows, label) => {
  if (rows.length < 2 && !flag("verbose")) return
  console.log(title)
  for (const g of rows) {
    console.log(`  ${pad(label(g.key), 10)}${padL(fmt(g.volume, decimals), 18)}${padL(g.fills, 8)} fills${padL(g.traders, 6)} traders`)
  }
  console.log("")
}
table("by asset", byAsset, String)
table("by cadence", byInterval, (k) => cadence(Number(k)))

console.log(`${pad("#", 5)}${pad("address", 44)}${padL(`volume (${collateral})`, 20)}${padL("fills", 7)}${padL("maker", 7)}${padL("last trade", 22)}`)
console.log("-".repeat(105))
const top = flag("all") ? list : list.slice(0, 50)
top.forEach((r, i) => {
  console.log(
    pad(i + 1, 5) +
      pad(r.address, 44) +
      padL(fmt(r.volume, decimals), 20) +
      padL(r.fills, 7) +
      padL(r.makerFills, 7) +
      padL(iso(r.lastTs), 22),
  )
})
if (top.length < list.length) console.log(`\n  ${list.length - top.length} more, run with --all.`)

if (stats.selfTrades) {
  console.log(`\n  ${stats.selfTrades} self-trade fill(s) excluded (${fmt(stats.selfTradeVolume, decimals)} ${collateral} of Up-leg notional).`)
  console.log(`  Fees are zero on event contracts, so self-crossing costs only gas.`)
}
if (menu.assets.length) {
  console.log(`\n  assets in window: ${menu.assets.join(", ")}   cadences: ${menu.intervals.map(cadence).join(", ")}`)
}

const outPath = resolve(ROOT, "data/leaderboard.json")
mkdirSync(dirname(outPath), { recursive: true })
const bucket = (g) => ({ key: String(g.key), volume: g.volume.toString(), volumeFormatted: fmt(g.volume, decimals), contracts: g.contracts.toString(), fills: g.fills, traders: g.traders })
writeFileSync(
  outPath,
  JSON.stringify(
    {
      network,
      collateral,
      decimals,
      explorer,
      generatedAt: now,
      window: { since, until, first: stats.window.first, last: stats.window.last },
      filters: { asset, interval, assets: menu.assets, intervals: menu.intervals },
      totals: {
        volume: stats.volume.toString(),
        volumeFormatted: fmt(stats.volume, decimals),
        traderVolume: stats.traderVolume.toString(),
        contracts: stats.contracts.toString(),
        fills: stats.counted,
        traders: stats.traders,
        makerWallets: stats.makerWallets,
        selfTrades: stats.selfTrades,
        selfTradeVolume: stats.selfTradeVolume.toString(),
      },
      byAsset: byAsset.map(bucket),
      byInterval: byInterval.map(bucket),
      traders: list.map((r, i) => ({
        rank: i + 1,
        address: r.address,
        volume: r.volume.toString(),
        volumeFormatted: fmt(r.volume, decimals),
        contracts: r.contracts.toString(),
        fills: r.fills,
        makerFills: r.makerFills,
        takerFills: r.takerFills,
        firstTs: r.firstTs,
        lastTs: r.lastTs,
      })),
    },
    null,
    2,
  ),
)
console.log(`\nwrote data/leaderboard.json`)
