import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState } from "react";
import {
  Alert,
  Animated,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";

import { GroupHero } from "@/components/hero-motive";
import { Colors } from "@/constants/colors";
import { type Group, useGroups } from "@/hooks/use-groups";
import { supabase } from "@/lib/supabase";

const LEAVE_SLOT_WIDTH = 44;
// Every group card is a fixed slice of the screen rather than sized to its
// own content, so the list reads as evenly spaced rows regardless of how
// long a name/description runs — useWindowDimensions (not Dimensions.get)
// so it re-measures on rotation/resize instead of freezing at mount.
const CARD_HEIGHT_RATIO = 0.2;

export default function GroupScreen() {
  const { groups, isLoaded, removeGroup } = useGroups();
  const [isManaging, setIsManaging] = useState(false);
  const [slideAnim] = useState(() => new Animated.Value(0));
  const { height: windowHeight } = useWindowDimensions();
  const cardHeight = windowHeight * CARD_HEIGHT_RATIO;

  const handleCreate = () => {
    router.push("/new-group");
  };

  const toggleManaging = () => {
    const next = !isManaging;
    setIsManaging(next);
    Animated.timing(slideAnim, {
      toValue: next ? 1 : 0,
      duration: 200,
      useNativeDriver: false,
    }).start();
  };

  const handleLeave = async (group: Group) => {
    // Best-effort check for which confirmation copy to show; leave_group
    // itself (schema.sql) makes the actual delete-vs-leave call server-side,
    // so a stale count here can't cause the wrong thing to happen, only the
    // wrong warning to be shown for it.
    const { count } = await supabase
      .from("group_members")
      .select("user_id", { count: "exact", head: true })
      .eq("group_id", group.id)
      .is("left_at", null);
    const isLastMember = (count ?? 1) <= 1;

    Alert.alert(
      isLastMember ? "Delete group" : "Leave group",
      isLastMember
        ? "You're the last member of this group. Leaving will permanently delete the group and all its logs and balances — this can't be undone."
        : "Are you sure you want to leave this group?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: isLastMember ? "Delete" : "Leave",
          style: "destructive",
          onPress: () => {
            removeGroup(group.id);
            if (groups.length === 1) {
              setIsManaging(false);
              slideAnim.setValue(0);
            }
          },
        },
      ]
    );
  };

  if (!isLoaded) {
    return <View style={styles.container} />;
  }

  if (groups.length === 0) {
    return (
      <View style={styles.container}>
        <Pressable onPress={handleCreate} hitSlop={12}>
          <Ionicons name="add" size={28} color={Colors.muted} />
        </Pressable>
        <Pressable onPress={handleCreate}>
          <Text style={styles.createText}>Be part of a group</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <FlatList<Group>
      data={groups}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.list}
      extraData={isManaging}
      ListHeaderComponent={
        <View style={styles.listHeader}>
          <Pressable onPress={toggleManaging} hitSlop={8}>
            <Text style={styles.manageText}>{isManaging ? "Done" : "Manage groups"}</Text>
          </Pressable>
          <Pressable onPress={handleCreate} hitSlop={12}>
            <Ionicons name="add" size={24} color={Colors.accent} />
          </Pressable>
        </View>
      }
      renderItem={({ item }) => (
        <View style={styles.row}>
          <Animated.View
            style={[
              styles.leaveSlot,
              {
                width: slideAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, LEAVE_SLOT_WIDTH],
                }),
                opacity: slideAnim,
              },
            ]}
            pointerEvents={isManaging ? "auto" : "none"}
          >
            <Pressable onPress={() => handleLeave(item)} hitSlop={8}>
              <Ionicons name="log-out-outline" size={22} color={Colors.danger} />
            </Pressable>
          </Animated.View>
          <Pressable
            style={[styles.card, { height: cardHeight }]}
            onPress={() => router.push({ pathname: "/group/[id]", params: { id: item.id } })}
          >
            {/* The card body itself stands in for a future decorative photo
                (see cardPhotoArea) — the ribbon just sits on top of it. */}
            <GroupHero
              photoUrl={item.photoUrl}
              motive={item.heroMotive}
              hue={item.heroHue}
              verticalAlign="top"
              style={styles.cardPhotoArea}
            />
            <View style={styles.cardRibbon}>
              <Text style={styles.cardTitle} numberOfLines={1}>
                {item.name}
              </Text>
            </View>
          </Pressable>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  createText: {
    color: Colors.muted,
    fontSize: 15,
  },
  list: {
    padding: 20,
    gap: 12,
  },
  listHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  manageText: {
    color: Colors.accent,
    fontSize: 15,
    fontWeight: "500",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  leaveSlot: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  card: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  // Stands in for a future decorative photo — an <Image> can drop in here
  // later without touching the ribbon that sits on top of it.
  cardPhotoArea: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  cardRibbon: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: Colors.background,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: Colors.text,
  },
});
