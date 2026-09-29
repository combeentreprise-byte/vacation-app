import { router } from "expo-router";

import { ReceiptScanner, type ScanResult } from "@/components/receipt-scanner";

export default function ScanScreen() {
  // A scan from the tab has an amount but no group yet, so it hands off to
  // the group picker before reaching Add entry.
  const goToGroupPicker = (result?: ScanResult) => {
    const params: Record<string, string> = {};
    if (typeof result?.amount === "number" && Number.isFinite(result.amount)) {
      params.prefillAmount = String(result.amount);
    }
    if (result?.currency) {
      params.prefillCurrency = result.currency;
    }
    router.push({ pathname: "/scan-pick-group", params });
  };

  return <ReceiptScanner onResult={goToGroupPicker} />;
}
