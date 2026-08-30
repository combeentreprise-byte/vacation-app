import { supabase } from "@/lib/supabase";

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

type ExchangeRateRow = {
  base_currency: string;
  rates: Record<string, number>;
  fetched_at: string;
};

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
  const { data } = await supabase
    .from("exchange_rates")
    .select("base_currency, rates, fetched_at")
    .eq("base_currency", base)
    .maybeSingle<ExchangeRateRow>();

  const isFresh = data && Date.now() - new Date(data.fetched_at).getTime() < STALE_AFTER_MS;
  if (isFresh && data) {
    return data.rates;
  }

  const rates = await fetchRatesFromApi(base);
  const { error } = await supabase
    .from("exchange_rates")
    .upsert({ base_currency: base, rates, fetched_at: new Date().toISOString() });
  if (error) console.warn("Failed to cache exchange rates", error);

  return rates;
}

// Ensures the shared cache for `base` is fresh, without needing the rate
// back — used before change_group_currency, which re-reads the cache itself
// server-side rather than trusting a client-supplied number.
export async function ensureRatesCached(base: string): Promise<void> {
  await getRates(base);
}

export async function getExchangeRate(base: string, target: string): Promise<number> {
  if (base === target) return 1;
  const rates = await getRates(base);
  const rate = rates[target];
  if (rate === undefined) {
    throw new Error(`No exchange rate available from ${base} to ${target}`);
  }
  return rate;
}
