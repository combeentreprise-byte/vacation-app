import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { PageHeader } from "@/components/page-header";
import { Colors } from "@/constants/colors";
import { useGroups } from "@/hooks/use-groups";
import { supabase } from "@/lib/supabase";
import { goBackOrToGroups } from "@/utils/navigation";

type GroupPreview = {
  id: string;
  name: string;
  description: string;
  currency: string;
};

export default function JoinGroupScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { groups, joinGroup } = useGroups();
  const [preview, setPreview] = useState<GroupPreview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isJoining, setIsJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alreadyMember = groups.some((group) => group.id === id);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!id) {
        setIsLoading(false);
        return;
      }

      const { data, error: fetchError } = await supabase
        .rpc("get_group_preview", { p_group_id: id })
        .maybeSingle<GroupPreview>();

      if (cancelled) return;
      if (fetchError || !data) {
        setError("This invite link is no longer valid.");
      } else {
        setPreview(data);
      }
      setIsLoading(false);
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [id]);

  const handleJoin = async () => {
    if (!id) return;
    setIsJoining(true);
    const { error: joinError } = await joinGroup(id);
    setIsJoining(false);
    if (joinError) {
      setError(joinError);
      return;
    }
    router.replace({ pathname: "/group/[id]", params: { id } });
  };

  const handleOpen = () => {
    router.replace({ pathname: "/group/[id]", params: { id } });
  };

  return (
    <View style={styles.flex}>
      <PageHeader onBack={goBackOrToGroups} />

      <View style={styles.body}>
        {isLoading ? (
          <Text style={styles.status}>Loading invite…</Text>
        ) : error ? (
          <Text style={styles.status}>{error}</Text>
        ) : preview ? (
          <>
            <Text style={styles.eyebrow}>You&apos;ve been invited to join</Text>
            <Text style={styles.groupName}>{preview.name}</Text>
            {preview.description ? (
              <Text style={styles.description}>{preview.description}</Text>
            ) : null}
            <Text style={styles.currency}>Currency: {preview.currency || "Not set"}</Text>

            {alreadyMember ? (
              <Pressable style={styles.joinButton} onPress={handleOpen}>
                <Text style={styles.joinButtonText}>Open group</Text>
              </Pressable>
            ) : (
              <Pressable
                style={[styles.joinButton, isJoining && styles.joinButtonDisabled]}
                onPress={handleJoin}
                disabled={isJoining}
              >
                <Text style={styles.joinButtonText}>{isJoining ? "Joining…" : "Join group"}</Text>
              </Pressable>
            )}
          </>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  body: {
    flex: 1,
    padding: 20,
    gap: 8,
  },
  status: {
    fontSize: 15,
    color: Colors.muted,
    textAlign: "center",
    marginTop: 40,
  },
  eyebrow: {
    fontSize: 13,
    fontWeight: "600",
    color: Colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  groupName: {
    fontSize: 26,
    fontWeight: "800",
    color: Colors.text,
  },
  description: {
    fontSize: 15,
    lineHeight: 21,
    color: Colors.text,
  },
  currency: {
    fontSize: 14,
    color: Colors.muted,
  },
  joinButton: {
    backgroundColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 16,
  },
  joinButtonDisabled: {
    opacity: 0.5,
  },
  joinButtonText: {
    color: Colors.accentText,
    fontSize: 16,
    fontWeight: "600",
  },
});
