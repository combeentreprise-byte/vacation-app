import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Colors } from "@/constants/colors";
import { useAuth } from "@/hooks/use-auth";
import { useProfile } from "@/hooks/use-profile";
import { showComingSoon } from "@/utils/coming-soon";

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function AccountSettingsScreen() {
  const { profile, updateProfile } = useProfile();
  const { session, signOut } = useAuth();
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");

  const handleEditToggle = () => {
    if (isEditing) {
      updateProfile({ name: editName.trim() || profile.name });
      setIsEditing(false);
    } else {
      setEditName(profile.name);
      setIsEditing(true);
    }
  };

  const handleLogOut = () => {
    Alert.alert("Log out", "Are you sure you want to log out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Log out", style: "destructive", onPress: () => signOut() },
    ]);
  };

  return (
    <View style={styles.container}>
      <View style={styles.topSection}>
        <View style={styles.iconStack}>
          <Pressable onPress={handleEditToggle} hitSlop={8}>
            <Ionicons
              name={isEditing ? "checkmark" : "create-outline"}
              size={22}
              color={Colors.text}
            />
          </Pressable>
          <Pressable onPress={() => showComingSoon("Switching accounts")} hitSlop={8}>
            <Ionicons name="swap-horizontal-outline" size={22} color={Colors.text} />
          </Pressable>
          <Pressable onPress={handleLogOut} hitSlop={8}>
            <Ionicons name="log-out-outline" size={22} color={Colors.text} />
          </Pressable>
        </View>

        <View style={styles.avatarWrap}>
          <View style={styles.avatarLarge}>
            <Text style={styles.avatarLargeText}>{getInitials(profile.name)}</Text>
          </View>
          {isEditing ? (
            <View style={styles.avatarEditBadge}>
              <Ionicons name="camera" size={14} color={Colors.accentText} />
            </View>
          ) : null}
        </View>

        {isEditing ? (
          <TextInput
            value={editName}
            onChangeText={setEditName}
            style={[styles.nameText, styles.nameInput]}
          />
        ) : (
          <Text style={styles.nameText}>{profile.name}</Text>
        )}

        <Text style={styles.emailText}>{session?.user.email ?? ""}</Text>
      </View>

      <View style={styles.rowsList}>
        <Pressable style={styles.row} onPress={() => showComingSoon("Notifications")}>
          <Text style={styles.rowLabel}>Notifications</Text>
          <Ionicons name="chevron-forward" size={18} color={Colors.muted} />
        </Pressable>
        <Pressable style={styles.row} onPress={() => showComingSoon("Password changes")}>
          <Text style={styles.rowLabel}>Password</Text>
          <Ionicons name="chevron-forward" size={18} color={Colors.muted} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  topSection: {
    alignItems: "center",
    paddingTop: 24,
    paddingHorizontal: 20,
    gap: 4,
  },
  iconStack: {
    position: "absolute",
    top: 0,
    right: 20,
    alignItems: "center",
    gap: 16,
  },
  avatarWrap: {
    width: 96,
    height: 96,
    marginBottom: 8,
  },
  avatarLarge: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarLargeText: {
    color: Colors.accentText,
    fontSize: 32,
    fontWeight: "700",
  },
  avatarEditBadge: {
    position: "absolute",
    bottom: -2,
    right: -2,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: Colors.background,
  },
  nameText: {
    fontSize: 22,
    fontWeight: "700",
    color: Colors.text,
  },
  nameInput: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
    textAlign: "center",
    minWidth: 160,
  },
  emailText: {
    fontSize: 14,
    color: Colors.muted,
  },
  rowsList: {
    marginTop: 32,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  rowLabel: {
    fontSize: 16,
    color: Colors.text,
  },
});
