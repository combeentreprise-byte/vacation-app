import { router } from "expo-router";
import { Alert, StyleSheet, Text, View } from "react-native";

import { GroupForm, type GroupFormValues } from "@/components/group-form";
import { OnboardingHeader } from "@/components/onboarding-header";
import { Colors } from "@/constants/colors";
import { useOnboarding } from "@/hooks/use-onboarding";

export default function OnboardingGroupScreen() {
  const { draft, setGroup } = useOnboarding();

  const handleSubmit = async (values: GroupFormValues) => {
    const { error } = await setGroup(values);
    if (error) {
      Alert.alert("Couldn't save your group", error);
      return;
    }
    router.push("/onboarding/sign-up");
  };

  // Also drops a group set up on an earlier visit to this step.
  const handleSkip = async () => {
    await setGroup(null);
    router.push("/onboarding/sign-up");
  };

  const savedGroup = draft.group;

  return (
    <GroupForm
      header={
        <>
          <OnboardingHeader
            step={2}
            onBack={() => router.back()}
            action={{ label: "Skip", onPress: handleSkip }}
          />
          <View style={styles.intro}>
            <Text style={styles.title}>Create your first group</Text>
            <Text style={styles.subtitle}>
              A trip, a flat, a weekend away. You can invite everyone once you&apos;re signed up.
            </Text>
          </View>
        </>
      }
      initialValues={
        savedGroup
          ? {
              name: savedGroup.name,
              description: savedGroup.description,
              currency: savedGroup.currency,
              motive: savedGroup.motive,
              hue: savedGroup.hue,
              photoUri: savedGroup.photo?.uri ?? null,
            }
          : undefined
      }
      submitLabel="Continue"
      submittingLabel="Saving…"
      onSubmit={handleSubmit}
    />
  );
}

const styles = StyleSheet.create({
  intro: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    gap: 6,
    backgroundColor: Colors.background,
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
});
