import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Colors } from "@/constants/colors";
import { type Group, useGroups } from "@/hooks/use-groups";

// The hop between the Scan tab and Add entry: a scanned receipt has an
// amount but no group yet, and Add entry needs a groupId — this just lets
// the user pick which group the scan belongs to before landing there.
export default function ScanPickGroupScreen() {
  const insets = useSafeAreaInsets();
  const { groups } = useGroups();
  const { prefillAmount, prefillCurrency } = useLocalSearchParams<{
    prefillAmount?: string;
    prefillCurrency?: string;
  }>();

  const handleSelect = (group: Group) => {
    // Replaces this screen rather than pushing on top of it, so Add entry's
    // own close button lands back on the Scan tab instead of back here.
    router.replace({
      pathname: "/add-entry",
      params: {
        groupId: group.id,
        ...(prefillAmount ? { prefillAmount } : {}),
        ...(prefillCurrency ? { prefillCurrency } : {}),
      },
    });
  };

  return (
    <View style={styles.flex}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.headerTitle}>Log it in which group?</Text>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={24} color={Colors.text} />
        </Pressable>
      </View>

      {groups.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>You&apos;re not in any groups yet.</Text>
        </View>
      ) : (
        <FlatList<Group>
          data={groups}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => handleSelect(item)}>
              <Text style={styles.rowText} numberOfLines={1}>
                {item.name}
              </Text>
              <Ionicons name="chevron-forward" size={18} color={Colors.muted} />
            </Pressable>
          )}
        />
      )}
    </View>
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
  list: {
    padding: 20,
    gap: 10,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  rowText: {
    flex: 1,
    fontSize: 16,
    fontWeight: "600",
    color: Colors.text,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  emptyText: {
    color: Colors.muted,
    fontSize: 15,
  },
});
