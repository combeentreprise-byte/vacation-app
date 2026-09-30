import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { type ReactNode, useEffect, useState } from "react";
import {
  Alert,
  Animated,
  Easing,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CurrencyPickerModal } from "@/components/currency-picker";
import { PopHeroMotive } from "@/components/hero-motive";
import { PhotoCropModal } from "@/components/photo-crop-modal";
import { FocusTextInput, PressableScale } from "@/components/press-feedback";
import { Colors } from "@/constants/colors";
import {
  GROUP_DESCRIPTION_MAX_LENGTH,
  GROUP_DESCRIPTION_MAX_LINES,
  GROUP_NAME_MAX_LENGTH,
} from "@/constants/limits";
import { useLineLimit } from "@/hooks/use-line-limit";
import { getDeviceDefaultCurrency } from "@/utils/device-currency";
import { pickRandomHeroMotive } from "@/utils/hero-motive";

// Matches the group detail screen's hero proportions (see HERO_HEIGHT_RATIO
// in group/[id].tsx) so a group's look is visually consistent from the
// moment it's previewed here through to its own detail screen later.
const HERO_HEIGHT_RATIO = 0.28;

// The photo picker's crop rectangle targets the group list card's shape
// (see CARD_HEIGHT_RATIO and the list's padding in (tabs)/index.tsx) rather
// than this form's own hero above — the card is squatter/wider, and it's
// the more frequently-seen view, so a mismatch there is worth avoiding more
// than a mismatch on the hero (which still `cover`-fits reasonably).
const CARD_HEIGHT_RATIO = 0.2;
const CARD_HORIZONTAL_PADDING = 20;

// Duration of the top-left hero buttons' single coin-flip turn when the view
// is actually switched — see runHeroButtonFlip below.
const HERO_BUTTON_FLIP_DURATION_MS = 650;

// The two icons a hero button face (below) can show — kept as a narrow union
// rather than Ionicons' full glyph-name type since only these four ever
// appear on the hero buttons.
type HeroButtonIconName = "business-outline" | "camera" | "images-outline" | "shuffle";

// One full face of a hero button — the tinted circle *and* its icon together
// (not just the icon), rotated as a single unit — plus its own press-tint
// overlay so the darkening in HeroButton below shows through on whichever
// face currently faces the viewer.
function HeroButtonFace({
  icon,
  rotate,
  tintOpacity,
}: {
  icon: HeroButtonIconName;
  rotate: Animated.AnimatedInterpolation<string>;
  tintOpacity: Animated.AnimatedInterpolation<number>;
}) {
  return (
    <Animated.View
      style={[
        styles.heroButtonFace,
        {
          transform: [
            { perspective: 800 },
            { rotateZ: "-45deg" },
            { rotateX: rotate },
            { rotateZ: "45deg" },
          ],
        },
      ]}
    >
      <Animated.View style={[styles.heroButtonTint, { opacity: tintOpacity }]} />
      <Ionicons name={icon} size={20} color="#fff" />
    </Animated.View>
  );
}

// A hero button, e.g. the top-left camera/palette toggle — its whole circle
// (tint + icon together) flips like a single coin turn, hinged on the
// bottom-left-to-top-right diagonal so the motion itself reads as sweeping
// top-left to bottom-right, to switch icons, and grows + darkens on press.
//
// The flip is two full-circle faces (HeroButtonFace) stacked on top of each
// other rather than one circle whose icon glyph swaps mid-animation — a
// plain rotateX/rotateY spin back to identity would need a full 360° to
// land right-side up again, so instead each face's rotateX is wrapped in
// rotateZ(-45deg)/rotateZ(45deg), which tilts a *single* 180° flip onto a
// diagonal axis: rotateZ(-45deg) swings the x-axis — what a bare rotateX
// would hinge on — onto the bottom-left/top-right diagonal before the flip,
// then rotateZ(45deg) swings back. Hinging on *that* diagonal (rather than
// the other one) is what makes the two corners actually swinging through
// the flip — the ones off the hinge line — read as moving top-left to
// bottom-right. The back face is pre-rotated a further 180° so it lands
// upright (not mirrored) exactly when the shared turn completes.
// `backfaceVisibility` hides whichever face is momentarily facing away, so
// only one is ever visible.
//
// Press feedback (scale + tint) is a separate Animated.Value from the flip,
// applied outside both faces so it affects "the whole button" regardless of
// which face is showing, and a plain Pressable style object can't animate
// smoothly — hence the inner Animated.View wrapping while Pressable itself
// only owns hit-testing and position, keeping the tap target's size stable
// regardless of the scale.
function HeroButton({
  style,
  onPress,
  frontIcon,
  backIcon,
  flipProgress,
}: {
  style: StyleProp<ViewStyle>;
  onPress: () => void;
  frontIcon: HeroButtonIconName;
  backIcon: HeroButtonIconName;
  flipProgress: Animated.Value;
}) {
  const [pressAnim] = useState(() => new Animated.Value(0));
  const animateTo = (toValue: number) => {
    Animated.timing(pressAnim, {
      toValue,
      duration: toValue ? 100 : 150,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  };
  const tintOpacity = pressAnim.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.55] });
  const scale = pressAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });
  const frontRotate = flipProgress.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "180deg"] });
  const backRotate = flipProgress.interpolate({ inputRange: [0, 1], outputRange: ["180deg", "360deg"] });
  return (
    <Pressable
      style={style}
      onPress={onPress}
      onPressIn={() => animateTo(1)}
      onPressOut={() => animateTo(0)}
      hitSlop={12}
    >
      <Animated.View style={[styles.heroButtonScale, { transform: [{ scale }] }]}>
        <HeroButtonFace icon={frontIcon} rotate={frontRotate} tintOpacity={tintOpacity} />
        <HeroButtonFace icon={backIcon} rotate={backRotate} tintOpacity={tintOpacity} />
      </Animated.View>
    </Pressable>
  );
}


export type GroupFormValues = {
  name: string;
  description: string;
  currency: string;
  motive: string;
  hue: number;
  // What the hero shows on submit — null when the motive was the final
  // choice. `isNew` marks a photo picked in this form (a local file still to
  // be uploaded), as opposed to the initialValues photo passed back as-is.
  photo: { uri: string; isNew: boolean } | null;
};

export type GroupFormInitialValues = Omit<GroupFormValues, "photo"> & {
  // A photo the group already has: a remote URL when editing a group, or a
  // copy kept on the device when coming back to onboarding's group step.
  photoUri: string | null;
};

type GroupFormProps = {
  // Rendered above the hero — the screen's own header. Never scrolls.
  header: ReactNode;
  // Rendered at the top of the scrolling content, above the hero.
  intro?: ReactNode;
  // Keeps the submit button in a bar pinned to the bottom of the screen
  // (riding up with the keyboard) instead of at the end of the fields, with
  // the hero scrolling along with the fields to leave them room.
  pinSubmitButton?: boolean;
  initialValues?: GroupFormInitialValues;
  submitLabel: string;
  submittingLabel: string;
  // Keeps the submit button disabled whatever the form's own state.
  disabled?: boolean;
  // Errors are the caller's to report; the form just re-enables itself once
  // this settles.
  onSubmit: (values: GroupFormValues) => Promise<void>;
};

// The create/edit-group form (new-group.tsx), also used as onboarding's
// "create your first group" step: a hero showing either a shuffleable motive
// or a picked photo, plus name, currency and description. Saving is left to
// onSubmit, since the two callers save very differently.
export function GroupForm({
  header,
  intro,
  pinSubmitButton = false,
  initialValues,
  submitLabel,
  submittingLabel,
  disabled = false,
  onSubmit,
}: GroupFormProps) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState(() => initialValues?.name ?? "");
  const [description, setDescription] = useState(() => initialValues?.description ?? "");
  const descriptionLineLimit = useLineLimit(description, setDescription, GROUP_DESCRIPTION_MAX_LINES);
  const [currency, setCurrency] = useState(
    () => initialValues?.currency ?? getDeviceDefaultCurrency()
  );
  const [isPickerVisible, setIsPickerVisible] = useState(false);
  // Picked once when the form opens and rerolled on demand — whatever's
  // showing here is exactly what's submitted, never re-derived afterward.
  // With initialValues (editing a group, or coming back to onboarding's
  // group step) this starts at their motive/hue rather than a fresh random
  // one, so shuffling starts from what the group already looks like.
  const [heroPick, setHeroPick] = useState(() =>
    initialValues
      ? { motive: initialValues.motive, hue: initialValues.hue }
      : pickRandomHeroMotive()
  );
  // The photo the form was opened with — separate from pickedPhoto below
  // since it's already saved somewhere (see GroupFormInitialValues), not a
  // new pick. Never reassigned: switching to the motive just hides it
  // (isPhotoMode above) rather than clearing it, so switching back can
  // restore it without a re-upload.
  const currentPhotoUrl = initialValues?.photoUri ?? null;
  // A real photo takes over the hero in place of the motive when set (see
  // the render below), but is only staged locally here — it's handed to
  // onSubmit to upload, so swapping/discarding it before submitting never
  // leaves an orphaned file with no group pointing to it.
  // Only `.uri` is ever read below, so a plain `{ uri }` (rather than the
  // full ImagePickerAsset) is enough — and it's what lets a PhotoCropModal
  // result (see rawCropUri below), which is also just a uri, slot in here.
  const [pickedPhoto, setPickedPhoto] = useState<{ uri: string } | null>(null);
  // A freshly-picked, not-yet-cropped photo on iOS (see handlePickPhoto) —
  // set only long enough to drive the PhotoCropModal below; its result (or
  // a cancel) clears this back to null. Carries the picker's own width/height
  // alongside the uri — PhotoCropModal needs the real pixel dimensions to do
  // its cover-fit math, and re-deriving them from the uri via `Image.getSize`
  // turned out to be unreliable on-device (it was returning a much smaller
  // decoded size than the actual photo for at least some assets, which made
  // every scale/pan calculation downstream wildly too zoomed-in). The picker
  // already knows the true dimensions from the OS, so use those directly.
  const [rawCropAsset, setRawCropAsset] = useState<{
    uri: string;
    width: number;
    height: number;
  } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Whether the hero is currently *showing* the photo vs. the motive — kept
  // separate from whether a photo is actually staged (pickedPhoto/
  // currentPhotoUrl below) so that switching to the motive doesn't discard
  // an already-picked/uploaded photo. That lets switching back restore it
  // instead of re-opening the gallery (see the top-left hero button below).
  const [isPhotoMode, setIsPhotoMode] = useState(() => !!initialValues?.photoUri);
  // Which icons the two hero buttons show at rest — kept separate from
  // isPhotoMode (which drives the hero content swap instantly) so the icon
  // change can ride along with the flip animation below instead of jumping
  // the moment isPhotoMode changes. Only ever diverges from isPhotoMode for
  // the duration of a flip.
  const [iconPhotoMode, setIconPhotoMode] = useState(() => !!initialValues?.photoUri);
  // The icon HeroButton's *back* face shows — i.e. what iconPhotoMode
  // is about to become once a flip in progress finishes. Only meaningful
  // mid-flip (the back layer is otherwise always hidden at rest), but kept
  // in sync outside of flips too so a flip started right after a no-
  // animation icon change (see the two setIconPhotoMode(true) call sites
  // below) never briefly shows a stale back icon.
  const [flipTargetPhotoMode, setFlipTargetPhotoMode] = useState(
    () => !!initialValues?.photoUri
  );
  // useState (not useRef) for the Animated.Value itself — interpolating it
  // below happens during render, and accessing a ref's .current there trips
  // the react-hooks/refs lint rule (see usePopupAnimation for the same
  // pattern elsewhere in the app).
  const [heroButtonFlipAnim] = useState(() => new Animated.Value(0));
  const hasRememberedPhoto = !!pickedPhoto || !!currentPhotoUrl;

  // Flips both hero buttons through a single diagonal 180° turn to
  // nextIconPhotoMode. Only called for an actual view switch — see
  // handleSwitchToMotive/handleRestorePhoto below — never from the
  // no-remembered-photo path where the camera button jumps straight to the
  // gallery instead of toggling a view. Setting heroButtonFlipAnim below
  // interrupts (and no-ops the completion of) any flip already in flight, so
  // rapid re-clicks just redirect the turn rather than stacking animations.
  const runHeroButtonFlip = (nextIconPhotoMode: boolean) => {
    setFlipTargetPhotoMode(nextIconPhotoMode);
    heroButtonFlipAnim.setValue(0);
    Animated.timing(heroButtonFlipAnim, {
      toValue: 1,
      duration: HERO_BUTTON_FLIP_DURATION_MS,
      easing: Easing.inOut(Easing.quad),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) return;
      setIconPhotoMode(nextIconPhotoMode);
      // Deferred a frame rather than reset alongside setIconPhotoMode above:
      // the native driver applies this reset on the UI thread almost
      // immediately, which otherwise wins the race against React's (JS-side)
      // re-render of the front face's Ionicons glyph — snapping the front
      // face back to visible (rotation 0) a frame *before* it's actually
      // showing the new icon, i.e. exactly the old icon flickering back on.
      // Waiting a frame lets that re-render land while the front face is
      // still hidden, so it's already correct by the time it reappears.
      requestAnimationFrame(() => {
        heroButtonFlipAnim.setValue(0);
      });
    });
  };
  const canSubmit = name.trim().length > 0 && !isSubmitting && !disabled;

  // The pinned bar keeps clear of the home indicator, but not while the
  // keyboard is up: the keyboard already covers that strip, and the inset on
  // top of it would leave a gap between the button and the keyboard.
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  useEffect(() => {
    if (!pinSubmitButton) return;
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showListener = Keyboard.addListener(showEvent, () => setIsKeyboardVisible(true));
    const hideListener = Keyboard.addListener(hideEvent, () => setIsKeyboardVisible(false));
    return () => {
      showListener.remove();
      hideListener.remove();
    };
  }, [pinSubmitButton]);

  // Shared by both the camera icon (no remembered photo to restore) and the
  // gallery icon (photo mode, to swap the current pick) — same permission +
  // picker call either way, only the resulting state transition differs at
  // the call site.
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
      setRawCropAsset({ uri: asset.uri, width: asset.width, height: asset.height });
    } else {
      setPickedPhoto(asset);
      setIsPhotoMode(true);
      // No flip here: this is the no-remembered-photo edge case (camera
      // button jumping straight to the gallery), not a view switch, so the
      // icon should just update immediately alongside isPhotoMode.
      setIconPhotoMode(true);
      setFlipTargetPhotoMode(true);
    }
  };

  // Switches the hero to the motive placeholder — the top-left button's
  // action while a photo is showing. Deliberately doesn't clear
  // pickedPhoto/currentPhotoUrl: they stay remembered so switching back
  // (handleRestorePhoto below) can bring the same photo back instead of
  // sending the user to the gallery again.
  const handleSwitchToMotive = () => {
    setIsPhotoMode(false);
    runHeroButtonFlip(false);
  };

  // The top-left button's action while the motive is showing and a photo is
  // still remembered from before — brings it straight back without
  // reopening the gallery. When nothing is remembered, that same button
  // calls handlePickPhoto instead (see the render below).
  const handleRestorePhoto = () => {
    setIsPhotoMode(true);
    runHeroButtonFlip(true);
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;

    setIsSubmitting(true);
    try {
      // Only carries the remembered photo through when the hero is actually
      // in photo mode — switching to the motive and submitting from there
      // means the motive was the user's final choice, even though the photo
      // is still sitting in state in case they switch back first.
      const photo = !isPhotoMode
        ? null
        : pickedPhoto
          ? { uri: pickedPhoto.uri, isNew: true }
          : currentPhotoUrl
            ? { uri: currentPhotoUrl, isNew: false }
            : null;
      await onSubmit({
        name: name.trim(),
        description: description.trim(),
        currency: currency.trim(),
        motive: heroPick.motive,
        hue: heroPick.hue,
        photo,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const hero = (
    <View style={[styles.hero, { height: windowHeight * HERO_HEIGHT_RATIO }]}>
      <PopHeroMotive
        motive={heroPick.motive}
        hue={heroPick.hue}
        fill="92%"
        verticalAlign="bottom"
      />
      {(pickedPhoto || currentPhotoUrl) && (
        // Kept mounted (just hidden) rather than unmounted while in motive
        // mode — a remote currentPhotoUrl is a real network image, and
        // unmounting this <Image> discards its decoded bitmap, forcing a
        // full re-fetch (a visible gray flash while it reloads) the moment
        // isPhotoMode flips back to true. A freshly `pickedPhoto` local
        // file uri doesn't have this problem (already decoded, on-disk),
        // which is why this only ever showed up for a group's pre-existing
        // photo, not a photo just picked in this same editing session.
        <View
          style={[StyleSheet.absoluteFill, !isPhotoMode && styles.heroPhotoLayerHidden]}
          pointerEvents={isPhotoMode ? "auto" : "none"}
        >
          <Image
            source={{ uri: pickedPhoto ? pickedPhoto.uri : currentPhotoUrl! }}
            style={styles.heroPhoto}
            resizeMode="cover"
          />
        </View>
      )}
      <HeroButton
        style={[styles.heroButton, styles.heroButtonTop]}
        onPress={
          isPhotoMode
            ? handleSwitchToMotive
            : hasRememberedPhoto
              ? handleRestorePhoto
              : handlePickPhoto
        }
        frontIcon={iconPhotoMode ? "business-outline" : "camera"}
        backIcon={flipTargetPhotoMode ? "business-outline" : "camera"}
        flipProgress={heroButtonFlipAnim}
      />
      <HeroButton
        style={[styles.heroButton, styles.heroButtonBottom]}
        onPress={isPhotoMode ? handlePickPhoto : () => setHeroPick(pickRandomHeroMotive())}
        frontIcon={iconPhotoMode ? "images-outline" : "shuffle"}
        backIcon={flipTargetPhotoMode ? "images-outline" : "shuffle"}
        flipProgress={heroButtonFlipAnim}
      />
    </View>
  );

  // Disabled dimming lives on a wrapper — PressableScale animates the
  // button's own opacity, which would override it.
  const submitButton = (
    <View
      style={[!pinSubmitButton && styles.createButtonInline, !canSubmit && styles.createButtonDisabled]}
    >
      <PressableScale
        style={styles.createButton}
        pressedScale={0.98}
        onPress={handleSubmit}
        disabled={!canSubmit}
      >
        <Text style={styles.createButtonText}>
          {isSubmitting ? submittingLabel : submitLabel}
        </Text>
      </PressableScale>
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {header}

      {pinSubmitButton ? null : hero}

      <ScrollView style={styles.flex} keyboardShouldPersistTaps="handled">
        {intro}
        {pinSubmitButton ? hero : null}
        <View style={styles.form}>
          <View style={styles.field}>
            <Text style={styles.label}>Group name</Text>
            <FocusTextInput
              value={name}
              onChangeText={setName}
              placeholder="e.g. Summer Trip"
              placeholderTextColor={Colors.muted}
              style={styles.input}
              maxLength={GROUP_NAME_MAX_LENGTH}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Currency</Text>
            <PressableScale
              style={styles.input}
              pressedScale={0.98}
              onPress={() => setIsPickerVisible(true)}
            >
              <Text style={currency ? styles.inputValue : styles.inputPlaceholder}>
                {currency || "Select a currency"}
              </Text>
            </PressableScale>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Description</Text>
            <FocusTextInput
              value={description}
              {...descriptionLineLimit}
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

          {pinSubmitButton ? null : submitButton}
        </View>
      </ScrollView>

      {pinSubmitButton ? (
        <View
          style={[
            styles.submitBar,
            { paddingBottom: SUBMIT_BAR_PADDING + (isKeyboardVisible ? 0 : insets.bottom) },
          ]}
        >
          {submitButton}
        </View>
      ) : null}

      <CurrencyPickerModal
        visible={isPickerVisible}
        selectedCode={currency}
        onSelect={(code) => {
          setCurrency(code);
          setIsPickerVisible(false);
        }}
        onClose={() => setIsPickerVisible(false)}
      />

      {rawCropAsset && (
        <PhotoCropModal
          imageUri={rawCropAsset.uri}
          naturalWidth={rawCropAsset.width}
          naturalHeight={rawCropAsset.height}
          aspectRatio={(windowWidth - CARD_HORIZONTAL_PADDING * 2) / (windowHeight * CARD_HEIGHT_RATIO)}
          onCancel={() => setRawCropAsset(null)}
          onCropped={(uri) => {
            setPickedPhoto({ uri });
            setIsPhotoMode(true);
            // Same no-animation edge case as the Android branch above, just
            // reached via the iOS crop flow instead.
            setIconPhotoMode(true);
            setFlipTargetPhotoMode(true);
            setRawCropAsset(null);
          }}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const SUBMIT_BAR_PADDING = 12;

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  hero: {
    backgroundColor: Colors.border,
    overflow: "hidden",
  },
  heroPhotoLayerHidden: {
    opacity: 0,
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
  },
  heroButtonTop: {
    top: 12,
  },
  heroButtonBottom: {
    top: 56,
  },
  // The animated scale target — sized to fill heroButton exactly so scaling
  // it up doesn't also grow the (static) tap target.
  // Just the scale target — sized to fill heroButton exactly so scaling it
  // up doesn't also grow the (static) tap target. No overflow/border-radius
  // of its own since each heroButtonFace below draws its own circle.
  heroButtonScale: {
    width: "100%",
    height: "100%",
  },
  heroButtonFace: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    backfaceVisibility: "hidden",
  },
  // A separate layer (rather than animating heroButtonFace's own
  // backgroundColor) so its opacity — the "how dark is the tint" knob — can
  // animate independently of the icon sitting on top of it.
  heroButtonTint: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgb(17, 24, 28)",
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
  submitBar: {
    paddingHorizontal: 20,
    paddingTop: SUBMIT_BAR_PADDING,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  createButton: {
    backgroundColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  createButtonInline: {
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
