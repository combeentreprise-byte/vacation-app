import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState } from "react";
import {
  Alert,
  Animated,
  FlatList,
  type GestureResponderEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { CreateOrJoinMenu, type MenuAnchor } from "@/components/create-or-join-menu";
import { Colors } from "@/constants/colors";
import { type Group, useGroups } from "@/hooks/use-groups";
import { supabase } from "@/lib/supabase";

const LEAVE_SLOT_WIDTH = 44;

export default function GroupScreen() {
  const { groups, isLoaded, removeGroup } = useGroups();
  const [isManaging, setIsManaging] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);
  const [slideAnim] = useState(() => new Animated.Value(0));

  const openMenu = (event: GestureResponderEvent) => {
    const { pageX, pageY } = event.nativeEvent;
    setMenuAnchor({ x: pageX, y: pageY });
  };

  const handleCreate = () => {
    setMenuAnchor(null);
    router.push("/new-group");
  };

  const handleJoin = () => {
    setMenuAnchor(null);
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
        <Pressable onPress={openMenu} hitSlop={12}>
          <Ionicons name="add" size={28} color={Colors.muted} />
        </Pressable>
        <Pressable onPress={openMenu}>
          <Text style={styles.createText}>Be part of a group</Text>
        </Pressable>
        <CreateOrJoinMenu
          anchor={menuAnchor}
          onClose={() => setMenuAnchor(null)}
          onCreate={handleCreate}
          onJoin={handleJoin}
        />
      </View>
    );
  }

  return (
    <>
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
            <Pressable onPress={openMenu} hitSlop={12}>
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
              style={styles.card}
              onPress={() =>
                router.push({ pathname: "/group/[id]", params: { id: item.id } })
              }
            >
              <Text style={styles.cardTitle}>{item.name}</Text>
              {item.description ? (
                <Text style={styles.cardDescription}>{item.description}</Text>
              ) : null}
            </Pressable>
          </View>
        )}
      />
      <CreateOrJoinMenu
        anchor={menuAnchor}
        onClose={() => setMenuAnchor(null)}
        onCreate={handleCreate}
        onJoin={handleJoin}
      />
    </>
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
    backgroundColor: Colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 16,
    gap: 4,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: Colors.text,
  },
  cardDescription: {
    fontSize: 14,
    color: Colors.muted,
  },
});
