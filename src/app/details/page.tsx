import Link from "next/link";

const Block = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
    <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
    <div className="mt-3 space-y-2 text-sm text-slate-700">{children}</div>
  </section>
);

const Metric = ({
  name,
  explanation,
}: {
  name: string;
  explanation: string;
}) => (
  <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
    <p className="font-medium text-slate-900">{name}</p>
    <p className="mt-1 text-slate-700">{explanation}</p>
  </div>
);

export default function DetailsPage() {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-8 md:px-8">
      <header className="rounded-3xl border border-white/70 bg-white/80 p-6 shadow-sm backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Methodology</p>
            <h1 className="mt-2 text-2xl font-semibold text-slate-900">Details: How every metric is computed</h1>
          </div>
          <Link
            href="/"
            className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Back to Dashboard
          </Link>
        </div>
      </header>

      <Block title="Trading (Hyperliquid API)">
        <p>
          Source: `userFillsByTime` from timestamp 0 to now, with window splitting and de-duplication, plus `spotMeta`, `meta`, and
          `outcomeMeta` for market-type classification. If empty, fallback to `userFills`. Hyperliquid fill endpoints expose at most
          the latest 10,000 fills per wallet.
        </p>
        <p>Base formulas per fill:</p>
        <p>- Volume = `abs(px * sz)`</p>
        <p>- PVL = `closedPnl` (fallback keys: `closed_pnl`, `pnl`)</p>
        <p>- Winrate = `wins / (wins + losses) * 100` (only pnl &gt; 0 and pnl &lt; 0 count)</p>

        <Metric
          name="Outcomes Volume / PVL / Winrate"
          explanation="A fill is classified as Outcomes when it matches `outcomeMeta` market names or encoded outcome ids (`#N` / `+N`), or when coin includes explicit outcome markers (`?`, `-YES`, `-NO`), or when `dir` contains `SETTLEMENT` / `DELIST`. As fallback, `BUY/SELL` fills that are neither known spot (`spotMeta`) nor known perp (`meta`) are treated as Outcomes."
        />
        <Metric
          name="XYZ Volume / PVL / Winrate"
          explanation="A fill is classified as XYZ when coin matches XYZ patterns (`(XYZ)`, `XYZ`, `XYZ/...`, `.../XYZ`, `XYZ:...`, `...:XYZ`)."
        />
        <Metric
          name="Perps Volume / PVL / Winrate"
          explanation="A fill is classified as Perps when `dir` contains `LONG`, `SHORT`, `OPEN`, `CLOSE`, or `ADD`."
        />
        <Metric
          name="Spot Volume"
          explanation="A fill is counted as Spot only when coin matches known spot assets from `spotMeta` (for example `@index` or known spot pair name). Outcomes are excluded from spot even if `dir` is `BUY` or `SELL`."
        />
        <Metric
          name="Spot TWAB (USD)"
          explanation="Computed with the shared TWAB engine: time integral of USD portfolio value from first available spot history point to now. Source is Hyperliquid `portfolio` -> `allTime.spotState.accountValueHistory`; values are integrated as `sum(valueUSD * duration) / totalDuration` with exact timestamps."
        />
        <Metric
          name="HYPE Staking TWAB"
          explanation="Computed from Hyperliquid staking-native endpoints `delegatorHistory` + `delegatorSummary` (multi-validator aware). Delegation/undelegation deltas are reconstructed over time, then TWAB is computed as a time-weighted average staked balance."
        />
        <Metric
          name="Unit Volume / Fees / Trades"
          explanation="Subset of Spot fills matched to Unit markets via spotMeta pair base token mapping (plus symbol fallback). Volume uses `abs(px * sz)`. Fees follow HyperUnitTracker logic: if `feeToken == USDC`, add `fee`; otherwise convert with `fee * px` (signed, so rebates can reduce net fees). Trades is the number of matched fills."
        />
        <Metric
          name="Volume total (perps + spot + outcomes)"
          explanation="Computed as `outcomes.volume + spotVolume + perps.volume`."
        />
        <Metric
          name="Fills counted"
          explanation="Number of deduplicated fills returned by the API flow."
        />
        <Metric
          name="Fees paid (Outcomes / XYZ / Perps)"
          explanation="For each bucket, fees are summed from fill `fee` only when `fee > 0` (actual paid fee). Negative values (maker rebates/credits) are not counted as paid fees."
        />
        <p>
          Important: categories are not exclusive. The same fill can contribute to multiple buckets (for example Outcomes and
          Perps), exactly as implemented in the calculation logic.
        </p>
      </Block>

      <Block title="HEVM">
        <p>
          Source: HyperEVM explorer datasets `txlist`, `tokentx`, and `txlistinternal`, with pagination and de-duplication.
        </p>

        <Metric
          name="TWAB"
          explanation="Computed with the same shared TWAB engine as Spot: exact-time integration `sum(valueUSD * duration) / totalDuration`. USD portfolio value is reconstructed event-by-event from HyperEVM flows (normal tx + token tx + internal tx) plus net USD locked in contract interactions (LP/lending proxy), then valued with historical token prices at each timestamp."
        />
        <Metric
          name="Volume (USD)"
          explanation="Sum of outgoing account tx + outgoing token transfers, valued at historical USD price at transfer time. Native and HYPE-like assets use historical HYPE/USD (CoinGecko); stablecoins are counted at nominal USD; other tokens use contract historical series when available."
        />
        <Metric
          name="Fees paid (USD)"
          explanation="Sum of outgoing transaction gas fees (`gasUsed * gasPrice`) converted to USD using historical HYPE/USD at each transaction timestamp."
        />
        <Metric
          name="Different contracts"
          explanation="Unique `to` addresses from outgoing account transactions (`txlist`), excluding zero address."
        />
        <Metric
          name="Different active days"
          explanation="Number of UTC days with at least 1 outgoing account transaction."
        />
        <Metric
          name="Different active months"
          explanation="Number of UTC months with at least 3 outgoing account transactions."
        />
        <Metric
          name="Since first tx (d/m/y)"
          explanation="Age computed from the earliest timestamp found across normal tx, token tx, then internal tx fallback."
        />
        <Metric
          name="Bridge volume (USD)"
          explanation="Sum of incoming transfers where sender is in the known bridge sender list, valued with the same historical USD rules as HEVM volume."
        />
        <Metric
          name="Number of tx"
          explanation="Count of deduplicated outgoing account transactions (`txlist`) after self-transfer exclusion."
        />
        <p>
          Pricing reliability safeguards: token historical pricing requests are capped (top contracts by transferred amount), and
          unsupported contracts are excluded from USD valuation with warnings.
        </p>
      </Block>

      <Block title="Unit Bridge">
        <p>
          Source: HyperUnit operations API (<code>/operations/{"{address}"}</code>) with cursor pagination. The app follows cursors
          until the end, with a hard safety cap on pages.
        </p>

        <Metric
          name="Volume (USD)"
          explanation="Estimated from operation `sourceAmount` converted by asset decimals, multiplied by current Hyperliquid `allMids` prices (not historical-at-time)."
        />
        <Metric
          name="Different contracts"
          explanation="Unique bridged assets (symbol-level, normalized), excluding assets in the exclusion list (currently `ena`)."
        />
        <Metric
          name="Different active days / months"
          explanation="Unique UTC days and months based on operation creation timestamp (`opCreatedAt`)."
        />
        <Metric
          name="Nb of chain source / destination"
          explanation="Unique values of `sourceChain` and `destinationChain` across operations."
        />
        <Metric
          name="Since first tx (d/m/y)"
          explanation="Age from earliest operation timestamp."
        />
        <Metric
          name="Number of tx"
          explanation="Count of deduplicated operations after excluded assets filtering."
        />
        <p>
          Note: Unit bridge USD volume is an estimate using current mids at query time. If a price is missing for an asset, that
          asset is excluded and a warning is shown.
        </p>
      </Block>
    </main>
  );
}
