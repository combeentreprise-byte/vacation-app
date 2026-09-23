import { Ionicons } from "@expo/vector-icons";
import { decode as decodeBase64 } from "base64-arraybuffer";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import {
  type ComponentProps,
  type ComponentType,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";

import { Colors } from "@/constants/colors";
import { useAuth } from "@/hooks/use-auth";
import { useProfile } from "@/hooks/use-profile";
import { supabase } from "@/lib/supabase";

type IoniconName = ComponentProps<typeof Ionicons>["name"];

// react-native-web's Switch accepts activeThumbColor (the thumb color while
// on) separately from thumbColor (which it only applies while off) — a
// web-only prop that @types/react-native doesn't know about, so the cast
// widens just this component's prop type rather than `as any`-ing each use.
const WebSwitch = Switch as unknown as ComponentType<
  ComponentProps<typeof Switch> & { activeThumbColor?: string }
>;

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

type NotificationPrefs = {
  allMuted: boolean;
  expenseLogged: boolean;
  groupActivity: boolean;
};

const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  allMuted: false,
  expenseLogged: true,
  groupActivity: true,
};

// Content is always mounted (never unmounted on collapse) so its inner
// onLayout can measure a real height before the first expand. The measured
// child is styles.dropdownMeasure (position: absolute) so Yoga lays it out
// at its natural size instead of clamping it to the animated parent's
// current (possibly 0) height — without that, onLayout reports 0 on native
// even though the same code measures correctly in a web browser, where CSS
// layout doesn't let overflow: hidden affect a child's computed size.
function SettingsAccordionRow({
  icon,
  label,
  subtitle,
  expanded,
  onToggle,
  children,
  tone = "default",
}: {
  icon: IoniconName;
  label: string;
  subtitle: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
  tone?: "default" | "danger";
}) {
  const [rotateAnim] = useState(() => new Animated.Value(0));
  const [heightAnim] = useState(() => new Animated.Value(0));
  const [contentHeight, setContentHeight] = useState(0);

  useEffect(() => {
    Animated.timing(rotateAnim, {
      toValue: expanded ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
    Animated.timing(heightAnim, {
      toValue: expanded ? contentHeight : 0,
      duration: 220,
      useNativeDriver: false,
    }).start();
  }, [expanded, contentHeight, rotateAnim, heightAnim]);

  const rotate = rotateAnim.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "90deg"] });

  return (
    <View>
      <Pressable style={styles.row} onPress={onToggle}>
        <View style={[styles.rowIcon, tone === "danger" && styles.rowIconDanger]}>
          <Ionicons name={icon} size={20} color={tone === "danger" ? Colors.danger : Colors.accent} />
        </View>
        <View style={styles.rowTextWrap}>
          <Text style={styles.rowLabel}>{label}</Text>
          <Text style={styles.rowSubtitle}>{subtitle}</Text>
        </View>
        <Animated.View style={{ transform: [{ rotate }] }}>
          <Ionicons name="chevron-forward" size={20} color={Colors.muted} />
        </Animated.View>
      </Pressable>
      <Animated.View style={[styles.dropdownWrap, { height: heightAnim }]}>
        <View
          style={styles.dropdownMeasure}
          pointerEvents={expanded ? "auto" : "none"}
          onLayout={(event) => setContentHeight(event.nativeEvent.layout.height)}
        >
          {children}
        </View>
      </Animated.View>
    </View>
  );
}

// A row that reads like SettingsAccordionRow (same icon/label styling) but
// fires immediately on tap instead of expanding a dropdown — no chevron,
// since there's nothing to reveal.
function SettingsActionRow({
  icon,
  label,
  onPress,
}: {
  icon: IoniconName;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.rowIcon}>
        <Ionicons name={icon} size={20} color={Colors.accent} />
      </View>
      <View style={styles.rowTextWrap}>
        <Text style={styles.rowLabel}>{label}</Text>
      </View>
    </Pressable>
  );
}

function NotificationsDropdown() {
  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);

  return (
    <View style={styles.dropdownContent}>
      <View style={styles.muteRow}>
        <View style={styles.muteTextWrap}>
          <Ionicons name="notifications-off-outline" size={16} color={Colors.danger} />
          <Text style={styles.muteLabel}>Turn off all notifications</Text>
        </View>
        <WebSwitch
          value={prefs.allMuted}
          onValueChange={(value) => setPrefs((current) => ({ ...current, allMuted: value }))}
          trackColor={{ false: Colors.border, true: Colors.danger }}
          thumbColor={Colors.background}
          activeThumbColor={Colors.background}
          ios_backgroundColor={Colors.border}
        />
      </View>

      <View style={[styles.optionRow, prefs.allMuted && styles.optionRowDisabled]}>
        <View style={styles.optionTextWrap}>
          <Text style={styles.optionLabel}>New expense logged</Text>
          <Text style={styles.optionHint}>When someone logs a purchase in a group</Text>
        </View>
        <WebSwitch
          value={prefs.expenseLogged}
          onValueChange={(value) => setPrefs((current) => ({ ...current, expenseLogged: value }))}
          disabled={prefs.allMuted}
          trackColor={{ false: Colors.border, true: Colors.accent }}
          thumbColor={Colors.background}
          activeThumbColor={Colors.background}
          ios_backgroundColor={Colors.border}
        />
      </View>

      <View style={styles.optionDivider} />

      <View style={[styles.optionRow, prefs.allMuted && styles.optionRowDisabled]}>
        <View style={styles.optionTextWrap}>
          <Text style={styles.optionLabel}>Group activity</Text>
          <Text style={styles.optionHint}>
            Description edits, currency changes, or a member leaving
          </Text>
        </View>
        <WebSwitch
          value={prefs.groupActivity}
          onValueChange={(value) => setPrefs((current) => ({ ...current, groupActivity: value }))}
          disabled={prefs.allMuted}
          trackColor={{ false: Colors.border, true: Colors.accent }}
          thumbColor={Colors.background}
          activeThumbColor={Colors.background}
          ios_backgroundColor={Colors.border}
        />
      </View>
    </View>
  );
}

function PasswordDropdown({ onDone }: { onDone: () => void }) {
  const { updatePassword } = useAuth();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canSubmit =
    password.length >= 6 && password === confirmPassword && !isSubmitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    const { error } = await updatePassword(password);
    setIsSubmitting(false);

    if (error) {
      Alert.alert("Couldn't update password", error);
      return;
    }

    setPassword("");
    setConfirmPassword("");
    Alert.alert("Password updated", "Your password has been changed.");
    onDone();
  };

  return (
    <View style={styles.dropdownContent}>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>New password</Text>
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder="••••••••"
          placeholderTextColor={Colors.muted}
          secureTextEntry
          style={styles.fieldInput}
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Confirm new password</Text>
        <TextInput
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          placeholder="••••••••"
          placeholderTextColor={Colors.muted}
          secureTextEntry
          style={styles.fieldInput}
        />
      </View>

      {password.length > 0 && password.length < 6 ? (
        <Text style={styles.fieldHint}>Password must be at least 6 characters.</Text>
      ) : password.length > 0 && confirmPassword.length > 0 && password !== confirmPassword ? (
        <Text style={styles.fieldHint}>Passwords don&apos;t match.</Text>
      ) : null}

      <Pressable
        style={[styles.submitButton, !canSubmit && styles.submitButtonDisabled]}
        onPress={handleSubmit}
        disabled={!canSubmit}
      >
        <Text style={styles.submitButtonText}>
          {isSubmitting ? "Updating..." : "Update password"}
        </Text>
      </Pressable>
    </View>
  );
}

function DangerZoneDropdown() {
  const { deleteAccount } = useAuth();
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = () => {
    Alert.alert(
      "Delete your account?",
      "Your profile is permanently erased. Groups you created or expenses you paid for will show as \"Deleted user\" to other members. This can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete account",
          style: "destructive",
          onPress: async () => {
            setIsDeleting(true);
            const { error } = await deleteAccount();
            setIsDeleting(false);

            if (error) {
              Alert.alert("Couldn't delete account", error);
            }
            // On success, the auth listener in AuthProvider picks up the
            // signed-out state from deleteAccount's own signOut call and
            // Stack.Protected routes back to sign-in on its own.
          },
        },
      ]
    );
  };

  return (
    <View style={styles.dropdownContent}>
      <Text style={styles.dangerExplainer}>
        Permanently deletes your account and profile. This removes you from
        every group you&apos;re in. Groups you created or expenses you paid
        for stay visible to other members, attributed to &quot;Deleted
        user&quot; instead of your name.
      </Text>

      <Pressable
        style={[styles.dangerButton, isDeleting && styles.submitButtonDisabled]}
        onPress={handleDelete}
        disabled={isDeleting}
      >
        <Text style={styles.dangerButtonText}>
          {isDeleting ? "Deleting..." : "Delete account"}
        </Text>
      </Pressable>
    </View>
  );
}

export default function AccountSettingsScreen() {
  const { profile, updateProfile } = useProfile();
  const { session, signOut } = useAuth();
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [dangerZoneOpen, setDangerZoneOpen] = useState(false);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);

  const handlePickAvatar = async () => {
    const userId = session?.user.id;
    if (!userId || isUploadingAvatar) return;

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        "Photo access needed",
        "Allow photo library access in your device settings to set a profile picture."
      );
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    const asset = result.assets?.[0];
    if (result.canceled || !asset) return;

    setIsUploadingAvatar(true);
    try {
      // Always the same path per user (upsert: true) so re-uploading
      // replaces the old picture instead of accumulating orphaned files —
      // the "?v=" below is what defeats the browser/CDN cache for the
      // now-stale response at that same URL. No extension on the path
      // itself since the actual format varies (native's editor re-encodes
      // to JPEG, but web's picker passes the original file through
      // unchanged) — contentType below is what the served file is really
      // labeled as, so it doesn't need to match a filename claim.
      const path = `${userId}/avatar`;
      let contentType = "image/jpeg";
      let fileData: Blob | ArrayBuffer;
      if (Platform.OS === "web") {
        const blob = await (await fetch(asset.uri)).blob();
        contentType = blob.type || contentType;
        fileData = blob;
      } else {
        fileData = decodeBase64(await new File(asset.uri).base64());
      }

      const { error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(path, fileData, { contentType, upsert: true });
      if (uploadError) throw uploadError;

      const { data } = supabase.storage.from("avatars").getPublicUrl(path);
      updateProfile({ avatarUrl: `${data.publicUrl}?v=${Date.now()}` });
    } catch (error) {
      console.warn("Failed to upload avatar", error);
      Alert.alert(
        "Couldn't update photo",
        error instanceof Error ? error.message : "Please try again."
      );
    } finally {
      setIsUploadingAvatar(false);
    }
  };

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
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      <View style={styles.topSection}>
        <Pressable style={styles.editButton} onPress={handleEditToggle} hitSlop={8}>
          <Ionicons
            name={isEditing ? "checkmark" : "create-outline"}
            size={22}
            color={Colors.text}
          />
        </Pressable>

        <View style={styles.avatarWrap}>
          <View style={styles.avatarLarge}>
            {profile.avatarUrl ? (
              <Image source={{ uri: profile.avatarUrl }} style={styles.avatarImage} />
            ) : (
              <Text style={styles.avatarLargeText}>{getInitials(profile.name)}</Text>
            )}
          </View>
          {isEditing ? (
            <Pressable
              style={styles.avatarEditBadge}
              onPress={handlePickAvatar}
              disabled={isUploadingAvatar}
              hitSlop={4}
            >
              {isUploadingAvatar ? (
                <ActivityIndicator size="small" color={Colors.accentText} />
              ) : (
                <Ionicons name="camera" size={14} color={Colors.accentText} />
              )}
            </Pressable>
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
        <SettingsAccordionRow
          icon="notifications-outline"
          label="Notifications"
          subtitle="Choose what you get notified about"
          expanded={notificationsOpen}
          onToggle={() => setNotificationsOpen((current) => !current)}
        >
          <NotificationsDropdown />
        </SettingsAccordionRow>
        <SettingsAccordionRow
          icon="lock-closed-outline"
          label="Password"
          subtitle="Change your account password"
          expanded={passwordOpen}
          onToggle={() => setPasswordOpen((current) => !current)}
        >
          <PasswordDropdown onDone={() => setPasswordOpen(false)} />
        </SettingsAccordionRow>
        <SettingsActionRow icon="log-out-outline" label="Sign out" onPress={handleLogOut} />
        <SettingsAccordionRow
          icon="warning-outline"
          label="Danger Zone"
          subtitle="Permanently delete your account"
          expanded={dangerZoneOpen}
          onToggle={() => setDangerZoneOpen((current) => !current)}
          tone="danger"
        >
          <DangerZoneDropdown />
        </SettingsAccordionRow>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingBottom: 24,
  },
  topSection: {
    alignItems: "center",
    paddingTop: 24,
    paddingHorizontal: 20,
    gap: 4,
  },
  editButton: {
    position: "absolute",
    top: 0,
    right: 20,
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
    overflow: "hidden",
  },
  avatarImage: {
    width: 96,
    height: 96,
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
    gap: 14,
    paddingVertical: 18,
    paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(32, 138, 239, 0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  rowIconDanger: {
    backgroundColor: "rgba(229, 72, 77, 0.08)",
  },
  rowTextWrap: {
    flex: 1,
    gap: 2,
  },
  rowLabel: {
    fontSize: 17,
    fontWeight: "600",
    color: Colors.text,
  },
  rowSubtitle: {
    fontSize: 13,
    color: Colors.muted,
  },
  dropdownWrap: {
    overflow: "hidden",
    backgroundColor: "rgba(107, 119, 133, 0.05)",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  dropdownMeasure: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
  },
  dropdownContent: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 18,
    gap: 4,
  },
  muteRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(229, 72, 77, 0.07)",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 14,
  },
  muteTextWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
    marginRight: 12,
  },
  muteLabel: {
    fontSize: 14,
    fontWeight: "700",
    color: Colors.text,
    flexShrink: 1,
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
  },
  optionRowDisabled: {
    opacity: 0.45,
  },
  optionTextWrap: {
    flex: 1,
    gap: 2,
    marginRight: 12,
  },
  optionLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: Colors.text,
  },
  optionHint: {
    fontSize: 12,
    color: Colors.muted,
  },
  optionDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.border,
  },
  field: {
    gap: 6,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: "500",
    color: Colors.text,
  },
  fieldInput: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: Colors.text,
  },
  fieldHint: {
    fontSize: 12,
    color: Colors.danger,
  },
  submitButton: {
    backgroundColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 4,
  },
  submitButtonDisabled: {
    opacity: 0.5,
  },
  submitButtonText: {
    color: Colors.accentText,
    fontSize: 15,
    fontWeight: "600",
  },
  dangerExplainer: {
    fontSize: 13,
    lineHeight: 18,
    color: Colors.muted,
    marginBottom: 4,
  },
  dangerButton: {
    backgroundColor: Colors.danger,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 4,
  },
  dangerButtonText: {
    color: Colors.accentText,
    fontSize: 15,
    fontWeight: "600",
  },
});
