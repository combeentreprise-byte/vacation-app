import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useState } from "react";
import {
  Animated,
  Dimensions,
  Easing,
  Image,
  Modal,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Colors } from "@/constants/colors";
import { CURRENCIES, type Currency } from "@/constants/currencies";

type CurrencyPickerModalProps = {
  visible: boolean;
  selectedCode?: string;
  onSelect: (code: string) => void;
  onClose: () => void;
};

const OPEN_DURATION_MS = 450;
const CLOSE_DURATION_MS = 250;

type CurrencySection = {
  title: string;
  data: Currency[];
};

function matchesQuery(currency: Currency, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return (
    currency.code.toLowerCase().includes(normalized) ||
    currency.name.toLowerCase().includes(normalized)
  );
}

// Currencies are already alphabetical by code, so grouping in a single pass
// preserves that order within each letter.
function groupByFirstLetter(currencies: Currency[]): CurrencySection[] {
  const sections: CurrencySection[] = [];
  for (const currency of currencies) {
    const letter = currency.code[0] ?? "#";
    const lastSection = sections[sections.length - 1];
    if (lastSection?.title === letter) {
      lastSection.data.push(currency);
    } else {
      sections.push({ title: letter, data: [currency] });
    }
  }
  return sections;
}

// Exported so other screens (e.g. the group detail header) can show the same
// flag next to a currency code without re-implementing the CDN lookup. Only
// a size override is ever needed, so this takes plain dimensions rather than
// a full style (View and Image disagree on the type of a couple of other
// style props, which isn't worth reconciling for this).
export function FlagIcon({
  countryCode,
  width = 28,
  height = 20,
}: {
  countryCode?: string;
  width?: number;
  height?: number;
}) {
  if (!countryCode) {
    return <View style={[styles.flag, { width, height }]} />;
  }
  // flagcdn.com is the same public flag CDN the react-native-country-flag
  // package defaults to; using it directly avoids bundling ~150 flag assets
  // (or a large flag-icon dependency) into the app.
  return (
    <Image
      source={{ uri: `https://flagcdn.com/w80/${countryCode}.png` }}
      style={[styles.flag, { width, height }]}
    />
  );
}

export function CurrencyPickerModal({
  visible,
  selectedCode,
  onSelect,
  onClose,
}: CurrencyPickerModalProps) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");

  // The Modal itself doesn't animate (animationType="none"): its built-in
  // "slide" moves the whole transparent layer, backdrop tint included, so the
  // tint visibly slid up with the sheet. Instead the tint fades in place while
  // only the sheet slides. Same keep-mounted-through-close approach as
  // usePopupAnimation, since setting visible={false} unmounts immediately.
  const [isMounted, setIsMounted] = useState(visible);
  const [progress] = useState(() => new Animated.Value(visible ? 1 : 0));
  if (visible && !isMounted) {
    setIsMounted(true);
  }

  useEffect(() => {
    if (visible) {
      Animated.timing(progress, {
        toValue: 1,
        duration: OPEN_DURATION_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(progress, {
        toValue: 0,
        duration: CLOSE_DURATION_MS,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setIsMounted(false);
      });
    }
  }, [visible, progress]);

  const sheetTranslateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [Dimensions.get("window").height, 0],
  });

  const sections = useMemo(
    () => groupByFirstLetter(CURRENCIES.filter((currency) => matchesQuery(currency, query))),
    [query]
  );

  const handleClose = () => {
    setQuery("");
    onClose();
  };

  const handleSelect = (code: string) => {
    setQuery("");
    onSelect(code);
  };

  return (
    <Modal transparent visible={isMounted} animationType="none" onRequestClose={handleClose}>
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: progress }]}
      />
      <View style={styles.sheetContainer}>
        <Animated.View
          style={[
            styles.sheet,
            {
              paddingBottom: insets.bottom + 12,
              transform: [{ translateY: sheetTranslateY }],
            },
          ]}
        >
          <View style={styles.header}>
            <Text style={styles.title}>Select currency</Text>
            <Pressable onPress={handleClose} hitSlop={12}>
              <Ionicons name="close" size={22} color={Colors.text} />
            </Pressable>
          </View>

          <View style={styles.searchRow}>
            <Ionicons name="search" size={18} color={Colors.muted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search currencies"
              placeholderTextColor={Colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.searchInput}
              autoFocus
            />
          </View>

          <SectionList<Currency, CurrencySection>
            sections={sections}
            keyExtractor={(item) => item.code}
            keyboardShouldPersistTaps="handled"
            stickySectionHeadersEnabled
            contentContainerStyle={styles.list}
            renderSectionHeader={({ section }) => (
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionHeaderText}>{section.title}</Text>
              </View>
            )}
            renderItem={({ item }) => {
              const isSelected = item.code === selectedCode;
              return (
                <Pressable
                  style={[styles.row, isSelected && styles.rowSelected]}
                  onPress={() => handleSelect(item.code)}
                >
                  <FlagIcon countryCode={item.countryCode} />
                  <Text style={styles.code}>{item.code}</Text>
                  <Text style={styles.name}>{item.name}</Text>
                  {isSelected ? (
                    <View style={styles.checkBadge}>
                      <Ionicons name="checkmark" size={14} color={Colors.accentText} />
                    </View>
                  ) : null}
                </Pressable>
              );
            }}
            ListEmptyComponent={
              <Text style={styles.emptyText}>No currencies match &quot;{query}&quot;</Text>
            }
          />
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: "rgba(17, 24, 28, 0.45)",
  },
  sheetContainer: {
    flex: 1,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: Colors.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    height: "80%",
    paddingTop: 20,
    paddingHorizontal: 20,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    color: Colors.text,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 4,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    color: Colors.text,
  },
  list: {
    paddingBottom: 20,
  },
  sectionHeader: {
    backgroundColor: Colors.background,
    paddingTop: 12,
    paddingBottom: 4,
  },
  sectionHeaderText: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.muted,
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 10,
  },
  rowSelected: {
    backgroundColor: "rgba(32, 138, 239, 0.08)",
  },
  flag: {
    width: 28,
    height: 20,
    borderRadius: 3,
    backgroundColor: Colors.border,
  },
  code: {
    fontSize: 15,
    fontWeight: "700",
    color: Colors.text,
    width: 44,
  },
  name: {
    flex: 1,
    fontSize: 15,
    color: Colors.text,
  },
  checkBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    textAlign: "center",
    color: Colors.muted,
    fontSize: 14,
    marginTop: 24,
  },
});
