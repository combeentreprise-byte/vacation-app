import * as Crypto from "expo-crypto";
import { router } from "expo-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Alert } from "react-native";

import type { GroupFormValues } from "@/components/group-form";
import { useAuth } from "@/hooks/use-auth";
import { useGroups } from "@/hooks/use-groups";
import { useProfile } from "@/hooks/use-profile";
import { uploadGroupPhoto } from "@/utils/group-photo";
import {
  deleteStoredImage,
  onboardingFilesDirectory,
  readSharedData,
  storePickedImage,
  type StoredImage,
  writeSharedData,
} from "@/utils/offline-storage";

export type OnboardingGroup = Omit<GroupFormValues, "photo"> & {
  photo: StoredImage | null;
};

// What someone sets up during onboarding (app/onboarding/), before there's
// an account to save any of it to. Kept on the device rather than only in
// memory: web's Google sign-in leaves the app entirely and comes back as a
// fresh page load.
export type OnboardingDraft = {
  name: string;
  avatar: StoredImage | null;
  group: OnboardingGroup | null;
  // Set by the last step right before it starts signing up. Only a session
  // that arrives while this is set gets the draft saved to it — the sign-in
  // screen clears it, so an existing account signing in never gets a
  // half-finished onboarding (say, a Google sign-up backed out of) written
  // over its name and picture.
  isSigningUp: boolean;
};

const EMPTY_DRAFT: OnboardingDraft = { name: "", avatar: null, group: null, isSigningUp: false };

const DRAFT_KEY = "onboarding-draft";
const HAS_SIGNED_IN_KEY = "has-signed-in";

type OnboardingContextValue = {
  isLoaded: boolean;
  // Whether any account has ever signed in on this device — decides whether
  // a signed-out user lands on onboarding or on the sign-in screen (see
  // app/_layout.tsx).
  hasSignedInOnDevice: boolean;
  // From the moment a just-signed-up session appears until the draft has
  // been saved to the new account.
  isFinishing: boolean;
  draft: OnboardingDraft;
  setName: (name: string) => void;
  setAvatar: (pickedUri: string | null) => Promise<{ error?: string }>;
  // null = skipped.
  setGroup: (values: GroupFormValues | null) => Promise<{ error?: string }>;
  beginSignUp: () => Promise<void>;
  cancelSignUp: () => void;
};

const OnboardingContext = createContext<OnboardingContextValue | undefined>(undefined);

function hasContent(draft: OnboardingDraft) {
  return !!draft.name || !!draft.avatar || !!draft.group;
}

function storeOnboardingImage(pickedUri: string, prefix: string) {
  return storePickedImage(pickedUri, onboardingFilesDirectory, `${prefix}-${Crypto.randomUUID()}.jpg`);
}

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const { isLoaded: isProfileLoaded, updateName, updateAvatar } = useProfile();
  const { addGroup } = useGroups();
  const [draft, setDraft] = useState<OnboardingDraft>(EMPTY_DRAFT);
  const [hasSignedInOnDevice, setHasSignedInOnDevice] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  // Source of truth between renders — setAvatar/setGroup and applyDraft
  // span awaits.
  const draftRef = useRef<OnboardingDraft>(EMPTY_DRAFT);
  const isApplyingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      readSharedData<OnboardingDraft>(DRAFT_KEY),
      readSharedData<boolean>(HAS_SIGNED_IN_KEY),
    ]).then(([storedDraft, storedHasSignedIn]) => {
      if (cancelled) return;
      draftRef.current = storedDraft ?? EMPTY_DRAFT;
      setDraft(draftRef.current);
      setHasSignedInOnDevice(!!storedHasSignedIn);
      setIsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Kept on the device before it's shown, so nothing on screen (like
  // isFinishing's overlay) ever runs ahead of what a restart would find.
  const saveDraft = useCallback(async (next: OnboardingDraft) => {
    draftRef.current = next;
    await writeSharedData(DRAFT_KEY, next);
    setDraft(draftRef.current);
  }, []);

  const discardDraft = useCallback(async () => {
    const { avatar, group } = draftRef.current;
    await saveDraft(EMPTY_DRAFT);
    if (avatar) deleteStoredImage(avatar);
    if (group?.photo) deleteStoredImage(group.photo);
  }, [saveDraft]);

  const setName = useCallback(
    (name: string) => {
      saveDraft({ ...draftRef.current, name });
    },
    [saveDraft]
  );

  const setAvatar = useCallback(
    async (pickedUri: string | null) => {
      let avatar: StoredImage | null = null;
      if (pickedUri) {
        try {
          avatar = await storeOnboardingImage(pickedUri, "avatar");
        } catch (error) {
          console.warn("Failed to store picked avatar", error);
          return { error: error instanceof Error ? error.message : "Please try again." };
        }
      }
      const replaced = draftRef.current.avatar;
      await saveDraft({ ...draftRef.current, avatar });
      if (replaced) deleteStoredImage(replaced);
      return {};
    },
    [saveDraft]
  );

  const setGroup = useCallback(
    async (values: GroupFormValues | null) => {
      const previousPhoto = draftRef.current.group?.photo ?? null;
      let group: OnboardingGroup | null = null;
      if (values) {
        const { photo, ...rest } = values;
        // A photo that isn't new is the one the form was opened with, i.e.
        // the copy already kept here.
        let storedPhoto = photo && !photo.isNew ? previousPhoto : null;
        if (photo?.isNew) {
          try {
            storedPhoto = await storeOnboardingImage(photo.uri, "group");
          } catch (error) {
            console.warn("Failed to store picked group photo", error);
            return { error: error instanceof Error ? error.message : "Please try again." };
          }
        }
        group = { ...rest, photo: storedPhoto };
      }
      await saveDraft({ ...draftRef.current, group });
      if (previousPhoto && previousPhoto.uri !== group?.photo?.uri) deleteStoredImage(previousPhoto);
      return {};
    },
    [saveDraft]
  );

  const beginSignUp = useCallback(
    () => saveDraft({ ...draftRef.current, isSigningUp: true }),
    [saveDraft]
  );

  const cancelSignUp = useCallback(() => {
    if (draftRef.current.isSigningUp) saveDraft({ ...draftRef.current, isSigningUp: false });
  }, [saveDraft]);

  // Saves a finished onboarding to the account that was just created for it.
  const applyDraft = useCallback(
    async (newUserId: string, current: OnboardingDraft) => {
      const problems: string[] = [];

      // The name and picture go through ProfileProvider's own queue, which
      // keeps retrying by itself if the connection drops.
      if (current.name) updateName(current.name);
      if (current.avatar) {
        const { error } = await updateAvatar(current.avatar.uri);
        if (error) problems.push(`Your profile picture couldn't be saved: ${error}`);
        deleteStoredImage(current.avatar);
      }
      // Saved as done straight away, so if the app is closed partway through
      // only the group is left to retry next launch.
      await saveDraft({ ...draftRef.current, name: "", avatar: null });

      let groupId: string | undefined;
      if (current.group) {
        const { photo, ...group } = current.group;
        let photoUrl: string | null = null;
        if (photo) {
          try {
            photoUrl = await uploadGroupPhoto(newUserId, photo.uri);
          } catch (error) {
            console.warn("Failed to upload onboarding group photo", error);
            problems.push("Your group's photo couldn't be uploaded. You can add it again from Edit group.");
          }
        }
        const result = await addGroup(
          group.name,
          group.description,
          group.currency,
          group.motive,
          group.hue,
          photoUrl
        );
        if (result.error) {
          problems.push(
            `"${group.name}" couldn't be created: ${result.error}. You can create it from the Groups tab.`
          );
        }
        groupId = result.id;
      }

      await discardDraft();

      // Lands them in their new group with the invite share sheet open,
      // since getting friends in is the whole point of the group. If
      // something needs an alert, it goes first and the share is left to
      // the group's own menu instead: iOS can't present both at once.
      if (groupId) {
        router.push({
          pathname: "/group/[id]",
          params: problems.length === 0 ? { id: groupId, invite: "1" } : { id: groupId },
        });
      }
      if (problems.length > 0) {
        Alert.alert("Some of your setup didn't save", problems.join("\n\n"));
      }
    },
    [updateName, updateAvatar, addGroup, saveDraft, discardDraft]
  );

  // Remembered from the first time any account is signed in on this device.
  if (isLoaded && userId && !hasSignedInOnDevice) setHasSignedInOnDevice(true);
  useEffect(() => {
    if (hasSignedInOnDevice) writeSharedData(HAS_SIGNED_IN_KEY, true);
  }, [hasSignedInOnDevice]);

  useEffect(() => {
    // Waits for the new account's profile to finish loading, so the queued
    // name/picture can't be overwritten by that first load landing late.
    if (!isLoaded || !userId || !isProfileLoaded || isApplyingRef.current) return;
    if (!hasContent(draft) && !draft.isSigningUp) return;

    if (!draft.isSigningUp) {
      // Signed in some other way (the sign-in screen, a password reset
      // link), so nothing here belongs to this account.
      discardDraft();
      return;
    }

    isApplyingRef.current = true;
    applyDraft(userId, draft)
      .catch((error) => {
        // Never leave isFinishing's overlay stuck up over the app.
        console.warn("Failed to finish onboarding", error);
        return discardDraft();
      })
      .finally(() => {
        isApplyingRef.current = false;
      });
  }, [isLoaded, userId, isProfileLoaded, draft, applyDraft, discardDraft]);

  return (
    <OnboardingContext.Provider
      value={{
        isLoaded,
        hasSignedInOnDevice,
        isFinishing: !!userId && draft.isSigningUp,
        draft,
        setName,
        setAvatar,
        setGroup,
        beginSignUp,
        cancelSignUp,
      }}
    >
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding() {
  const context = useContext(OnboardingContext);
  if (!context) {
    throw new Error("useOnboarding must be used within an OnboardingProvider");
  }
  return context;
}
