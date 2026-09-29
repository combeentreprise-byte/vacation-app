import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { getInitials } from "@/components/avatar";
import { OnboardingHeader } from "@/components/onboarding-header";
import { Colors } from "@/constants/colors";
import { PROFILE_NAME_MAX_LENGTH } from "@/constants/limits";
import { useOnboarding } from "@/hooks/use-onboarding";

const AVATAR_SIZE = 112;

export default function OnboardingProfileScreen() {
  const { draft, setName, setAvatar } = useOnboarding();
  const [name, setNameInput] = useState(draft.name);
  const [isStoringPhoto, setIsStoringPhoto] = useState(false);
  const trimmedName = name.trim();

  const handlePickPhoto = async () => {
    if (isStoringPhoto) return;

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

    setIsStoringPhoto(true);
    try {
      const { error } = await setAvatar(asset.uri);
      if (error) Alert.alert("Couldn't use that photo", error);
    } finally {
      setIsStoringPhoto(false);
    }
  };

  const handleContinue = () => {
    if (!trimmedName) return;
    setName(trimmedName);
    router.push("/onboarding/group");
  };

  // Back to the sign-in screen if that's where this came from, rather than
  // stacking another one on top.
  const handleSignIn = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.push("/sign-in");
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <OnboardingHeader step={1} />

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.intro}>
          <Text style={styles.title}>What should we call you?</Text>
          <Text style={styles.subtitle}>
            This is how you&apos;ll show up to friends in your groups.
          </Text>
        </View>

        <View style={styles.avatarSection}>
          <Pressable
            onPress={handlePickPhoto}
            disabled={isStoringPhoto}
            accessibilityRole="button"
            accessibilityLabel={draft.avatar ? "Change profile picture" : "Add a profile picture"}
          >
            <View style={styles.avatar}>
              {draft.avatar ? (
                <Image source={{ uri: draft.avatar.uri }} style={styles.avatarImage} />
              ) : trimmedName ? (
                <Text style={styles.avatarText}>{getInitials(trimmedName)}</Text>
              ) : (
                <Ionicons name="person" size={48} color={Colors.accentTextMuted} />
              )}
            </View>
            <View style={styles.cameraBadge}>
              {isStoringPhoto ? (
                <ActivityIndicator size="small" color={Colors.accentText} />
              ) : (
                <Ionicons name="camera" size={16} color={Colors.accentText} />
              )}
            </View>
          </Pressable>

          <View style={styles.photoLinks}>
            <Pressable onPress={handlePickPhoto} disabled={isStoringPhoto} hitSlop={8}>
              <Text style={styles.linkText}>{draft.avatar ? "Change photo" : "Add a photo"}</Text>
            </Pressable>
            {draft.avatar ? (
              <Pressable onPress={() => setAvatar(null)} disabled={isStoringPhoto} hitSlop={8}>
                <Text style={styles.removeText}>Remove</Text>
              </Pressable>
            ) : (
              <Text style={styles.optionalText}>Optional</Text>
            )}
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Your name</Text>
          <TextInput
            value={name}
            onChangeText={setNameInput}
            placeholder="e.g. Alex"
            placeholderTextColor={Colors.muted}
            autoCapitalize="words"
            autoComplete="name"
            textContentType="name"
            returnKeyType="next"
            onSubmitEditing={handleContinue}
            style={styles.input}
            maxLength={PROFILE_NAME_MAX_LENGTH}
          />
        </View>

        <Pressable
          style={[styles.continueButton, !trimmedName && styles.continueButtonDisabled]}
          onPress={handleContinue}
          disabled={!trimmedName}
        >
          <Text style={styles.continueButtonText}>Continue</Text>
        </Pressable>

        <Pressable onPress={handleSignIn} hitSlop={8}>
          <Text style={styles.signInText}>Already have an account? Sign in</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    padding: 20,
    gap: 24,
  },
  intro: {
    gap: 8,
  },
  title: {
    fontSize: 26,
    fontWeight: "800",
    color: Colors.text,
  },
  subtitle: {
    fontSize: 15,
    color: Colors.muted,
  },
  avatarSection: {
    alignItems: "center",
    gap: 12,
  },
  avatar: {
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
  avatarText: {
    color: Colors.accentText,
    fontSize: 38,
    fontWeight: "700",
  },
  cameraBadge: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 3,
    borderColor: Colors.background,
    backgroundColor: Colors.text,
    alignItems: "center",
    justifyContent: "center",
  },
  photoLinks: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  linkText: {
    fontSize: 15,
    fontWeight: "500",
    color: Colors.accent,
  },
  removeText: {
    fontSize: 15,
    color: Colors.danger,
  },
  optionalText: {
    fontSize: 13,
    color: Colors.muted,
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
  continueButton: {
    backgroundColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  continueButtonDisabled: {
    opacity: 0.5,
  },
  continueButtonText: {
    color: Colors.accentText,
    fontSize: 16,
    fontWeight: "600",
  },
  signInText: {
    fontSize: 14,
    color: Colors.accent,
    textAlign: "center",
    fontWeight: "500",
  },
});
