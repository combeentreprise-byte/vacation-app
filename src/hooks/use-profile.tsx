import * as Crypto from "expo-crypto";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Alert } from "react-native";

import { useAuth } from "@/hooks/use-auth";
import { useSyncTriggers } from "@/hooks/use-sync-triggers";
import { supabase } from "@/lib/supabase";
import { isRetryableStatus, isRetryableStorageError } from "@/utils/network";
import {
  deleteStoredImage,
  readStoredImage,
  readUserData,
  storePickedImage,
  type StoredImage,
  userFilesDirectory,
  writeUserData,
} from "@/utils/offline-storage";

export type Profile = {
  name: string;
  avatarUrl: string | null;
};

const DEFAULT_PROFILE: Profile = {
  name: "Your Name",
  avatarUrl: null,
};

// A new profile picture picked on this device that hasn't been uploaded yet
// (a copy under userFilesDirectory on native — see StoredImage).
type PendingAvatar = StoredImage & {
  // Tells a newer pick apart from the one an in-flight upload is sending.
  id: string;
};

// Profile changes made on this device that haven't reached the server yet
// — same idea as use-logs.tsx's PendingLog queue, but only the latest name
// and the latest picture matter, so each is a single slot rather than a list.
// Kept on the device so an offline change survives the app being closed.
type PendingProfile = {
  name?: string;
  avatar?: PendingAvatar;
};

type ProfileContextValue = {
  // Includes any pending change, so the app shows it everywhere right away.
  profile: Profile;
  isLoaded: boolean;
  updateName: (name: string) => void;
  updateAvatar: (pickedUri: string) => Promise<{ error?: string }>;
  hasPendingChanges: boolean;
};

const ProfileContext = createContext<ProfileContextValue | undefined>(undefined);

// Besides the usual retryable failures: an update that matched no rows
// without erroring went out without a usable session (RLS just silently
// matches nothing for the anonymous role), which says nothing about whether
// the change itself is valid — so it's kept for another try, not dropped.
function shouldRetryProfileUpdate(
  error: unknown,
  status: number,
  updated: unknown[] | null
): boolean {
  return error ? isRetryableStatus(status) : !updated?.length;
}

export function ProfileProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [serverProfile, setServerProfile] = useState<Profile>(DEFAULT_PROFILE);
  const [pending, setPending] = useState<PendingProfile>({});
  // Which account (null = signed out) the profile above has loaded for, so
  // isLoaded reads false again while a newly signed-in account's profile is
  // still loading instead of carrying over from the signed-out state.
  const [loadedUserId, setLoadedUserId] = useState<string | null | undefined>(undefined);
  const isLoaded = loadedUserId === userId;
  // Source of truth between renders, for the same reason as use-logs.tsx's
  // pendingRef: flushPending spans several awaits.
  const pendingRef = useRef<PendingProfile>({});
  const isFlushingRef = useRef(false);
  const uploadingAvatarIdRef = useRef<string | null>(null);

  const savePending = useCallback(
    (next: PendingProfile) => {
      pendingRef.current = next;
      setPending(next);
      if (userId) writeUserData(userId, "pending-profile", next);
    },
    [userId]
  );

  const saveServerProfile = useCallback(
    (updates: Partial<Profile>) => {
      setServerProfile((current) => {
        const next = { ...current, ...updates };
        if (userId) writeUserData(userId, "profile", next);
        return next;
      });
    },
    [userId]
  );

  const flushPending = useCallback(async () => {
    const { name: queuedName, avatar: queuedAvatar } = pendingRef.current;
    if (!userId || isFlushingRef.current || (queuedName === undefined && !queuedAvatar)) return;
    isFlushingRef.current = true;
    const rejections: string[] = [];

    try {
      // Same expired-token-while-offline guard as use-logs.tsx's flushPending.
      const { data } = await supabase.auth.getSession();
      if (data.session?.user.id !== userId) return;

      // Rounds, so anything queued while one is in flight (a new name typed
      // during a picture upload, say) goes out now instead of waiting for
      // the next sync trigger. Each round clears what it read or returns on
      // a retryable failure, so this ends once nothing new has arrived.
      for (;;) {
        const { name, avatar } = pendingRef.current;
        if (name === undefined && !avatar) break;

        if (avatar) {
          uploadingAvatarIdRef.current = avatar.id;
          try {
            let fileData: Blob | ArrayBuffer | null = null;
            try {
              fileData = await readStoredImage(avatar);
            } catch (error) {
              console.warn("Failed to read pending avatar", error);
              rejections.push("The new profile picture couldn't be read from this device.");
            }

            if (fileData) {
              // Always the same path per user (upsert: true) so re-uploading
              // replaces the old picture instead of accumulating orphaned
              // files — the "?v=" below is what defeats the browser/CDN cache
              // for the now-stale response at that same URL. No extension on
              // the path itself since the actual format varies (native's
              // editor re-encodes to JPEG, but web's picker passes the
              // original file through unchanged) — contentType is what the
              // served file is really labeled as.
              const path = `${userId}/avatar`;
              const { error: uploadError } = await supabase.storage
                .from("avatars")
                .upload(path, fileData, { contentType: avatar.contentType, upsert: true });
              if (uploadError && isRetryableStorageError(uploadError)) return;

              if (uploadError) {
                console.warn("Failed to upload avatar", uploadError);
                rejections.push(uploadError.message);
              } else {
                const { data: urlData } = supabase.storage.from("avatars").getPublicUrl(path);
                const avatarUrl = `${urlData.publicUrl}?v=${Date.now()}`;
                const { data: updated, error, status } = await supabase
                  .from("profiles")
                  .update({ avatar_url: avatarUrl })
                  .eq("id", userId)
                  .select("id");
                // Retrying redoes the upload too — harmless, it's the same path.
                if (shouldRetryProfileUpdate(error, status, updated)) return;
                if (error) {
                  console.warn("Failed to save avatar", error);
                  rejections.push(error.message);
                } else {
                  saveServerProfile({ avatarUrl });
                }
              }
            }

            // Done with this picture either way — unless another was picked
            // while it uploaded, which stays queued for the next attempt.
            if (pendingRef.current.avatar?.id === avatar.id) {
              savePending({ ...pendingRef.current, avatar: undefined });
            }
            deleteStoredImage(avatar);
          } finally {
            uploadingAvatarIdRef.current = null;
          }
        }

        if (name !== undefined) {
          const { data: updated, error, status } = await supabase
            .from("profiles")
            .update({ name })
            .eq("id", userId)
            .select("id");
          if (shouldRetryProfileUpdate(error, status, updated)) return;
          if (error) {
            console.warn("Failed to update name", error);
            rejections.push(error.message);
          } else {
            saveServerProfile({ name });
          }
          if (pendingRef.current.name === name) {
            savePending({ ...pendingRef.current, name: undefined });
          }
        }
      }
    } finally {
      isFlushingRef.current = false;
      if (rejections.length > 0) {
        Alert.alert("Couldn't update your profile", rejections.join("\n\n"));
      }
    }
  }, [userId, savePending, saveServerProfile]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!userId) {
        pendingRef.current = {};
        setPending({});
        setServerProfile(DEFAULT_PROFILE);
        setLoadedUserId(null);
        return;
      }

      // Device copy first, same as the other providers — see use-groups.tsx.
      const [storedProfile, storedPending] = await Promise.all([
        readUserData<Profile>(userId, "profile"),
        readUserData<PendingProfile>(userId, "pending-profile"),
      ]);
      if (cancelled) return;
      pendingRef.current = storedPending ?? {};
      setPending(pendingRef.current);
      if (storedProfile) {
        setServerProfile(storedProfile);
        setLoadedUserId(userId);
      }

      const { data, error } = await supabase
        .from("profiles")
        .select("name, avatar_url")
        .eq("id", userId)
        .single();
      if (cancelled) return;
      if (data) {
        const next = { name: data.name, avatarUrl: data.avatar_url };
        setServerProfile(next);
        writeUserData(userId, "profile", next);
      } else if (error) {
        console.warn("Failed to load profile", error);
      }
      setLoadedUserId(userId);
      flushPending();
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [userId, flushPending]);

  const hasPendingChanges = pending.name !== undefined || !!pending.avatar;
  useSyncTriggers(flushPending, hasPendingChanges);

  const profile = useMemo(
    () => ({
      name: pending.name ?? serverProfile.name,
      avatarUrl: pending.avatar?.uri ?? serverProfile.avatarUrl,
    }),
    [pending, serverProfile]
  );

  const updateName = useCallback(
    (name: string) => {
      if (!userId) return;
      savePending({ ...pendingRef.current, name });
      flushPending();
    },
    [userId, savePending, flushPending]
  );

  const updateAvatar = useCallback(
    async (pickedUri: string) => {
      if (!userId) return { error: "Not signed in" };

      // Copied somewhere it'll still be when the upload finally happens,
      // which may be a long while from now if the device is offline.
      let avatar: PendingAvatar;
      try {
        const id = Crypto.randomUUID();
        const stored = await storePickedImage(
          pickedUri,
          () => userFilesDirectory(userId),
          `avatar-${id}.jpg`
        );
        avatar = { id, ...stored };
      } catch (error) {
        console.warn("Failed to store picked avatar", error);
        return { error: error instanceof Error ? error.message : "Please try again." };
      }

      const replaced = pendingRef.current.avatar;
      savePending({ ...pendingRef.current, avatar });
      // An upload in flight still needs its file; flushPending cleans that
      // one up itself once it's done.
      if (replaced && replaced.id !== uploadingAvatarIdRef.current) deleteStoredImage(replaced);
      flushPending();
      return {};
    },
    [userId, savePending, flushPending]
  );

  return (
    <ProfileContext.Provider
      value={{ profile, isLoaded, updateName, updateAvatar, hasPendingChanges }}
    >
      {children}
    </ProfileContext.Provider>
  );
}

export function useProfile() {
  const context = useContext(ProfileContext);
  if (!context) {
    throw new Error("useProfile must be used within a ProfileProvider");
  }
  return context;
}
