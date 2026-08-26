import { NETWORKS, PAGE, MAX_PAGES } from "./config.mjs"

const QUERY = `
query Fills($since: numeric!, $until: numeric!, $limit: Int!, $offset: Int!) {
  Fill(
    where: {
      timestamp: { _gte: $since, _lt: $until }
      market: { marketType: { _eq: BINARY } }
    }
    order_by: [{ timestamp: asc }, { id: asc }]
    limit: $limit
    offset: $offset
  ) {
    id
    maker
    taker
    makerSide
    takerSide
    kind
    quantity
    quoteQuantity
    timestamp
    txHash
    market { asset intervalSec expiry venueId }
  }
}`

async function gql(url, variables) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables }),
  })
  if (!res.ok) throw new Error(`indexer HTTP ${res.status}`)
  const body = await res.json()
  if (body.errors) throw new Error(`indexer: ${JSON.stringify(body.errors)}`)
  return body.data.Fill
}

/** Every fill is paginated in; the row count is tiny (hundreds/day), so offset paging is fine. */
export async function fetchFills({ network = "mainnet", since, until = Math.floor(Date.now() / 1e3) + 1 }) {
  const { indexer } = NETWORKS[network]
  const out = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await gql(indexer, { since, until, limit: PAGE, offset: page * PAGE })
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
  throw new Error(`more than ${MAX_PAGES * PAGE} fills in window, narrow it or switch to cursor paging`)
}

/**
 * Each participant is credited the collateral leg they actually paid or received.
 *
 * `fillPrice` (and therefore `quoteQuantity`) is always quoted in Up terms, so
 * only the Up side's cash equals `quoteQuantity`; the Down side's cash is the
 * complement. Crediting both sides `quoteQuantity` (the obvious shortcut)
 * silently under-counts every Down leg, and on a mint-a-pair fill at 0.96 that
 * is a 25x error.
 */
function legOf(side, quantity, quoteQuantity) {
  return side.endsWith("_YES") ? quoteQuantity : quantity - quoteQuantity
}

/**
 * The collateral that moved in one fill, counted once.
 *
 * A DIRECT fill is one person's cash reaching another: both sides are on the
 * same outcome (`SELL_YES` against `BUY_YES`), so their legs are equal and the
 * fill is worth one of them. A MINT or BURN has the two sides on opposite
 * outcomes, each paying its own share of a whole contract, so the fill is worth
 * both legs together, which is exactly `quantity`.
 *
 * Adding up trader legs instead would double every direct fill. That is fine
 * for a per-trader figure, where each side's own exposure is the point, and
 * wrong for a venue total.
 */
function notionalOf(kind, makerLeg, takerLeg) {
  return kind === "MINT_A_PAIR" || kind === "BURN_A_PAIR" ? makerLeg + takerLeg : makerLeg
}

/** Asset and cadence come off the market row. Never parse the question text: its
 *  wording has changed several times, the fields have not. */
export const assetOf = (f) => f.market?.asset ?? "?"
export const intervalOf = (f) => Number(f.market?.intervalSec ?? 0)

/**
 * Filtering happens here rather than in the query: the window is a few thousand
 * rows at most, and fetching it whole is what lets `dimensions()` list the
 * assets and cadences that actually traded instead of a hardcoded menu.
 */
export function filterFills(fills, { asset = null, interval = null } = {}) {
  if (!asset && !interval) return fills
  return fills.filter(
    (f) => (!asset || assetOf(f) === asset) && (!interval || intervalOf(f) === Number(interval)),
  )
}

/** Rows the filters offer, derived from the window rather than hardcoded. */
export function dimensions(fills) {
  const assets = new Set()
  const intervals = new Set()
  for (const f of fills) {
    assets.add(assetOf(f))
    if (intervalOf(f)) intervals.add(intervalOf(f))
  }
  return { assets: [...assets].sort(), intervals: [...intervals].sort((a, b) => a - b) }
}

/**
 * Per-trader rows plus totals by asset and by cadence.
 *
 * Two different volumes, on purpose:
 *
 *   stats.volume       collateral that moved, each fill counted once. The
 *                      headline, and the number to compare with anyone else's.
 *   row.volume         one trader's own leg. Summing the column gives more than
 *                      the headline, because a direct fill has a payer and a
 *                      receiver and both belong on the board.
 *
 * `stats.traderVolume` is that column's total, kept so the gap is visible
 * rather than looking like an arithmetic error.
 *
 * Self-trades (same address on both sides) are dropped by default. They are
 * real fills on chain but say nothing about participation.
 */
export function tally(fills, { includeSelfTrades = false } = {}) {
  const rows = new Map()
  const byAsset = new Map()
  const byInterval = new Map()
  const stats = {
    fills: 0,
    counted: 0,
    selfTrades: 0,
    selfTradeVolume: 0n,
    volume: 0n,
    traderVolume: 0n,
    contracts: 0n,
    window: { first: null, last: null },
  }

  const bump = (addr, leg, quantity, isMaker, ts) => {
    const id = addr.toLowerCase()
    let r = rows.get(id)
    if (!r) {
      r = { id, address: id, volume: 0n, contracts: 0n, fills: 0, makerFills: 0, takerFills: 0, firstTs: ts, lastTs: ts }
      rows.set(id, r)
    }
    r.volume += leg
    r.contracts += quantity
    r.fills++
    isMaker ? r.makerFills++ : r.takerFills++
    r.firstTs = Math.min(r.firstTs, ts)
    r.lastTs = Math.max(r.lastTs, ts)
  }

  const group = (map, key, volume, quantity, maker, taker) => {
    let g = map.get(key)
    if (!g) {
      g = { key, volume: 0n, contracts: 0n, fills: 0, traders: new Set() }
      map.set(key, g)
    }
    g.volume += volume
    g.contracts += quantity
    g.fills++
    g.traders.add(maker).add(taker)
  }

  for (const f of fills) {
    stats.fills++
    const quantity = BigInt(f.quantity)
    const quoteQuantity = BigInt(f.quoteQuantity)
    const ts = Number(f.timestamp)
    const maker = f.maker.toLowerCase()
    const taker = f.taker.toLowerCase()

    if (maker === taker) {
      stats.selfTrades++
      stats.selfTradeVolume += quoteQuantity
      if (!includeSelfTrades) continue
    }
    stats.counted++

    const makerLeg = legOf(f.makerSide, quantity, quoteQuantity)
    const takerLeg = legOf(f.takerSide, quantity, quoteQuantity)
    bump(f.maker, makerLeg, quantity, true, ts)
    bump(f.taker, takerLeg, quantity, false, ts)

    // Venue figures count each fill once, so volume and contracts are on the
    // same footing and the breakdowns add up to the headline.
    const notional = notionalOf(f.kind, makerLeg, takerLeg)
    stats.volume += notional
    stats.contracts += quantity
    stats.traderVolume += makerLeg + takerLeg
    group(byAsset, assetOf(f), notional, quantity, maker, taker)
    group(byInterval, intervalOf(f), notional, quantity, maker, taker)
    stats.window.first = Math.min(stats.window.first ?? ts, ts)
    stats.window.last = Math.max(stats.window.last ?? ts, ts)
  }

  const byVolume = (a, b) => (b.volume > a.volume ? 1 : b.volume < a.volume ? -1 : 0)
  const flatten = (map) =>
    [...map.values()].map(({ traders, ...g }) => ({ ...g, traders: traders.size })).sort(byVolume)

  return {
    list: [...rows.values()].sort(byVolume),
    stats: { ...stats, traders: rows.size },
    byAsset: flatten(byAsset),
    byInterval: flatten(byInterval),
  }
}

export const fmt = (raw, decimals) => {
  const neg = raw < 0n
  const v = neg ? -raw : raw
  const base = 10n ** BigInt(decimals)
  const whole = v / base
  const frac = ((v % base) * 100n) / base
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}.${frac.toString().padStart(2, "0")}`
}
