import { supabase } from "@/lib/supabase";
import { readSharedData, writeSharedData } from "@/utils/offline-storage";

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

type ExchangeRateRow = {
  base_currency: string;
  rates: Record<string, number>;
  fetched_at: string;
};

// The device's own copy of the last rates it saw per base currency, so an
// entry in a foreign currency can still be converted with no connection (see
// getExchangeRate). Kept even once stale — an old rate beats not being able
// to log the expense at all.
type StoredRates = { rates: Record<string, number>; fetchedAt: number };

function storedRatesKey(base: string) {
  return `exchange-rates:${base}`;
}

async function fetchRatesFromApi(base: string): Promise<Record<string, number>> {
  const response = await fetch(`https://open.er-api.com/v6/latest/${base}`);
  const data = await response.json();
  if (data.result !== "success" || !data.rates) {
    throw new Error(`Exchange rate API returned no rates for ${base}`);
  }
  return data.rates;
}

// The one place that talks to the external rate API. Everything else (entry
// conversion, group-currency changes) goes through this, so the "only
// refresh when the shared cache is actually stale" behavior lives in exactly
// one spot instead of being re-implemented per caller.
async function getRates(base: string): Promise<Record<string, number>> {
  // No automatic retries: offline, supabase-js would otherwise back off for
  // ~7s before giving up, leaving the entry form stuck on "Submitting..."
  // before getExchangeRate can fall back to the device's own copy.
  const { data } = await supabase
    .from("exchange_rates")
    .select("base_currency, rates, fetched_at")
    .eq("base_currency", base)
    .retry(false)
    .maybeSingle<ExchangeRateRow>();

  const isFresh = data && Date.now() - new Date(data.fetched_at).getTime() < STALE_AFTER_MS;
  if (isFresh && data) {
    writeSharedData(storedRatesKey(base), {
      rates: data.rates,
      fetchedAt: new Date(data.fetched_at).getTime(),
    } satisfies StoredRates);
    return data.rates;
  }

  const rates = await fetchRatesFromApi(base);
  const { error } = await supabase
    .from("exchange_rates")
    .upsert({ base_currency: base, rates, fetched_at: new Date().toISOString() });
  if (error) console.warn("Failed to cache exchange rates", error);
  writeSharedData(storedRatesKey(base), { rates, fetchedAt: Date.now() } satisfies StoredRates);

  return rates;
}

// Ensures the shared cache for `base` is fresh, without needing the rate
// back — used before change_group_currency, which re-reads the cache itself
// server-side rather than trusting a client-supplied number.
export async function ensureRatesCached(base: string): Promise<void> {
  await getRates(base);
}

// Makes sure the device has recent rates *into* each of these currencies
// while it's online, so entries logged offline in any other currency can
// still be converted later (getExchangeRate's inverse fallback). Called with
// every group's currency; skips any the device already refreshed recently.
export async function prefetchRatesForOffline(bases: string[]): Promise<void> {
  for (const base of new Set(bases)) {
    const stored = await readSharedData<StoredRates>(storedRatesKey(base));
    if (stored && Date.now() - stored.fetchedAt < STALE_AFTER_MS) continue;
    try {
      await getRates(base);
    } catch (error) {
      console.warn("Failed to prefetch exchange rates", base, error);
    }
  }
}

function storedRate(
  storedBase: StoredRates | null,
  storedTarget: StoredRates | null,
  base: string,
  target: string,
  maxAgeMs: number
): number | undefined {
  const isRecent = (stored: StoredRates) => Date.now() - stored.fetchedAt < maxAgeMs;
  const direct = storedBase && isRecent(storedBase) ? storedBase.rates[target] : undefined;
  if (direct !== undefined) return direct;
  const inverse = storedTarget && isRecent(storedTarget) ? storedTarget.rates[base] : undefined;
  return inverse ? 1 / inverse : undefined;
}

export async function getExchangeRate(base: string, target: string): Promise<number> {
  if (base === target) return 1;

  // A recent copy on the device is as good as the shared cache (which only
  // refreshes daily anyway) and needs no connection — the inverse direction
  // counts too, since prefetchRatesForOffline stores rates keyed by each
  // group's own currency, i.e. the target here.
  const [storedBase, storedTarget] = await Promise.all([
    readSharedData<StoredRates>(storedRatesKey(base)),
    readSharedData<StoredRates>(storedRatesKey(target)),
  ]);
  const recent = storedRate(storedBase, storedTarget, base, target, STALE_AFTER_MS);
  if (recent !== undefined) return recent;

  try {
    const rate = (await getRates(base))[target];
    if (rate !== undefined) return rate;
  } catch {
    // Offline (or the API is down) — fall back to an older device copy.
  }

  const old = storedRate(storedBase, storedTarget, base, target, Infinity);
  if (old !== undefined) return old;

  throw new Error(`No exchange rate available from ${base} to ${target}`);
}
