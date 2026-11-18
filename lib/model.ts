// The token radar's value model: one sealed snapshot in, one ranked board out.
//
// The board ranks protocols that record no token yet. Protocols whose token already trades are kept
// apart: they calibrate the model (their market caps say what the market pays per dollar of TVL) and
// the dashboard shows them in their own view with the market's own values, never mixed into the
// pre-token ranking. No protocol name is ever special-cased: the same functions score every row, and
// every number comes from the snapshot's own figures at runtime.
//
// Implied value, for one pre-token protocol:
//
//   multiple   = median mcap/TVL of the live-token protocols in the same category
//                (the snapshot-wide median when the category has fewer than 3 live protocols),
//                clamped to [0.02, 2.00]
//   base       = tvl_usd x multiple
//   growth     = 1 + clamp(change_7d, -50, 100) / 100 x 0.5
//   maturity   = 0.6 + 0.4 x min(age_days, 1095) / 1095   (age unknown: 365 days)
//   implied    = max(1, round(base x growth x maturity))
//
// Age is measured against the snapshot's own as_of date, never against today, so every run of the
// program scores the same snapshot the same way. Ranks are 1..N by implied value, ties broken by slug,
// so the board is fully deterministic.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, stated in the dashboard's "How this ranks" section. */
export interface ModelConstants {
  /** Live protocols needed in a category before its own multiple is trusted. */
  min_category_sample: number;
  /** The multiple's floor and ceiling, guarding against thin or wild categories. */
  multiple_floor: number;
  multiple_cap: number;
  /** The seven-day growth clamp, in per cent, and how much of it the value keeps. */
  growth_floor: number;
  growth_cap: number;
  growth_weight: number;
  /** Maturity runs from maturity_floor (new) to 1.0 (maturity_days old or older). */
  maturity_floor: number;
  maturity_days: number;
  /** The age assumed when the snapshot records no listing date. */
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  min_category_sample: 3,
  multiple_floor: 0.02,
  multiple_cap: 2.0,
  growth_floor: -50,
  growth_cap: 100,
  growth_weight: 0.5,
  maturity_floor: 0.6,
  maturity_days: 1095,
  unknown_age_days: 365,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-calibrated-1';

/** How many live-token protocols the dashboard's separate Live view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  token_status: 'pre-token';
  implied_value_usd: number;
  model: {
    category_multiple: number;
    multiple_source: 'category' | 'overall';
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one board row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  category_multiple: number;
  multiple_source: 'category' | 'overall';
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the dashboard shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  mcap_tvl: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the calibration behind it. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  overall_multiple: number;
  category_multiples: { category: string; multiple: number; sample: number }[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Clamp `n` into [lo, hi]. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a sorted array of numbers (the mean of the two middles when even). */
export function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The calibration: one mcap/TVL multiple per category, taken from the snapshot's own live-token
 * protocols, plus the snapshot-wide multiple every thin category falls back to. A category keeps its
 * own multiple only when at least `min_category_sample` live protocols in it record a market cap;
 * the multiple is clamped so one wild protocol cannot set a category's price.
 */
export function calibrateMultiples(
  snapshot: Snapshot,
  model: ModelConstants,
): { overall: number; byCategory: Map<string, { multiple: number; sample: number }> } {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    all.push(ratio);
    if (p.category !== null) {
      const list = byCategory.get(p.category) ?? [];
      list.push(ratio);
      byCategory.set(p.category, list);
    }
  }
  all.sort((a, b) => a - b);
  const overall = clamp(median(all), model.multiple_floor, model.multiple_cap);
  const multiples = new Map<string, { multiple: number; sample: number }>();
  for (const [category, ratios] of byCategory) {
    ratios.sort((a, b) => a - b);
    if (ratios.length >= model.min_category_sample) {
      multiples.set(category, { multiple: clamp(median(ratios), model.multiple_floor, model.multiple_cap), sample: ratios.length });
    }
  }
  return { overall, byCategory: multiples };
}

/** The multiple one protocol's implied value uses, and where it came from. */
export function multipleFor(
  protocol: SnapshotProtocol,
  calibration: { overall: number; byCategory: Map<string, { multiple: number; sample: number }> },
): { multiple: number; source: 'category' | 'overall' } {
  const entry = protocol.category === null ? undefined : calibration.byCategory.get(protocol.category);
  if (entry !== undefined) return { multiple: entry.multiple, source: 'category' };
  return { multiple: calibration.overall, source: 'overall' };
}

/** The multipliers and the implied value one protocol gets under the calibrated model. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  calibration: { overall: number; byCategory: Map<string, { multiple: number; sample: number }> },
): { implied: number; multiple: number; source: 'category' | 'overall'; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const { multiple, source } = multipleFor(protocol, calibration);
  const growthPct = clamp(finite(protocol.change_7d, 0), model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (1 - model.maturity_floor) * (clamp(ageForModel, 0, model.maturity_days) / model.maturity_days);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * multiple * growthMult * maturityMult));
  return { implied, multiple, source, growthPct, growthMult, maturityMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories whose products are wrappers, stakes or bridges of something that already trades. */
const WRAPPED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Exchange names: a protocol named after one is the exchange's own product, not a launch. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol is one the board may rank: it records no token, and it is not a wrapped, staked
 * or bridged product of a token that already trades. This mirrors the watchlist's own rule, read from
 * the snapshot's ten fields, so the early rows below the floor are held to the same bar as the
 * watchlist itself. The watchlist's slugs always pass it.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && WRAPPED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  const words = p.name.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.includes('wrapped') || words.includes('staked') || words.includes('staking')) return false;
  if (EXCHANGE_PREFIXES.some((prefix) => p.name.startsWith(prefix))) return false;
  return true;
}

/** The protocols the board ranks, strongest first, with ranks 1..N. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const calibration = calibrateMultiples(snapshot, model);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug on it, whatever else the rule would say.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, at any size. The floor is never the
  // whole board: the radar exists to find these before the watchlist does.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }
  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, model, calibration);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.age,
    token_status: 'pre-token',
    implied_value_usd: s.implied,
    model: {
      // Full precision, not rounded: the dashboard recomputes implied value from these same
      // figures, and rounding here would make its check disagree with board.json by a few dollars.
      category_multiple: s.multiple,
      multiple_source: s.source,
      growth_pct: s.growthPct,
      growth_multiplier: s.growthMult,
      maturity_multiplier: s.maturityMult,
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

// ---------------------------------------------------------------- farm plans

/** A deterministic pick from `options` by slug, so rows vary without randomness. */
function pick<T>(slug: string, options: readonly T[]): T {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return options[h % options.length]!;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** A second chain when the protocol runs on more than one, else null. */
function secondChainOf(p: SnapshotProtocol): string | null {
  return p.chains.length > 1 ? p.chains[1]! : null;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 500;
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 25_000_000) return 100;
  return 60;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 90;
  if (age < 365) return 60;
  return 45;
}

/** The gas budget for one transaction on a chain, phrased to follow "Cost: ". */
function gasFor(chain: string): string {
  const cheap = ['Solana', 'Base', 'Arbitrum', 'Optimism', 'Polygon', 'BSC', 'Binance', 'Monad', 'Hyperliquid L1', 'Plasma', 'Avalanche', 'Sui', 'Aptos'];
  if (cheap.some((c) => chain.toLowerCase().includes(c.toLowerCase()))) return 'under $1 of gas';
  if (chain === 'Ethereum') return 'about $3 to $12 of gas, depending on congestion';
  return 'about $1 to $3 of gas';
}

/** The category's main action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateralized')) {
    return `Supply $${capital} of USDC to ${name} on ${chain} and leave the deposit untouched.`;
  }
  if (c.includes('dex') || c.includes('leveraged farm')) {
    return `Add $${capital} of liquidity to ${name}'s deepest pool on ${chain} and keep the LP position open.`;
  }
  if (c.includes('yield aggregator') || c.includes('yield')) {
    return `Deposit $${capital} of USDC into ${name}'s highest-TVL vault on ${chain} and hold the receipt token.`;
  }
  if (c.includes('bridge')) {
    return `Bridge $${capital} of USDC into ${chain} through ${name}, then use the bridged funds inside its app.`;
  }
  if (c.includes('restak') || c.includes('staking')) {
    return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) {
    return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} on ${name} and take one position in an active market, then leave it to settle.`;
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault')) {
    return `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares.`;
  }
  if (c.includes('stable')) {
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it.`;
  }
  if (c.includes('rwa') || c.includes('real world')) {
    return `Mint $${capital} of the protocol's yield-bearing asset on ${chain} and hold it in the same wallet.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  }
  if (c.includes('privacy') || c.includes('mixer')) {
    return `Deposit $${capital} through ${name} on ${chain} from a fresh wallet and keep the withdrawal note offline.`;
  }
  if (c.includes('gaming') || c.includes('nft')) {
    return `Spend $${capital} inside ${name} on ${chain} from one wallet and keep the assets it issues.`;
  }
  if (c.includes('launchpad')) {
    return `Stake or lock $${capital} through ${name} on ${chain} to qualify for its next sale.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** A second, different action for the same protocol, so the plan is more than one move. */
function secondActionFor(p: SnapshotProtocol, capital: number, chain: string, second: string | null): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (second !== null) {
    return `Repeat the position with $${Math.max(25, Math.round(capital / 2))} on ${second} as well, so the same wallet is active on two chains ${name} runs on.`;
  }
  if (c.includes('dex') || c.includes('yield')) {
    return `Swap $${Math.max(25, Math.round(capital / 2))} through ${name}'s own router on ${chain} once, so the wallet shows trading activity as well as a deposit.`;
  }
  if (c.includes('lend') || c.includes('cdp')) {
    return `Borrow $${Math.max(25, Math.round(capital / 4))} against the deposit on ${name}, hold it for a week, then repay it in full.`;
  }
  return `Use ${name}'s app once more from the same wallet: a second deposit, a vote, or a claim on its rewards page, so the wallet's history is not a single transaction.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived from
 * the protocol's own record (category, chains, TVL, age), never from a hand-written list of names,
 * and the wording varies by protocol so no two plans read alike.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const second = secondChainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  const wallet = pick(p.slug, [
    'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
    'Set up one wallet only for this farm, fund it from an exchange withdrawal, and keep its seed phrase on paper.',
    'Use a wallet you have never farmed with before, so this protocol sees one clean history, and store its seed offline.',
  ]);
  const cadence = pick(p.slug, [
    'Make one qualifying action each week: a deposit, a swap, a borrow, a vote, or a claim on the rewards page.',
    'Come back once a week and do one real action in the app, such as adding to the position, swapping, or voting.',
    'Keep the wallet warm with one action every 7 to 10 days: top up, swap, vote, or interact with a new feature.',
  ]);
  const check = pick(p.slug, [
    'Before you withdraw, open the protocol\u2019s own points or rewards page from the link it publishes and claim only there.',
    'Check the protocol\u2019s own announcements channel for a points or rewards page, and claim only from the link it publishes.',
    'Watch the protocol\u2019s own page for a snapshot or claim announcement, and never follow a claim link from a direct message.',
  ]);
  const log = pick(`${p.slug}/log`, [
    'Then write the wallet, the dates and every transaction in a farm log.',
    'Then keep a farm log with the wallet, the dates and every transaction hash.',
    'Then record the wallet, the dates and each transaction in a farm log you can revisit.',
  ]);
  const steps = [
    `${wallet} Cost: ${gas} for the first transaction. Time: 5 minutes.`,
    `${actionFor(p, capital, chain)} Cost: $${capital} of capital and ${gas}. Time: 15 minutes to set up.`,
    `${secondActionFor(p, capital, chain, second)} Cost: ${gas} per transaction. Time: 10 minutes.`,
    `${cadence} Cost: ${gas} a week. Time: 10 minutes a week.`,
    `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot. Cost: the $${capital} stays in the position. Time: ${hold} days.`,
    `${check} Cost: no fee to check, and never pay anyone to claim. Time: 10 minutes. ${log} Cost: nothing but the log. Time: 5 minutes.`,
  ];
  return steps.map((s) => {
    const t = s.trim();
    if (t.length > 600) return `${t.slice(0, 596).trimEnd()}...`;
    return t;
  });
}

// ---------------------------------------------------------------- the dashboard's data

/** The live-token protocols, by market cap, for the dashboard's separate Live view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      mcap_tvl: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const calibration = calibrateMultiples(snapshot, model);
  const live = liveRows(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const early = board.filter((r) => !watchlist.has(r.slug)).length;
  const categoryMultiples = [...calibration.byCategory.entries()]
    // Full precision here too, for the same dashboard-recompute reason; the page formats to 3 decimals.
    .map(([category, v]) => ({ category, multiple: v.multiple, sample: v.sample }))
    .sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    overall_multiple: calibration.overall,
    category_multiples: categoryMultiples,
    rows: board.map((row) => ({
      rank: row.rank,
      slug: row.slug,
      name: row.name,
      category: row.category,
      chains: row.chains,
      tvl_usd: row.tvl_usd,
      change_7d: row.change_7d,
      listed_at: row.listed_at,
      age_days: row.age_days,
      on_watchlist: watchlist.has(row.slug),
      implied_value_usd: row.implied_value_usd,
      category_multiple: row.model.category_multiple,
      multiple_source: row.model.multiple_source,
      growth_multiplier: row.model.growth_multiplier,
      maturity_multiplier: row.model.maturity_multiplier,
      farm_steps: row.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board holds ${board.length} rows, fewer than the 100 the gate needs`;
  const seen = new Set<string>();
  for (const r of board) {
    if (seen.has(r.slug)) return `${r.slug} appears twice`;
    seen.add(r.slug);
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) {
    if (!known.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
    if (r.name.trim().length === 0) return `${r.slug} has an empty name`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** The dashboard's dataset as one script beside the page: no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
