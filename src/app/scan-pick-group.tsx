import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";

import { ModalHeader } from "@/components/modal-header";
import { Skeleton, SkeletonGroup, SkeletonText } from "@/components/skeleton";
import { Colors } from "@/constants/colors";
import { type Group, useGroups } from "@/hooks/use-groups";

// The hop between the Scan tab and Add entry: a scanned receipt has an
// amount but no group yet, and Add entry needs a groupId — this just lets
// the user pick which group the scan belongs to before landing there.
export default function ScanPickGroupScreen() {
  const { groups, isLoaded } = useGroups();
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
      <ModalHeader title="Log it in which group?" onClose={() => router.back()} />

      {!isLoaded ? (
        <SkeletonGroup style={styles.list}>
          {(["50%", "38%", "60%"] as const).map((width) => (
            <View key={width} style={styles.row}>
              <SkeletonText fontSize={16} width={width} style={styles.flex} />
              <Skeleton width={18} height={18} radius={9} />
            </View>
          ))}
        </SkeletonGroup>
      ) : groups.length === 0 ? (
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
