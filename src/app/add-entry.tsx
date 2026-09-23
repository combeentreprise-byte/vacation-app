import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CurrencyPickerModal } from "@/components/currency-picker";
import { Colors } from "@/constants/colors";
import { CURRENCIES } from "@/constants/currencies";
import { useAuth } from "@/hooks/use-auth";
import { useGroupMembers } from "@/hooks/use-group-members";
import { useGroups } from "@/hooks/use-groups";
import { useLogs } from "@/hooks/use-logs";
import { getExchangeRate } from "@/utils/exchange-rates";

function CheckboxRow({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable style={styles.checkboxRow} onPress={onToggle}>
      <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
        {checked ? <Ionicons name="checkmark" size={14} color={Colors.accentText} /> : null}
      </View>
      <Text style={styles.checkboxLabel}>{label}</Text>
    </Pressable>
  );
}

export default function AddEntryScreen() {
  const insets = useSafeAreaInsets();
  const { groupId, prefillAmount, prefillCurrency } = useLocalSearchParams<{
    groupId: string;
    // Set when arriving from the Scan tab's receipt flow (see
    // scan-pick-group.tsx) — the amount/currency extracted from the photo,
    // still just a starting point the user can edit before submitting.
    prefillAmount?: string;
    prefillCurrency?: string;
  }>();
  const { session } = useAuth();
  const { groups } = useGroups();
  const { addLog } = useLogs();
  const { members: allMembers } = useGroupMembers(groupId);
  const group = groups.find((item) => item.id === groupId);
  // The checklist is for splitting with other people; your own share is
  // handled separately via "Myself included". Members who've left the group
  // can't be picked for a new split, though they remain visible on past
  // entries that already included them.
  const members = allMembers.filter(
    (member) => member.id !== session?.user.id && member.isActive
  );

  // A scanned amount of 0/negative/NaN isn't usable, and a scanned currency
  // that isn't one of ours (e.g. the model misread it, or it's a currency
  // exchange-rates.ts can't convert) shouldn't silently override the
  // group's own currency — so both are validated before ever reaching state.
  const scannedAmount = Number(prefillAmount);
  const isPrefilled = !!prefillAmount && Number.isFinite(scannedAmount) && scannedAmount > 0;
  const validPrefillCurrency =
    prefillCurrency && CURRENCIES.some((c) => c.code === prefillCurrency)
      ? prefillCurrency
      : undefined;

  const [amount, setAmount] = useState(isPrefilled ? prefillAmount! : "");
  const [currency, setCurrency] = useState(validPrefillCurrency ?? group?.currency ?? "");
  const [isCurrencyPickerVisible, setIsCurrencyPickerVisible] = useState(false);
  const [details, setDetails] = useState("");
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [includeMyself, setIncludeMyself] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const allSelected = members.length > 0 && members.every((member) => selectedIds[member.id]);

  const toggleMember = (id: string) => {
    setSelectedIds((current) => ({ ...current, [id]: !current[id] }));
  };

  const toggleAll = () => {
    const next = !allSelected;
    const updated: Record<string, boolean> = {};
    members.forEach((member) => {
      updated[member.id] = next;
    });
    setSelectedIds(updated);
  };

  const amountValue = Number(amount);
  const hasSelection = Object.values(selectedIds).some(Boolean);
  const canSubmit =
    amount.trim().length > 0 &&
    !Number.isNaN(amountValue) &&
    amountValue > 0 &&
    hasSelection &&
    !isSubmitting;

  const handleSubmit = async () => {
    if (!canSubmit || !groupId || !session || !group) return;
    const effectiveCurrency = currency.trim() || group.currency || "";
    if (effectiveCurrency !== currency) {
      setCurrency(effectiveCurrency);
    }

    setIsSubmitting(true);
    let convertedAmount = amountValue;
    if (effectiveCurrency !== group.currency) {
      try {
        const rate = await getExchangeRate(effectiveCurrency, group.currency);
        convertedAmount = amountValue * rate;
      } catch {
        setIsSubmitting(false);
        Alert.alert(
          "Couldn't convert currency",
          "Check your connection and try again.",
          [{ text: "OK" }]
        );
        return;
      }
    }

    await addLog({
      groupId,
      amount: amountValue,
      convertedAmount,
      currency: effectiveCurrency,
      details: details.trim(),
      memberIds: Object.keys(selectedIds).filter((id) => selectedIds[id]),
      paidBy: session.user.id,
      payerIncluded: includeMyself,
    });
    setIsSubmitting(false);
    router.back();
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.headerTitle}>Add entry</Text>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={24} color={Colors.text} />
        </Pressable>
      </View>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.form}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.field}>
          <Text style={styles.label}>Amount you spent</Text>
          <View style={styles.amountRow}>
            <TextInput
              value={amount}
              onChangeText={setAmount}
              placeholder="0.00"
              placeholderTextColor={Colors.muted}
              keyboardType="decimal-pad"
              style={[styles.input, styles.amountInput]}
            />
            <Pressable
              style={[styles.input, styles.currencyInput]}
              onPress={() => setIsCurrencyPickerVisible(true)}
            >
              <Text style={currency ? styles.currencyValue : styles.currencyPlaceholder}>
                {currency || "USD"}
              </Text>
            </Pressable>
          </View>
          {isPrefilled ? (
            <Text style={styles.prefillHint}>Filled in from your scanned receipt — double-check it.</Text>
          ) : null}
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Details</Text>
          <TextInput
            value={details}
            onChangeText={setDetails}
            placeholder="What was this for?"
            placeholderTextColor={Colors.muted}
            style={[styles.input, styles.textArea]}
            multiline
            textAlignVertical="top"
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Purchase was for</Text>
          <View style={styles.checkboxList}>
            <CheckboxRow label="All" checked={allSelected} onToggle={toggleAll} />
            {members.map((member) => (
              <CheckboxRow
                key={member.id}
                label={member.name}
                checked={!!selectedIds[member.id]}
                onToggle={() => toggleMember(member.id)}
              />
            ))}
          </View>

          <View style={styles.includeMyselfRow}>
            <CheckboxRow
              label="Myself included"
              checked={includeMyself}
              onToggle={() => setIncludeMyself((current) => !current)}
            />
          </View>
        </View>

        <Pressable
          style={[styles.submitButton, !canSubmit && styles.submitButtonDisabled]}
          onPress={handleSubmit}
          disabled={!canSubmit}
        >
          <Text style={styles.submitButtonText}>
            {isSubmitting ? "Submitting..." : "Submit entry"}
          </Text>
        </Pressable>
      </ScrollView>

      <CurrencyPickerModal
        visible={isCurrencyPickerVisible}
        selectedCode={currency}
        onSelect={(code) => {
          setCurrency(code);
          setIsCurrencyPickerVisible(false);
        }}
        onClose={() => setIsCurrencyPickerVisible(false)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 16,
    backgroundColor: Colors.background,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: Colors.text,
  },
  form: {
    padding: 20,
    gap: 20,
  },
  field: {
    gap: 8,
  },
  label: {
    fontSize: 14,
    fontWeight: "500",
    color: Colors.text,
  },
  input: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: Colors.text,
  },
  amountRow: {
    flexDirection: "row",
    gap: 10,
  },
  prefillHint: {
    marginTop: 6,
    fontSize: 13,
    color: Colors.muted,
  },
  amountInput: {
    flex: 1,
  },
  currencyInput: {
    width: 84,
  },
  currencyValue: {
    fontSize: 16,
    color: Colors.text,
    textAlign: "center",
  },
  currencyPlaceholder: {
    fontSize: 16,
    color: Colors.muted,
    textAlign: "center",
  },
  textArea: {
    height: 120,
  },
  checkboxList: {
    gap: 4,
  },
  includeMyselfRow: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  checkboxRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 6,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: Colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: {
    backgroundColor: Colors.accent,
    borderColor: Colors.accent,
  },
  checkboxLabel: {
    fontSize: 15,
    color: Colors.text,
  },
  submitButton: {
    backgroundColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
  },
  submitButtonDisabled: {
    opacity: 0.5,
  },
  submitButtonText: {
    color: Colors.accentText,
    fontSize: 16,
    fontWeight: "600",
  },
});
