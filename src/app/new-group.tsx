import { Ionicons } from "@expo/vector-icons";
import { decode as decodeBase64 } from "base64-arraybuffer";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CurrencyPickerModal } from "@/components/currency-picker";
import { HeroMotive } from "@/components/hero-motive";
import { PhotoCropModal } from "@/components/photo-crop-modal";
import { Colors } from "@/constants/colors";
import { GROUP_DESCRIPTION_MAX_LENGTH } from "@/constants/limits";
import { useAuth } from "@/hooks/use-auth";
import { useGroups } from "@/hooks/use-groups";
import { useLogs } from "@/hooks/use-logs";
import { supabase } from "@/lib/supabase";
import { getDeviceDefaultCurrency } from "@/utils/device-currency";
import { pickRandomHeroMotive } from "@/utils/hero-motive";

// Matches the group detail screen's hero proportions (see HERO_HEIGHT_RATIO
// in group/[id].tsx) so a group's look is visually consistent from the
// moment it's previewed here through to its own detail screen later.
const HERO_HEIGHT_RATIO = 0.28;

// The photo picker's crop rectangle targets the group list card's shape
// (see CARD_HEIGHT_RATIO and the list's padding in (tabs)/index.tsx) rather
// than this screen's own hero above — the card is squatter/wider, and it's
// the more frequently-seen view, so a mismatch there is worth avoiding more
// than a mismatch on the hero (which still `cover`-fits reasonably).
const CARD_HEIGHT_RATIO = 0.2;
const CARD_HORIZONTAL_PADDING = 20;

export default function NewGroupScreen() {
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const { session } = useAuth();
  const { groups, addGroup, updateGroup, changeGroupCurrency } = useGroups();
  const { refresh: refreshLogs } = useLogs();
  // Set when arriving from the group screen's "Edit group" menu item —
  // switches this same form (the create flow's) into edit-and-save-in-place
  // mode, the same way add-entry.tsx's logId param does for log entries.
  const { groupId } = useLocalSearchParams<{ groupId?: string }>();
  const isEditMode = !!groupId;
  const existingGroup = isEditMode ? groups.find((item) => item.id === groupId) : undefined;
  const [name, setName] = useState(() => existingGroup?.name ?? "");
  const [description, setDescription] = useState(() => existingGroup?.description ?? "");
  const [currency, setCurrency] = useState(
    () => existingGroup?.currency ?? getDeviceDefaultCurrency()
  );
  const [isPickerVisible, setIsPickerVisible] = useState(false);
  // Picked once when the form opens and rerolled on demand — whatever's
  // showing here is exactly what gets written to the group (see
  // create_group in schema.sql, or updateGroup for edit mode), never
  // re-derived afterward. In edit mode this starts at the group's current
  // motive/hue rather than a fresh random one, so shuffling starts from what
  // the group already looks like.
  const [heroPick, setHeroPick] = useState(() =>
    existingGroup
      ? { motive: existingGroup.heroMotive, hue: existingGroup.heroHue }
      : pickRandomHeroMotive()
  );
  // The group's existing remote photo (edit mode only) — separate from
  // pickedPhoto below since it's already a URL, not a local asset to
  // re-upload. Cleared (set to null) by the "remove photo" button to revert
  // to the motive instead of re-uploading it unchanged.
  const [currentPhotoUrl, setCurrentPhotoUrl] = useState(() => existingGroup?.photoUrl ?? null);
  // A real photo takes over the hero in place of the motive when set (see
  // the render below), but is only staged locally here — it's uploaded to
  // Storage exactly once, in handleSubmit, so swapping/discarding it before
  // submitting never leaves an orphaned file with no group pointing to it.
  // Only `.uri` is ever read below, so a plain `{ uri }` (rather than the
  // full ImagePickerAsset) is enough — and it's what lets a PhotoCropModal
  // result (see rawCropUri below), which is also just a uri, slot in here.
  const [pickedPhoto, setPickedPhoto] = useState<{ uri: string } | null>(null);
  // A freshly-picked, not-yet-cropped photo on iOS (see handlePickPhoto) —
  // set only long enough to drive the PhotoCropModal below; its result (or
  // a cancel) clears this back to null.
  const [rawCropUri, setRawCropUri] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const hasPhoto = !!pickedPhoto || !!currentPhotoUrl;
  const canSubmit =
    name.trim().length > 0 && !isSubmitting && (!isEditMode || !!existingGroup);

  // Shared by both the camera icon (motive mode) and the gallery icon (photo
  // mode, to swap the current pick) — same permission + picker call either
  // way, only the resulting state transition differs at the call site.
  const handlePickPhoto = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        "Photo access needed",
        "Allow photo library access in your device settings to set a group photo."
      );
      return;
    }

    // iOS's own editing screen can only crop to a square (an
    // expo-image-picker/UIImagePickerController limitation — `aspect` is
    // Android-only), which would misrepresent the card/hero's real wide
    // shape, so iOS skips it entirely and gets the raw pick routed through
    // PhotoCropModal instead. Android's native editor honors `aspect`
    // correctly, so it keeps using it directly. Web has no editing UI either
    // way, so this is a no-op there.
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: Platform.OS === "android",
      aspect: [windowWidth - CARD_HORIZONTAL_PADDING * 2, windowHeight * CARD_HEIGHT_RATIO],
      quality: 0.7,
    });
    const asset = result.assets?.[0];
    if (result.canceled || !asset) return;

    if (Platform.OS === "ios") {
      setRawCropUri(asset.uri);
    } else {
      setPickedPhoto(asset);
    }
  };

  // Reverts to the motive placeholder — the top-left button's action once a
  // photo (freshly picked or the group's existing one) is showing.
  const handleRemovePhoto = () => {
    setPickedPhoto(null);
    setCurrentPhotoUrl(null);
  };

  const handleSubmit = async () => {
    const userId = session?.user.id;
    if (!canSubmit || !userId) return;
    if (isEditMode && !existingGroup) return;

    setIsSubmitting(true);
    try {
      let photoUrl = currentPhotoUrl;

      if (pickedPhoto) {
        // Always a fresh key (unlike the avatar's fixed "{user_id}/avatar"
        // slot) since one user creates many groups — nothing to overwrite,
        // so no upsert needed.
        const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2)}`;
        let contentType = "image/jpeg";
        let fileData: Blob | ArrayBuffer;
        if (Platform.OS === "web") {
          const blob = await (await fetch(pickedPhoto.uri)).blob();
          contentType = blob.type || contentType;
          fileData = blob;
        } else {
          fileData = decodeBase64(await new File(pickedPhoto.uri).base64());
        }

        const { error: uploadError } = await supabase.storage
          .from("group-photos")
          .upload(path, fileData, { contentType });
        if (uploadError) throw uploadError;

        photoUrl = supabase.storage.from("group-photos").getPublicUrl(path).data.publicUrl;
      }

      if (isEditMode && existingGroup) {
        await updateGroup(existingGroup.id, {
          name: name.trim(),
          description: description.trim(),
          heroMotive: heroPick.motive,
          heroHue: heroPick.hue,
          photoUrl,
        });

        const newCurrency = currency.trim() || existingGroup.currency;
        if (newCurrency !== existingGroup.currency) {
          const { error } = await changeGroupCurrency(
            existingGroup.id,
            existingGroup.currency,
            newCurrency
          );
          if (error) {
            Alert.alert("Couldn't change currency", error);
            return;
          }
          // change_group_currency rescales every log's converted_amount
          // server-side, but useLogs' own cached copy doesn't know that
          // happened — without this, balances would keep showing pre-rescale
          // numbers under the new currency label until something else
          // happened to trigger a logs refresh.
          await refreshLogs();
        }
      } else {
        await addGroup(
          name.trim(),
          description.trim(),
          currency.trim(),
          heroPick.motive,
          heroPick.hue,
          photoUrl
        );
      }
      router.back();
    } catch (error) {
      console.warn(isEditMode ? "Failed to update group" : "Failed to create group", error);
      Alert.alert(
        isEditMode ? "Couldn't save changes" : "Couldn't create group",
        error instanceof Error ? error.message : "Please try again."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.headerTitle}>{isEditMode ? "Edit group" : "Create a new Group"}</Text>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={24} color={Colors.text} />
        </Pressable>
      </View>

      <View style={[styles.hero, { height: windowHeight * HERO_HEIGHT_RATIO }]}>
        {pickedPhoto ? (
          <Image source={{ uri: pickedPhoto.uri }} style={styles.heroPhoto} resizeMode="cover" />
        ) : currentPhotoUrl ? (
          <Image source={{ uri: currentPhotoUrl }} style={styles.heroPhoto} resizeMode="cover" />
        ) : (
          <HeroMotive motive={heroPick.motive} hue={heroPick.hue} fill="92%" verticalAlign="bottom" />
        )}
        <Pressable
          style={[styles.heroButton, styles.heroButtonTop]}
          onPress={hasPhoto ? handleRemovePhoto : handlePickPhoto}
          hitSlop={12}
        >
          <Ionicons name={hasPhoto ? "color-palette-outline" : "camera"} size={20} color="#fff" />
        </Pressable>
        <Pressable
          style={[styles.heroButton, styles.heroButtonBottom]}
          onPress={hasPhoto ? handlePickPhoto : () => setHeroPick(pickRandomHeroMotive())}
          hitSlop={12}
        >
          <Ionicons name={hasPhoto ? "images-outline" : "shuffle"} size={20} color="#fff" />
        </Pressable>
      </View>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.form}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.field}>
          <Text style={styles.label}>Group name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. Summer Trip"
            placeholderTextColor={Colors.muted}
            style={styles.input}
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Currency</Text>
          <Pressable style={styles.input} onPress={() => setIsPickerVisible(true)}>
            <Text style={currency ? styles.inputValue : styles.inputPlaceholder}>
              {currency || "Select a currency"}
            </Text>
          </Pressable>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Description</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="What's this group for?"
            placeholderTextColor={Colors.muted}
            style={[styles.input, styles.textArea]}
            multiline
            textAlignVertical="top"
            maxLength={GROUP_DESCRIPTION_MAX_LENGTH}
          />
          <Text style={styles.charCount}>
            {description.length}/{GROUP_DESCRIPTION_MAX_LENGTH} characters
          </Text>
        </View>

        <Pressable
          style={[styles.createButton, !canSubmit && styles.createButtonDisabled]}
          onPress={handleSubmit}
          disabled={!canSubmit}
        >
          <Text style={styles.createButtonText}>
            {isSubmitting
              ? isEditMode
                ? "Saving…"
                : "Creating…"
              : isEditMode
                ? "Save changes"
                : "Create group"}
          </Text>
        </Pressable>
      </ScrollView>

      <CurrencyPickerModal
        visible={isPickerVisible}
        selectedCode={currency}
        onSelect={(code) => {
          setCurrency(code);
          setIsPickerVisible(false);
        }}
        onClose={() => setIsPickerVisible(false)}
      />

      {rawCropUri && (
        <PhotoCropModal
          imageUri={rawCropUri}
          aspectRatio={(windowWidth - CARD_HORIZONTAL_PADDING * 2) / (windowHeight * CARD_HEIGHT_RATIO)}
          onCancel={() => setRawCropUri(null)}
          onCropped={(uri) => {
            setPickedPhoto({ uri });
            setRawCropUri(null);
          }}
        />
      )}
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
  hero: {
    backgroundColor: Colors.border,
    overflow: "hidden",
  },
  heroPhoto: {
    width: "100%",
    height: "100%",
  },
  heroButton: {
    position: "absolute",
    left: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(17, 24, 28, 0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  heroButtonTop: {
    top: 12,
  },
  heroButtonBottom: {
    top: 56,
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
  inputValue: {
    fontSize: 16,
    color: Colors.text,
  },
  inputPlaceholder: {
    fontSize: 16,
    color: Colors.muted,
  },
  textArea: {
    height: 120,
  },
  charCount: {
    fontSize: 12,
    color: Colors.muted,
    textAlign: "right",
  },
  createButton: {
    backgroundColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
  },
  createButtonDisabled: {
    opacity: 0.5,
  },
  createButtonText: {
    color: Colors.accentText,
    fontSize: 16,
    fontWeight: "600",
  },
});
