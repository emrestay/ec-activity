import { NETWORKS, EC_EPOCH, DEFAULT_LOOKBACK_DAYS } from "../lib/config.mjs"
import { fetchFills, filterFills, dimensions, tally, fmt } from "../lib/ec.mjs"

const DAY = 86400

/** `since=all` reaches back to the first fill; a number is a unix timestamp. */
function windowOf(params, now) {
  const raw = params.get("since")
  if (raw === "all") return EC_EPOCH
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return Math.floor(n)
  const days = Number(params.get("days")) || DEFAULT_LOOKBACK_DAYS
  return now - Math.max(1, days) * DAY
}

export default async function handler(req, res) {
  const gate = process.env.LEADERBOARD_TOKEN
  const url = new URL(req.url, "http://localhost")
  if (gate && url.searchParams.get("t") !== gate) {
    return res.status(401).json({ error: "unauthorized" })
  }

  const p = url.searchParams
  const network = p.get("network") === "testnet" ? "testnet" : "mainnet"
  const { decimals, collateral, explorer } = NETWORKS[network]
  const now = Math.floor(Date.now() / 1e3)
  const since = windowOf(p, now)
  const until = Number(p.get("until")) || now + 1
  const asset = p.get("asset") || null
  const interval = Number(p.get("interval")) || null

  try {
    const all = await fetchFills({ network, since, until })
    // Filters narrow the table, but the menu is built from the whole window,
    // otherwise picking BTC would hide every other asset from the dropdown.
    const { assets, intervals } = dimensions(all)
    const fills = filterFills(all, { asset, interval })
    const { list, stats, byAsset, byInterval } = tally(fills)

    const money = (v) => fmt(v, decimals)
    const bucket = (g) => ({
      key: String(g.key),
      volume: money(g.volume),
      volumeRaw: g.volume.toString(),
      contracts: money(g.contracts),
      fills: g.fills,
      traders: g.traders,
      makers: g.makers,
    })

    res.setHeader("cache-control", "s-maxage=30, stale-while-revalidate=120")
    res.status(200).json({
      network,
      collateral,
      decimals,
      explorer,
      generatedAt: now,
      window: { since, until, first: stats.window.first, last: stats.window.last },
      filters: { asset, interval, assets, intervals },
      totals: {
        volume: money(stats.volume),
        volumeRaw: stats.volume.toString(),
        traderVolume: money(stats.traderVolume),
        contracts: money(stats.contracts),
        fills: stats.counted,
        traders: stats.traders,
        makerWallets: stats.makerWallets,
        addresses: stats.addresses,
        selfTrades: stats.selfTrades,
        selfTradeVolume: money(stats.selfTradeVolume),
      },
      byAsset: byAsset.map(bucket),
      byInterval: byInterval.map(bucket),
      traders: list.map((r, i) => ({
        rank: i + 1,
        address: r.address,
        volume: money(r.volume),
        volumeRaw: r.volume.toString(),
        contracts: money(r.contracts),
        fills: r.fills,
        makerFills: r.makerFills,
        takerFills: r.takerFills,
        firstTs: r.firstTs,
        lastTs: r.lastTs,
      })),
    })
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) })
  }
}
