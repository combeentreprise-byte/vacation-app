import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Avatar } from "@/components/avatar";
import { CurrencyPickerModal } from "@/components/currency-picker";
import { ModalHeader } from "@/components/modal-header";
import { Colors } from "@/constants/colors";
import { CURRENCIES } from "@/constants/currencies";
import { LOG_DETAILS_MAX_LENGTH, LOG_DETAILS_MAX_LINES } from "@/constants/limits";
import { useAuth } from "@/hooks/use-auth";
import { useGroupMembers } from "@/hooks/use-group-members";
import { useGroups } from "@/hooks/use-groups";
import { useLineLimit } from "@/hooks/use-line-limit";
import { useLogs } from "@/hooks/use-logs";
import { useProfile } from "@/hooks/use-profile";
import { getExchangeRate } from "@/utils/exchange-rates";

const MEMBER_GRID_GAP = 10;

function MemberTile({
  name,
  label = name,
  avatarUrl,
  selected,
  onToggle,
  minWidth,
  onLayout,
}: {
  name: string;
  // Shown under the avatar when it should differ from `name` (e.g. "You"),
  // while the avatar's initials still come from the real name.
  label?: string;
  avatarUrl: string | null;
  selected: boolean;
  onToggle: () => void;
  minWidth: number;
  onLayout?: (event: LayoutChangeEvent) => void;
}) {
  return (
    <Pressable
      style={[styles.memberTile, { minWidth }, selected && styles.memberTileSelected]}
      onPress={onToggle}
      onLayout={onLayout}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
    >
      <Avatar
        name={name}
        avatarUrl={avatarUrl}
        style={[styles.memberAvatar, !selected && styles.memberAvatarUnselected]}
        textStyle={styles.memberAvatarText}
      />
      <Text
        style={[styles.memberTileName, !selected && styles.memberTileNameUnselected]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export default function AddEntryScreen() {
  const { groupId, prefillAmount, prefillCurrency, scanId, logId } = useLocalSearchParams<{
    groupId: string;
    // Set when arriving from the Scan tab's receipt flow (see
    // scan-pick-group.tsx), or when this form's own "Scan receipt" button
    // hands a result back (see scan-receipt.tsx) — the amount/currency
    // extracted from the photo, still just a starting point the user can
    // edit before submitting.
    prefillAmount?: string;
    prefillCurrency?: string;
    // Fresh per scan-receipt.tsx result, so a scan arriving on this
    // already-mounted form is applied even if its amount repeats the last.
    scanId?: string;
    // Set when arriving from a log's detail popup's "Edit entry" button —
    // switches this same form into edit-and-save-in-place mode.
    logId?: string;
  }>();
  const isEditMode = !!logId;
  const { session } = useAuth();
  const { profile } = useProfile();
  const { groups } = useGroups();
  const { logs, addLog, updateLog } = useLogs();
  const { members: allMembers } = useGroupMembers(groupId);
  const group = groups.find((item) => item.id === groupId);
  const existingLog = isEditMode ? logs.find((log) => log.id === logId) : undefined;
  // The checklist is for splitting with other people; your own share is
  // handled separately via "Myself included". Members who've left the group
  // can't be picked for a new split, though they remain visible on past
  // entries that already included them.
  const members = allMembers.filter(
    (member) => member.id !== session?.user.id && member.isActive
  );
  // Editing an entry that was split with someone who's since left or deleted
  // their account can't offer them back as a tile — but silently
  // dropping them from the split on save would shrink shareCount and
  // retroactively change everyone else's historical balance (the same thing
  // create_log's null-member handling exists to prevent). So their slot is
  // preserved untouched and only re-appended on submit; the picker below
  // only ever lets the user change the *other*, still-editable slots.
  const preservedMemberIds =
    existingLog?.memberIds.filter(
      (id) => id === null || !members.some((member) => member.id === id)
    ) ?? [];

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

  const [amount, setAmount] = useState(() =>
    existingLog ? String(existingLog.amount) : isPrefilled ? prefillAmount! : ""
  );
  const [currency, setCurrency] = useState(
    () => existingLog?.currency ?? validPrefillCurrency ?? group?.currency ?? ""
  );
  // useState initializers above only cover a prefill present on mount; a
  // scan returned by scan-receipt.tsx arrives later, as new params on this
  // same still-mounted screen. It also overrides an edited log's existing
  // amount — rescanning while editing is an explicit request to replace it.
  // Adjusted during render (React's "storing information from previous
  // renders" pattern) rather than in an effect, to avoid a wasted extra render.
  const [lastAppliedScanId, setLastAppliedScanId] = useState(scanId);
  if (scanId && scanId !== lastAppliedScanId) {
    setLastAppliedScanId(scanId);
    if (isPrefilled) setAmount(prefillAmount!);
    if (validPrefillCurrency) setCurrency(validPrefillCurrency);
  }
  const [isCurrencyPickerVisible, setIsCurrencyPickerVisible] = useState(false);
  const [details, setDetails] = useState(() => existingLog?.details ?? "");
  const detailsLineLimit = useLineLimit(details, setDetails, LOG_DETAILS_MAX_LINES);
  // Can't be seeded synchronously like the fields above — useGroupMembers
  // fetches on its own per-screen mount, so `members` is still empty on
  // this component's first render even though `existingLog` (from the
  // already-loaded, app-wide LogsProvider) is available immediately. Seeded
  // once via the effect below instead, as soon as the member list actually
  // has something to match against.
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const hasSeededSelection = useRef(false);
  useEffect(() => {
    if (!existingLog || hasSeededSelection.current || allMembers.length === 0) return;
    hasSeededSelection.current = true;
    const seeded: Record<string, boolean> = {};
    existingLog.memberIds.forEach((id) => {
      if (id && members.some((member) => member.id === id)) seeded[id] = true;
    });
    setSelectedIds(seeded);
  }, [existingLog, allMembers, members]);
  const [includeMyself, setIncludeMyself] = useState(existingLog?.payerIncluded ?? true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // "Select all" covers yourself too, since you appear as a tile alongside
  // everyone else.
  // Tiles are a fixed third of the row wide, but grow with a name that
  // doesn't fit — and those wider tiles are moved after all the standard
  // ones, so the uniform three-per-row grid stays intact up top. Whether a
  // tile is wide is only known once it's laid out, so the grid stays
  // invisible until every tile has reported its width (a tile's width only
  // depends on its name, so the reorder can't change it and loop).
  const [gridWidth, setGridWidth] = useState(0);
  const [tileWidths, setTileWidths] = useState<Record<string, number>>({});
  const defaultTileWidth = Math.max(0, (gridWidth - 2 * MEMBER_GRID_GAP) / 3);
  const isWideTile = (id: string) => tileWidths[id] > defaultTileWidth + 1;
  const orderedMembers = [...members].sort(
    (a, b) => Number(isWideTile(a.id)) - Number(isWideTile(b.id))
  );
  const isGridMeasured =
    gridWidth > 0 && members.every((member) => tileWidths[member.id] !== undefined);
  const handleTileLayout = (id: string) => (event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    setTileWidths((current) => (current[id] === width ? current : { ...current, [id]: width }));
  };

  const allSelected = includeMyself && members.every((member) => selectedIds[member.id]);

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
    setIncludeMyself(next);
  };

  // decimal-pad shows a comma instead of a period as the decimal separator on
  // many European locales, but `Number()` treats "12,50" as NaN — normalize
  // before parsing so a comma-entered amount isn't silently rejected.
  const amountValue = Number(amount.trim().replace(",", "."));
  // A preserved (deleted/departed-member) slot already guarantees a
  // non-empty split even if nothing in the editable checklist is checked,
  // so it counts toward "there's a valid split" the same as a selected tile.
  const hasSelection = Object.values(selectedIds).some(Boolean) || preservedMemberIds.length > 0;
  const canSubmit =
    amount.trim().length > 0 &&
    !Number.isNaN(amountValue) &&
    amountValue > 0 &&
    hasSelection &&
    !isSubmitting;

  const handleSubmit = async () => {
    if (!canSubmit || !groupId || !session || !group) return;
    if (isEditMode && !existingLog) return;
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
        // getExchangeRate already falls back to the rates this device saved
        // last time it was online, so this only happens offline for a
        // currency pair it has never looked up.
        setIsSubmitting(false);
        Alert.alert(
          "Couldn't convert currency",
          `There's no saved exchange rate from ${effectiveCurrency} to ${group.currency} on this device yet. Connect to the internet once and try again, or enter the amount in ${group.currency}.`,
          [{ text: "OK" }]
        );
        return;
      }
    }

    const memberIds = [
      ...preservedMemberIds,
      ...Object.keys(selectedIds).filter((id) => selectedIds[id]),
    ];

    if (isEditMode && existingLog) {
      const { error } = await updateLog(existingLog.id, {
        groupId,
        amount: amountValue,
        convertedAmount,
        convertedCurrency: group.currency,
        currency: effectiveCurrency,
        details: details.trim(),
        memberIds,
        paidBy: existingLog.paidBy,
        payerIncluded: includeMyself,
      });
      setIsSubmitting(false);
      if (error) {
        Alert.alert("Couldn't save changes", error);
        return;
      }
      router.back();
      return;
    }

    await addLog({
      groupId,
      amount: amountValue,
      convertedAmount,
      convertedCurrency: group.currency,
      currency: effectiveCurrency,
      details: details.trim(),
      memberIds,
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
      <ModalHeader title={isEditMode ? "Edit entry" : "Add entry"} onClose={() => router.back()} />

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
          <Pressable
            style={styles.scanButton}
            onPress={() =>
              router.push({
                pathname: "/scan-receipt",
                params: { groupId, ...(logId ? { logId } : {}) },
              })
            }
          >
            <Ionicons name="receipt-outline" size={18} color={Colors.accent} />
            <Text style={styles.scanButtonText}>Scan receipt</Text>
          </Pressable>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Details</Text>
          <TextInput
            value={details}
            {...detailsLineLimit}
            placeholder="What was this for?"
            placeholderTextColor={Colors.muted}
            style={[styles.input, styles.textArea]}
            multiline
            textAlignVertical="top"
            maxLength={LOG_DETAILS_MAX_LENGTH}
          />
          <Text style={styles.charCount}>
            {details.length}/{LOG_DETAILS_MAX_LENGTH} characters
          </Text>
        </View>

        <View style={styles.field}>
          <View style={styles.labelRow}>
            <Text style={styles.label}>Purchase was for</Text>
            <Pressable onPress={toggleAll} hitSlop={8}>
              <Text style={styles.selectAllText}>{allSelected ? "Deselect all" : "Select all"}</Text>
            </Pressable>
          </View>
          <View
            style={[styles.memberGrid, !isGridMeasured && styles.memberGridHidden]}
            onLayout={(event) => setGridWidth(event.nativeEvent.layout.width)}
          >
            <MemberTile
              name={profile.name}
              label="You"
              avatarUrl={profile.avatarUrl}
              selected={includeMyself}
              onToggle={() => setIncludeMyself((current) => !current)}
              minWidth={defaultTileWidth}
            />
            {orderedMembers.map((member) => (
              <MemberTile
                key={member.id}
                name={member.name}
                avatarUrl={member.avatarUrl}
                selected={!!selectedIds[member.id]}
                onToggle={() => toggleMember(member.id)}
                minWidth={defaultTileWidth}
                onLayout={handleTileLayout(member.id)}
              />
            ))}
          </View>
        </View>

        <Pressable
          style={[styles.submitButton, !canSubmit && styles.submitButtonDisabled]}
          onPress={handleSubmit}
          disabled={!canSubmit}
        >
          <Text style={styles.submitButtonText}>
            {isSubmitting
              ? isEditMode
                ? "Saving..."
                : "Submitting..."
              : isEditMode
                ? "Save changes"
                : "Submit entry"}
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
  charCount: {
    marginTop: 6,
    fontSize: 12,
    color: Colors.muted,
    textAlign: "right",
  },
  prefillHint: {
    marginTop: 6,
    fontSize: 13,
    color: Colors.muted,
  },
  amountInput: {
    flex: 1,
  },
  scanButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 12,
  },
  scanButtonText: {
    color: Colors.accent,
    fontSize: 15,
    fontWeight: "600",
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
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  selectAllText: {
    fontSize: 14,
    fontWeight: "500",
    color: Colors.accent,
  },
  memberGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: MEMBER_GRID_GAP,
  },
  memberGridHidden: {
    opacity: 0,
  },
  // Width comes from the minWidth prop (a third of the row) or the name,
  // whichever is larger — capped at the full row for the longest names.
  memberTile: {
    maxWidth: "100%",
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
  },
  memberTileSelected: {
    borderColor: Colors.accent,
  },
  memberAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  memberAvatarUnselected: {
    opacity: 0.4,
  },
  memberAvatarText: {
    color: Colors.accentText,
    fontSize: 16,
    fontWeight: "700",
  },
  memberTileName: {
    fontSize: 13,
    fontWeight: "500",
    color: Colors.text,
    textAlign: "center",
  },
  memberTileNameUnselected: {
    color: Colors.muted,
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
