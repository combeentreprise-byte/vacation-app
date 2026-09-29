import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";

import { Colors } from "@/constants/colors";
import { supabase } from "@/lib/supabase";

export type ScanResult = { amount: number | null; currency: string | null };

type ReceiptScannerProps = {
  // Called with whatever the model found — or with nothing, when the user
  // picks "Enter manually" after a failed read. A missing/invalid amount
  // isn't fatal, add-entry.tsx just falls back to a blank amount field.
  onResult: (result?: ScanResult) => void;
  // Extra space to keep clear at the bottom (the home-indicator inset) when
  // the scanner runs full-height in a modal. The Scan tab leaves it at 0,
  // since the tab bar already sits below the camera there.
  bottomInset?: number;
};

// The camera + capture + receipt-reading flow, shared by the Scan tab (which
// then asks which group it belongs to) and the scan-receipt screen opened
// from Add/Edit entry (which hands the result straight back to that form).
export function ReceiptScanner({ onResult, bottomInset = 0 }: ReceiptScannerProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [isScanning, setIsScanning] = useState(false);
  const cameraRef = useRef<CameraView>(null);

  const handleCapture = async () => {
    if (!cameraRef.current || isScanning) return;
    setIsScanning(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.5 });
      if (!photo?.base64) {
        throw new Error("No photo data");
      }

      const { data, error } = await supabase.functions.invoke<ScanResult>("scan-receipt", {
        body: { image: photo.base64 },
      });

      if (error || !data || "error" in data) {
        Alert.alert(
          "Couldn't scan receipt",
          "Something went wrong reading that photo. You can try again or enter it manually.",
          [
            { text: "Try again", style: "cancel" },
            { text: "Enter manually", onPress: () => onResult() },
          ]
        );
        return;
      }

      if (typeof data.amount !== "number") {
        Alert.alert(
          "Couldn't read an amount",
          "We couldn't find a total on this receipt. You can still log it manually.",
          [
            { text: "Try again", style: "cancel" },
            { text: "Continue", onPress: () => onResult(data) },
          ]
        );
        return;
      }

      onResult(data);
    } catch {
      Alert.alert("Couldn't scan receipt", "Something went wrong. Try again.");
    } finally {
      setIsScanning(false);
    }
  };

  if (!permission) {
    return <View style={styles.container} />;
  }

  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <Ionicons name="camera-outline" size={28} color={Colors.muted} />
        <Text style={styles.permissionText}>
          {permission.canAskAgain
            ? "Allow camera access to scan a receipt."
            : "Camera access is off. Enable it in Settings to scan a receipt."}
        </Text>
        {permission.canAskAgain ? (
          <Pressable onPress={requestPermission}>
            <Text style={styles.permissionButtonText}>Allow camera access</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      {/* CameraView and the overlay are siblings (both absolutely filling
          this container), not overlay-as-children-of-CameraView — that's
          the pattern Expo's own docs use, rather than relying on undocumented
          child-rendering behavior inside the camera preview. */}
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />

      {/* Bottom-bounded at the shutter's top edge (controls: bottom 36 + shutter
          height 72). The lower spacer centers the hint text within itself, so
          its gap to the frame above and to the shutter below always match —
          it's given less flex than the upper spacer just to keep both gaps
          tight rather than spreading the text across all the leftover space. */}
      <View style={[styles.overlay, { bottom: styles.overlay.bottom + bottomInset }]} pointerEvents="none">
        <View style={styles.overlayTopSpacer} />
        <View style={styles.frame} />
        <View style={styles.overlayBottomSpacer}>
          <Text style={styles.overlayHint}>Fit the receipt inside the frame</Text>
        </View>
      </View>

      <View style={[styles.controls, { bottom: styles.controls.bottom + bottomInset }]}>
        <Pressable
          style={[styles.shutter, isScanning && styles.shutterDisabled]}
          onPress={handleCapture}
          disabled={isScanning}
        >
          {isScanning ? (
            <ActivityIndicator color={Colors.accentText} />
          ) : (
            <View style={styles.shutterInner} />
          )}
        </Pressable>
        {isScanning ? <Text style={styles.scanningText}>Reading receipt...</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 32,
  },
  permissionText: {
    color: Colors.muted,
    fontSize: 15,
    textAlign: "center",
  },
  permissionButtonText: {
    color: Colors.accent,
    fontSize: 15,
    fontWeight: "600",
  },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    // Stops at the shutter button's top edge (bottom offset 36 + its 72px
    // height) rather than the screen bottom, so the spacers above/below the
    // frame split the same region the hint text needs to be centered in.
    bottom: 108,
    alignItems: "center",
  },
  overlayTopSpacer: {
    flex: 3,
  },
  overlayBottomSpacer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  frame: {
    width: "72%",
    aspectRatio: 0.65,
    borderWidth: 2,
    borderColor: "rgba(255, 255, 255, 0.85)",
    borderRadius: 16,
  },
  overlayHint: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "500",
  },
  controls: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 36,
    alignItems: "center",
  },
  shutter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "rgba(255, 255, 255, 0.25)",
    borderWidth: 3,
    borderColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  shutterDisabled: {
    opacity: 0.6,
  },
  shutterInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#FFFFFF",
  },
  // Absolutely positioned just under the shutter rather than laid out in the
  // controls column — otherwise its appearance grows the bottom-anchored
  // column and pushes the shutter up into the overlay hint.
  scanningText: {
    position: "absolute",
    top: 72 + 12,
    left: 0,
    right: 0,
    textAlign: "center",
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "500",
  },
});
