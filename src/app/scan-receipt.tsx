import { router, useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ModalHeader } from "@/components/modal-header";
import { ReceiptScanner, type ScanResult } from "@/components/receipt-scanner";

// Opened from Add/Edit entry's "Scan receipt" button. Unlike the Scan tab,
// the group (and, when editing, the log) is already known, so the result
// goes straight back to the form that opened this screen.
export default function ScanReceiptScreen() {
  const { groupId, logId } = useLocalSearchParams<{ groupId: string; logId?: string }>();
  const insets = useSafeAreaInsets();

  const returnToForm = (result?: ScanResult) => {
    // "Enter manually" after a failed read — nothing to hand back.
    if (typeof result?.amount !== "number" || !Number.isFinite(result.amount)) {
      router.back();
      return;
    }
    // dismissTo pops back to the add-entry screen already underneath (so
    // its typed-in details and split selection survive) and *replaces* its
    // params — hence groupId/logId are passed through again. scanId is a
    // fresh value per scan so add-entry re-applies a result even when it
    // matches the previous scan's amount.
    router.dismissTo({
      pathname: "/add-entry",
      params: {
        groupId,
        ...(logId ? { logId } : {}),
        prefillAmount: String(result.amount),
        ...(result.currency ? { prefillCurrency: result.currency } : {}),
        scanId: String(Date.now()),
      },
    });
  };

  return (
    <View style={{ flex: 1 }}>
      <ModalHeader title="Scan receipt" onClose={() => router.back()} />
      <ReceiptScanner onResult={returnToForm} bottomInset={insets.bottom} />
    </View>
  );
}
