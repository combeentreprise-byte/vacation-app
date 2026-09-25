import { Ionicons } from "@expo/vector-icons";
import { decode as decodeBase64 } from "base64-arraybuffer";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import {
  type ComponentProps,
  type ComponentType,
  type ReactNode,
  useEffect,
  useRef,
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
  useWindowDimensions,
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

const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Where down the screen the identity block's center lands once slid into
// edit position, as a fraction of the visible container's height (0.5 would
// be dead center).
const EDIT_SLIDE_TARGET_FRACTION = 0.3;
// Resting (non-editing) avatar diameter — shared between the style below and
// the grow-on-edit math, which scales up to half the device width.
const AVATAR_SIZE = 96;
// How much bigger the username gets at full grow, relative to its resting
// size — modest, unlike the avatar's much larger target.
const NAME_GROW_SCALE = 1.2;
// Fallback used for exactly one frame before the username's real resting
// height is measured via onLayout.
const NAME_BOX_FALLBACK_HEIGHT = 30;
// Fixed height for the Edit/checkmark button — stays constant across the
// label ⇄ checkmark swap, only the width animates.
const EDIT_BUTTON_HEIGHT = 36;
// Fallbacks for the button's two natural widths, used for exactly one frame
// before the invisible measuring probes (see the JSX) report the real
// values via onLayout.
const EDIT_LABEL_WIDTH_FALLBACK = 58;
const EDIT_CHECK_WIDTH_FALLBACK = 46;
// Shared by the avatar/username slide+grow AND the edit button's morph, so
// the button always finishes its flip at exactly the moment the profile
// finishes growing/shrinking, in both directions, by construction rather
// than by keeping two separate numbers in sync by hand.
const IDENTITY_MORPH_DURATION_MS = 280;
const EDIT_BUTTON_TRANSITION_MS = IDENTITY_MORPH_DURATION_MS;

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
  const scrollViewRef = useRef<ScrollView>(null);
  const containerRef = useRef<View>(null);
  const topSectionRef = useRef<View>(null);
  const { width: windowWidth } = useWindowDimensions();
  // Real (unscaled) resting height of the username text, measured via
  // onLayout — needed to compute how far its top edge rises as it grows
  // (see the grow-math block below), since transforms don't report their
  // own delta the way a layout change would.
  const [nameBoxHeight, setNameBoxHeight] = useState(NAME_BOX_FALLBACK_HEIGHT);
  // Pushes the whole avatar/name/email container down to the vertical
  // center of the screen before the editing affordances (input border,
  // avatar overlay) appear, then reverses on the way out — see
  // handleEditToggle. It's a real top-margin push rather than a transform,
  // so it also shoves the settings rows below it down as it grows/shrinks
  // (hence useNativeDriver: false — margin isn't a transform property).
  const [identityPush] = useState(() => new Animated.Value(0));
  // 0 → 1 grow progress, driving the avatar/name scale-up below. Kept
  // separate from identityPush so the push and the grow can use different
  // (dynamically computed) output ranges off the same timeline.
  const [identityGrow] = useState(() => new Animated.Value(0));
  // Fades the username border and the avatar's tinted camera overlay in
  // once the slide/grow settles, and back out before it reverses — see
  // handleEditToggle.
  const [editEffectsOpacity] = useState(() => new Animated.Value(0));
  // Real natural widths for the "Edit" label and the checkmark, measured
  // off the invisible probes in the JSX below rather than guessed, so the
  // button lands on the actual rendered size instead of an approximation.
  const [editLabelWidth, setEditLabelWidth] = useState(EDIT_LABEL_WIDTH_FALLBACK);
  const [editCheckWidth, setEditCheckWidth] = useState(EDIT_CHECK_WIDTH_FALLBACK);
  // 0 = settled on "Edit", 0.5 = fully closed (mid-morph), 1 = settled on
  // the checkmark — see handleEditToggle, which always drives this to 0.5
  // first, swaps the glyph, then continues to the far end, rather than
  // cross-fading the two states directly against each other. The 3-point
  // ranges below are symmetric and direction-agnostic (don't need to know
  // which end we started from), which sidesteps a real bug an earlier,
  // width-based version of this had: with RN's border-box sizing, ramping
  // width down to 0 while padding/border stayed fixed just floors the
  // rendered box at paddingHorizontal*2 + borderWidth*2 (~30px) instead of
  // actually closing — padding and border need to collapse in step with
  // width, all the way, not just style the resting states.
  const [editButtonAnim] = useState(() => new Animated.Value(0));
  // Which glyph the (now separately-timed) button shows — flips at the
  // moment the button is fully closed, not when isEditing itself flips.
  const [buttonShowsCheck, setButtonShowsCheck] = useState(false);
  const editButtonWidth = editButtonAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [editLabelWidth, 0, editCheckWidth],
  });
  const editButtonPadding = editButtonAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [14, 0, 14],
  });
  const editButtonBorderWidth = editButtonAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [1, 0, 1],
  });
  // Keeps the box's visual center pinned to the "Edit" label's own resting
  // center throughout — both the close and the reopen shrink/grow
  // symmetrically toward/from that same fixed point, rather than one edge
  // staying put while the other moves.
  const editButtonShift = editButtonAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0, -editLabelWidth / 2, -(editLabelWidth - editCheckWidth) / 2],
  });

  // The avatar's bottom edge is meant to stay put relative to the
  // username's top edge, and the username's bottom edge relative to the
  // email below it — i.e. both grow upward from a fixed bottom, and the
  // avatar's growth stacks on top of however far the username's top has
  // already risen. A plain `transform: scale` grows equally in both
  // directions from the center, so each one needs a compensating
  // translateY: half its own height delta to cancel the downward half of
  // its own scale (pinning its bottom), and — for the avatar only — the
  // username's full height delta on top of that, so its bottom tracks the
  // username's rising top instead of a fixed point.
  const avatarTargetSize = windowWidth * 0.5;
  const avatarScaleTarget = avatarTargetSize / AVATAR_SIZE;
  const avatarSelfDelta = AVATAR_SIZE * (avatarScaleTarget - 1);
  const nameDelta = nameBoxHeight * (NAME_GROW_SCALE - 1);
  const avatarShiftTarget = -(nameDelta + avatarSelfDelta / 2);
  const nameShiftTarget = -(nameDelta / 2);

  // transform arrays compose like CSS: the LAST entry is applied to the
  // point first, so translateY must come before scale here — otherwise the
  // translate itself gets multiplied by the (growing) scale factor instead
  // of landing as a plain absolute-pixel offset.
  const avatarGrowStyle = {
    transform: [
      {
        translateY: identityGrow.interpolate({ inputRange: [0, 1], outputRange: [0, avatarShiftTarget] }),
      },
      { scale: identityGrow.interpolate({ inputRange: [0, 1], outputRange: [1, avatarScaleTarget] }) },
    ],
  };
  const nameGrowStyle = {
    transform: [
      {
        translateY: identityGrow.interpolate({ inputRange: [0, 1], outputRange: [0, nameShiftTarget] }),
      },
      {
        scale: identityGrow.interpolate({ inputRange: [0, 1], outputRange: [1, NAME_GROW_SCALE] }),
      },
    ],
  };
  // Fades just the border color in/out (rather than the whole input's
  // opacity), so the name text itself doesn't flicker during the Text ⇄
  // TextInput swap.
  const nameBorderStyle = {
    borderColor: editEffectsOpacity.interpolate({
      inputRange: [0, 1],
      outputRange: ["rgba(32, 138, 239, 0)", "rgba(32, 138, 239, 1)"],
    }),
  };

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

  // Always closes the button fully (progress → 0.5, width → 0) before
  // swapping its glyph and continuing on to targetValue (0 or 1) — never
  // cross-fades directly between the two settled states.
  const morphEditButton = (targetValue: 0 | 1, showCheck: boolean) => {
    const half = EDIT_BUTTON_TRANSITION_MS / 2;
    Animated.timing(editButtonAnim, {
      toValue: 0.5,
      duration: half,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (!finished) return;
      setButtonShowsCheck(showCheck);
      Animated.timing(editButtonAnim, {
        toValue: targetValue,
        duration: half,
        useNativeDriver: false,
      }).start();
    });
  };

  const handleEditToggle = () => {
    if (isEditing) {
      // Fade the editing affordances out first, then hide them and push
      // back up / shrink back down to rest, together.
      updateProfile({ name: editName.trim() || profile.name });
      Animated.timing(editEffectsOpacity, {
        toValue: 0,
        duration: 160,
        // editEffectsOpacity also drives nameBorderStyle's borderColor
        // interpolation below, which the native driver can't run — mixing
        // that with useNativeDriver: true on the same Animated.Value throws
        // at runtime on native platforms.
        useNativeDriver: false,
      }).start(({ finished }) => {
        if (!finished) return;
        setIsEditing(false);
        Animated.parallel([
          Animated.timing(identityPush, {
            toValue: 0,
            duration: IDENTITY_MORPH_DURATION_MS,
            useNativeDriver: false,
          }),
          Animated.timing(identityGrow, {
            toValue: 0,
            duration: IDENTITY_MORPH_DURATION_MS,
            useNativeDriver: false,
          }),
        ]).start();
        morphEditButton(0, false);
      });
      return;
    }

    setEditName(profile.name);
    scrollViewRef.current?.scrollTo({ y: 0, animated: false });
    // Fires in parallel with the push+grow below (started separately since
    // it doesn't need the measured target) so the button finishes its flip
    // at exactly the moment the profile finishes growing, instead of only
    // starting once the profile is already done.
    morphEditButton(1, true);
    requestAnimationFrame(() => {
      containerRef.current?.measureInWindow((_x, containerY, _w, containerHeight) => {
        topSectionRef.current?.measureInWindow((_bx, blockY, _bw, blockHeight) => {
          const targetPush =
            containerY + containerHeight * EDIT_SLIDE_TARGET_FRACTION - (blockY + blockHeight / 2);
          Animated.parallel([
            Animated.timing(identityPush, {
              toValue: Math.max(targetPush, 0),
              duration: IDENTITY_MORPH_DURATION_MS,
              useNativeDriver: false,
            }),
            Animated.timing(identityGrow, {
              toValue: 1,
              duration: IDENTITY_MORPH_DURATION_MS,
              useNativeDriver: false,
            }),
          ]).start(({ finished }) => {
            if (!finished) return;
            setIsEditing(true);
            Animated.timing(editEffectsOpacity, {
              toValue: 1,
              duration: 200,
              useNativeDriver: false,
            }).start();
          });
        });
      });
    });
  };

  const handleLogOut = () => {
    Alert.alert("Log out", "Are you sure you want to log out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Log out", style: "destructive", onPress: () => signOut() },
    ]);
  };

  return (
    <View ref={containerRef} style={styles.container}>
      <ScrollView ref={scrollViewRef} contentContainerStyle={styles.scrollContent}>
        <Animated.View
          ref={topSectionRef}
          style={[styles.topSection, { marginTop: identityPush }]}
        >
          <Animated.View style={[styles.avatarWrap, avatarGrowStyle]}>
            <View style={styles.avatarLarge}>
              {profile.avatarUrl ? (
                <Image source={{ uri: profile.avatarUrl }} style={styles.avatarImage} />
              ) : (
                <Text style={styles.avatarLargeText}>{getInitials(profile.name)}</Text>
              )}
              {isEditing ? (
                <AnimatedPressable
                  style={[styles.avatarEditOverlay, { opacity: editEffectsOpacity }]}
                  onPress={handlePickAvatar}
                  disabled={isUploadingAvatar}
                >
                  {isUploadingAvatar ? (
                    <ActivityIndicator size="small" color={Colors.accentText} />
                  ) : (
                    <Ionicons name="camera" size={26} color={Colors.accentText} />
                  )}
                </AnimatedPressable>
              ) : null}
            </View>
          </Animated.View>

          {isEditing ? (
            <AnimatedTextInput
              value={editName}
              onChangeText={setEditName}
              style={[styles.nameText, styles.nameInput, nameGrowStyle, nameBorderStyle]}
            />
          ) : (
            <Animated.Text
              style={[styles.nameText, nameGrowStyle]}
              onLayout={(e) => setNameBoxHeight(e.nativeEvent.layout.height)}
            >
              {profile.name}
            </Animated.Text>
          )}

          <Text style={styles.emailText}>{session?.user.email ?? ""}</Text>
        </Animated.View>

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

      <AnimatedPressable
        style={[
          styles.editButton,
          {
            width: editButtonWidth,
            paddingHorizontal: editButtonPadding,
            borderWidth: editButtonBorderWidth,
            transform: [{ translateX: editButtonShift }],
          },
        ]}
        onPress={handleEditToggle}
        hitSlop={8}
      >
        {buttonShowsCheck ? (
          <Ionicons name="checkmark" size={18} color={Colors.accent} />
        ) : (
          <Text style={styles.editButtonText} numberOfLines={1}>
            Edit
          </Text>
        )}
      </AnimatedPressable>

      {/* Invisible, unmounted-from-interaction probes purely to measure each
          state's natural width via onLayout — see editLabelWidth/editCheckWidth
          above. Kept out of flow (absolute + zero opacity) so they don't
          affect layout or ever intercept a touch. */}
      <View
        style={[styles.editButton, styles.editButtonProbe]}
        onLayout={(e) => setEditLabelWidth(e.nativeEvent.layout.width)}
        pointerEvents="none"
      >
        <Text style={styles.editButtonText}>Edit</Text>
      </View>
      <View
        style={[styles.editButton, styles.editButtonProbe]}
        onLayout={(e) => setEditCheckWidth(e.nativeEvent.layout.width)}
        pointerEvents="none"
      >
        <Ionicons name="checkmark" size={18} color={Colors.accent} />
      </View>
    </View>
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
    zIndex: 10,
    elevation: 10,
    height: EDIT_BUTTON_HEIGHT,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  // Invisible measuring copies of the button — see the JSX comment above
  // where they're rendered.
  editButtonProbe: {
    opacity: 0,
  },
  editButtonText: {
    color: Colors.accent,
    fontSize: 14,
    fontWeight: "600",
  },
  avatarWrap: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    marginBottom: 8,
  },
  avatarLarge: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarImage: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
  },
  avatarLargeText: {
    color: Colors.accentText,
    fontSize: 32,
    fontWeight: "700",
  },
  avatarEditOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: "rgba(0, 0, 0, 0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  nameText: {
    fontSize: 22,
    fontWeight: "700",
    color: Colors.text,
  },
  nameInput: {
    borderWidth: 1.5,
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
