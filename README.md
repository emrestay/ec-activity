# EC activity

Volume, traders and fills for DreamDEX event contracts on Somnia, sliced by asset
and by market cadence. Reads the markets indexer directly, so it needs no API key
and no SDK.

Live at **https://ec-leaderboard.vercel.app**.

Counting volume on a binary CLOB is less obvious than it looks, and the naive
reading of the indexer overstates one side of every mint. Read *How volume is
counted* before quoting a number from this anywhere.

```bash
node scripts/leaderboard.mjs                        # last 7 days, mainnet
node scripts/leaderboard.mjs --since all            # since the first fill
node scripts/leaderboard.mjs --days 1
node scripts/leaderboard.mjs --asset BTC --interval 900
node scripts/leaderboard.mjs --network testnet
node scripts/leaderboard.mjs --all                  # full trader list, not the top 50
```

No dependencies and no state: every run recomputes the whole window from the indexer,
so there is nothing to backfill and nothing to keep in sync. Results also land in
`data/leaderboard.json`.

The page carries the same filters, and holds them in the URL, so a view is a link
someone else can open.

## How volume is counted

Source is the markets indexer (`prd.smk.somnia.host/v1/graphql`), filtered to
`marketType: BINARY`. **That filter is not optional**: spot, perps and event contracts
share one `Fill` table, and without it you are mostly summing spot volume.

Each participant is credited the collateral leg they actually paid or received:

| Fill kind | Maker | Taker |
|---|---|---|
| `DIRECT_YES` / `DIRECT_NO` | same notional both sides | same notional both sides |
| `MINT_A_PAIR` | both are buyers | Up pays `p`, Down pays `1 − p` |
| `BURN_A_PAIR` | both are sellers | Up gets `p`, Down gets `1 − p` |

`quoteQuantity` is always the **Up-side** notional, so crediting it to both sides
(the obvious shortcut) under-counts every Down leg. On a mint-a-pair fill at 0.96 that
is a 24x error on one participant. The rule that covers all four kinds: a `*_YES` side
is worth `quoteQuantity`, a `*_NO` side is worth `quantity − quoteQuantity`.

There are two volumes on the page and they do not match, on purpose:

- **Headline volume** is the collateral that moved, each fill counted once. On a
  `DIRECT` fill both sides sit on the same outcome, so their legs are equal and the
  fill is worth one of them. On a `MINT_A_PAIR` or `BURN_A_PAIR` the two sides sit on
  opposite outcomes and each pays its share of a whole contract, so the fill is worth
  both legs together, which is exactly `quantity`. The asset and cadence breakdowns
  use the same rule, so they add up to the headline.
- **A trader's row** is their own leg: what that address paid or received. Summing
  the column gives more than the headline, because a direct fill has a payer and a
  receiver and both belong on the board. The page prints that total too, so the gap
  reads as a definition rather than an arithmetic error.

`contracts` counts contract pairs. One contract is one Up token plus one Down token,
together worth 1 USDso at settlement. They are ERC-6909 tokens with 18 decimals and
trade in lots of 0.001, so a contract count is normally fractional: 2,042.43
contracts is 2,042.43 pairs, not a rounding artifact.

Asset and cadence come from the market's `asset` and `intervalSec` fields. Do not
parse the question text: its wording has changed several times, the fields have not.

## Sharp edges

- Event contracts run at **zero maker and taker fees**, so self-crossing costs only
  gas. Fills where maker and taker are the same address are excluded and reported
  separately, but that only catches the laziest version. Wallets funded from a common
  source can wash against each other just as cheaply. Treat the trader table as a
  view of activity, not as a ranking anything should pay out on.
- Indexer rows land a few seconds behind the chain. Snapshot a closed window, not the
  current second, if you are quoting a number.
- Markets roll every 15 minutes and pools are recycled, which is why this reads the
  indexer rather than keeping an allowlist of pool addresses. A pool address is a
  time-varying binding; key state by market id or symbol instead.
- Mainnet has hosted more than one venue. An all-time window therefore includes an
  earlier venue that stopped rolling markets on 31 July 2026, which is worth knowing
  before comparing an all-time figure against a recent one.
- The asset and cadence menus are built from the fills in the current window, so
  widening the window can reveal options that were not there before.

## Deploying

Any static host with Node serverless functions works. On Vercel:

```bash
vercel deploy --prod
```

The page is public and unauthenticated by default. Set a `LEADERBOARD_TOKEN`
environment variable to gate it, after which the link becomes `?t=<token>`.
