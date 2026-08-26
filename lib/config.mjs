// Event-contract volume is read from the markets indexer, not from RPC logs:
// EC pools are recycled every window, so a pool-address allowlist (the way the
// spot leaderboard works) goes stale within 15 minutes.

export const NETWORKS = {
  mainnet: {
    indexer: "https://prd.smk.somnia.host/v1/graphql",
    explorer: "https://prd.smk.somnia.host",
    collateral: "USDso",
    decimals: 18,
  },
  testnet: {
    indexer: "https://dev.smk.somnia.host/v1/graphql",
    explorer: "https://dev.smk.somnia.host",
    collateral: "tUSDC",
    decimals: 6,
  },
}

// The first binary fill on mainnet landed at 1784734607 (22 Jul 2026). Rounding
// down gives "all time" a floor that needs no maintenance.
export const EC_EPOCH = 1784700000

// What the page opens on. Everything older is one query param away.
export const DEFAULT_LOOKBACK_DAYS = 7

export const PAGE = 1000
export const MAX_PAGES = 200
