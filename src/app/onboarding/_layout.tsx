import { Stack } from "expo-router";

// First-run flow for a new account, entirely before signing up: your name
// (required) and picture (optional), then a first group (skippable), then
// creating the account itself. Everything is held in OnboardingProvider's
// draft until that last step, which saves it all to the new account.
export default function OnboardingLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="group" />
      <Stack.Screen name="sign-up" />
    </Stack>
  );
}
