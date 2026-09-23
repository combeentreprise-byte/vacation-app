import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/lib/supabase";

export type Profile = {
  name: string;
  avatarUrl: string | null;
};

const DEFAULT_PROFILE: Profile = {
  name: "Your Name",
  avatarUrl: null,
};

type ProfileContextValue = {
  profile: Profile;
  isLoaded: boolean;
  updateProfile: (updates: Partial<Profile>) => void;
};

const ProfileContext = createContext<ProfileContextValue | undefined>(undefined);

export function ProfileProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [profile, setProfile] = useState<Profile>(DEFAULT_PROFILE);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!userId) {
        if (!cancelled) {
          setProfile(DEFAULT_PROFILE);
          setIsLoaded(true);
        }
        return;
      }

      const { data } = await supabase
        .from("profiles")
        .select("name, avatar_url")
        .eq("id", userId)
        .single();
      if (cancelled) return;
      if (data) setProfile({ name: data.name, avatarUrl: data.avatar_url });
      setIsLoaded(true);
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const updateProfile = useCallback(
    (updates: Partial<Profile>) => {
      if (!userId) return;
      setProfile((current) => {
        const next = { ...current, ...updates };
        const dbUpdates: { name?: string; avatar_url?: string | null } = {};
        if (updates.name !== undefined) dbUpdates.name = updates.name;
        if (updates.avatarUrl !== undefined) dbUpdates.avatar_url = updates.avatarUrl;
        supabase
          .from("profiles")
          .update(dbUpdates)
          .eq("id", userId)
          .then(({ error }) => {
            if (error) console.warn("Failed to update profile", error);
          });
        return next;
      });
    },
    [userId]
  );

  return (
    <ProfileContext.Provider value={{ profile, isLoaded, updateProfile }}>
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
