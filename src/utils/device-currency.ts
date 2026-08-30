import * as Localization from "expo-localization";

import { findCurrency, findCurrencyByCountryCode } from "@/constants/currencies";

// currencies.ts's countryCode is one representative flag per currency (EUR
// -> the EU flag), which doesn't reverse cleanly: a eurozone country's own
// region code (Germany -> "de") isn't "eu", so it wouldn't otherwise match.
// This is the one common many-countries-to-one-currency case worth covering
// explicitly for a device-region default.
const EUROZONE_COUNTRY_CODES = new Set([
  "at", "be", "cy", "de", "ee", "es", "fi", "fr", "gr", "hr",
  "ie", "it", "lt", "lu", "lv", "mt", "nl", "pt", "si", "sk",
]);

// Only for the "create group" default — expo-localization reflects the
// device's own region/language settings, not where the phone physically is,
// which is a reasonable one-time default but not a substitute for the
// per-entry currency picker.
export function getDeviceDefaultCurrency(): string {
  const locale = Localization.getLocales()[0];
  if (!locale) return "";

  // currencyCode is null on web (per expo-localization's own docs), so fall
  // back to a region-code lookup against our own currency list there.
  if (locale.currencyCode && findCurrency(locale.currencyCode)) {
    return locale.currencyCode;
  }

  const region = locale.regionCode?.toLowerCase();
  if (region) {
    if (EUROZONE_COUNTRY_CODES.has(region)) return "EUR";
    return findCurrencyByCountryCode(region)?.code ?? "";
  }

  return "";
}
