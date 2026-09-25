/* eslint-disable react-hooks/immutability -- Reanimated SharedValues are
 * meant to be mutated via `.value` directly on the UI thread; that's the
 * documented API, not an accidental React-state mutation. The React
 * Compiler-derived rule doesn't yet recognize that pattern and flags every
 * `.value =` in this file as illegal once one is also read in a useEffect
 * (the initial-load reset below), which would otherwise make the gesture
 * handlers below impossible to write. */
import { Ionicons } from "@expo/vector-icons";
import { SaveFormat, useImageManipulator } from "expo-image-manipulator";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";

// iOS's own photo-editing screen can only crop to a square (a real
// UIImagePickerController limitation, not an expo-image-picker gap — its
// `aspect` option is Android-only per its own type docs), so on iOS
// new-group.tsx skips that editor entirely and routes the raw pick through
// this screen instead, to get a crop matching the group card's real shape.
const MAX_SCALE_MULTIPLIER = 4;
const VIEWPORT_WIDTH_RATIO = 0.92;
const VIEWPORT_MAX_HEIGHT_RATIO = 0.6;

type PhotoCropModalProps = {
  imageUri: string;
  aspectRatio: number; // width / height
  onCancel: () => void;
  onCropped: (uri: string) => void;
};

export function PhotoCropModal({ imageUri, aspectRatio, onCancel, onCropped }: PhotoCropModalProps) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const manipulatorContext = useImageManipulator(imageUri);

  useEffect(() => {
    let cancelled = false;
    Image.getSize(
      imageUri,
      (width, height) => {
        if (!cancelled) setNaturalSize({ width, height });
      },
      (error) => {
        console.warn("Failed to read photo dimensions", error);
        if (!cancelled) onCancel();
      }
    );
    return () => {
      cancelled = true;
    };
  }, [imageUri, onCancel]);

  let viewportWidth = windowWidth * VIEWPORT_WIDTH_RATIO;
  let viewportHeight = viewportWidth / aspectRatio;
  const maxViewportHeight = windowHeight * VIEWPORT_MAX_HEIGHT_RATIO;
  if (viewportHeight > maxViewportHeight) {
    viewportHeight = maxViewportHeight;
    viewportWidth = viewportHeight * aspectRatio;
  }

  // Fallback 1x1 "natural size" before the real dimensions load — irrelevant
  // in practice since the gesture-driven image below isn't mounted until
  // naturalSize is set (see the render below), but hooks below need a value
  // on every render regardless of load state.
  const naturalWidth = naturalSize?.width ?? 1;
  const naturalHeight = naturalSize?.height ?? 1;
  // The smallest scale that still fully covers the viewport — also the
  // starting scale, with translate at 0/0, so an untouched image already
  // crops sanely (the same center-crop a plain `cover` fit would produce).
  const minScale = Math.max(viewportWidth / naturalWidth, viewportHeight / naturalHeight);
  const maxScale = minScale * MAX_SCALE_MULTIPLIER;

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  useEffect(() => {
    if (!naturalSize) return;
    scale.value = minScale;
    savedScale.value = minScale;
    translateX.value = 0;
    translateY.value = 0;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
    // Only the initial load (and a genuinely new image) should reset the
    // user's pan/zoom — minScale itself is derived from naturalSize plus
    // constants, so re-running whenever it wobbles by a float epsilon would
    // fight the gesture handlers below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [naturalSize]);

  // Keeps the scaled image from ever revealing empty space past the
  // viewport's edges — the max |translate| shrinks as the image is zoomed
  // out toward minScale (where it's exactly 0, i.e. no pan room at all).
  const clamp = (value: number, limit: number) => {
    "worklet";
    return Math.min(limit, Math.max(-limit, value));
  };

  const panGesture = Gesture.Pan()
    .onUpdate((event) => {
      const maxX = Math.max(0, (naturalWidth * scale.value - viewportWidth) / 2);
      const maxY = Math.max(0, (naturalHeight * scale.value - viewportHeight) / 2);
      translateX.value = clamp(savedTranslateX.value + event.translationX, maxX);
      translateY.value = clamp(savedTranslateY.value + event.translationY, maxY);
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const pinchGesture = Gesture.Pinch()
    .onUpdate((event) => {
      const nextScale = Math.min(maxScale, Math.max(minScale, savedScale.value * event.scale));
      scale.value = nextScale;
      const maxX = Math.max(0, (naturalWidth * nextScale - viewportWidth) / 2);
      const maxY = Math.max(0, (naturalHeight * nextScale - viewportHeight) / 2);
      translateX.value = clamp(translateX.value, maxX);
      translateY.value = clamp(translateY.value, maxY);
    })
    .onEnd(() => {
      savedScale.value = scale.value;
    });

  const composedGesture = Gesture.Simultaneous(panGesture, pinchGesture);

  const imageAnimatedStyle = useAnimatedStyle(() => ({
    width: naturalWidth * scale.value,
    height: naturalHeight * scale.value,
    left: viewportWidth / 2 - (naturalWidth * scale.value) / 2 + translateX.value,
    top: viewportHeight / 2 - (naturalHeight * scale.value) / 2 + translateY.value,
  }));

  const handleDone = async () => {
    if (!naturalSize || isProcessing) return;
    setIsProcessing(true);
    try {
      const finalScale = scale.value;
      const rawOriginX =
        naturalWidth / 2 - viewportWidth / (2 * finalScale) - translateX.value / finalScale;
      const rawOriginY =
        naturalHeight / 2 - viewportHeight / (2 * finalScale) - translateY.value / finalScale;
      const width = viewportWidth / finalScale;
      const height = viewportHeight / finalScale;
      const originX = Math.min(Math.max(0, rawOriginX), naturalWidth - width);
      const originY = Math.min(Math.max(0, rawOriginY), naturalHeight - height);

      manipulatorContext.crop({ originX, originY, width, height });
      const rendered = await manipulatorContext.renderAsync();
      const result = await rendered.saveAsync({ format: SaveFormat.JPEG });
      onCropped(result.uri);
    } catch (error) {
      console.warn("Failed to crop photo", error);
      Alert.alert("Couldn't crop photo", "Please try again.");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <Modal animationType="slide" onRequestClose={onCancel}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={onCancel} hitSlop={12} disabled={isProcessing}>
            <Ionicons name="close" size={24} color="#fff" />
          </Pressable>
          <Text style={styles.headerTitle}>Move and Scale</Text>
          <Pressable onPress={handleDone} hitSlop={12} disabled={!naturalSize || isProcessing}>
            {isProcessing ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Ionicons name="checkmark" size={26} color="#fff" />
            )}
          </Pressable>
        </View>

        <View style={styles.stage}>
          {naturalSize ? (
            <GestureDetector gesture={composedGesture}>
              <View style={[styles.viewport, { width: viewportWidth, height: viewportHeight }]}>
                <Animated.Image
                  source={{ uri: imageUri }}
                  style={[styles.image, imageAnimatedStyle]}
                />
              </View>
            </GestureDetector>
          ) : (
            <ActivityIndicator color="#fff" />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 16,
  },
  headerTitle: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  stage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  viewport: {
    overflow: "hidden",
  },
  image: {
    position: "absolute",
  },
});
