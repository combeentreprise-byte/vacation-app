import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import {
  Alert,
  Animated,
  Dimensions,
  FlatList,
  type GestureResponderEvent,
  Modal,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  type NavigationState,
  type SceneRendererProps,
  TabView,
} from "react-native-tab-view";

import type { MenuAnchor } from "@/components/create-or-join-menu";
import { CurrencyPickerModal } from "@/components/currency-picker";
import { GroupActionsMenu } from "@/components/group-actions-menu";
import { PageHeader } from "@/components/page-header";
import { Colors } from "@/constants/colors";
import { useAuth } from "@/hooks/use-auth";
import { type GroupMember, useGroupMembers } from "@/hooks/use-group-members";
import { useGroups } from "@/hooks/use-groups";
import { type LogEntry, useLogs } from "@/hooks/use-logs";
import { useProfile } from "@/hooks/use-profile";
import { calculateMemberBalances } from "@/utils/balances";
import { showComingSoon } from "@/utils/coming-soon";
import { goBackOrToGroups } from "@/utils/navigation";

type TabRoute = { key: "members" | "logs"; title: string };

const TAB_ROUTES: TabRoute[] = [
  { key: "members", title: "Members" },
  { key: "logs", title: "Logs" },
];

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Everyone a log's cost was actually split across: the "purchase was for"
// checklist, plus the payer themselves when they included their own share.
// `members` excludes the current viewer, so the viewer's own entry (as
// payer or as a beneficiary of someone else's log) is filled in separately,
// using their real name/initials rather than a placeholder — this list
// mirrors the Members tab, where everyone is shown by their actual name.
function resolvePurchasedFor(
  log: LogEntry,
  members: GroupMember[],
  currentUserId: string,
  viewerName: string
): GroupMember[] {
  const ids = log.payerIncluded ? [...log.memberIds, log.paidBy] : log.memberIds;
  return ids
    .map((id) =>
      id === currentUserId
        ? { id, name: viewerName, isActive: true }
        : members.find((member) => member.id === id)
    )
    .filter((member): member is GroupMember => !!member);
}

// "You"/other-name substitution already happened for both payerName and
// purchasedFor (via resolvePurchasedFor), so this just picks the wording.
function formatLogHeadline(log: LogEntry, payerName: string, purchasedFor: GroupMember[]) {
  if (log.isSettlement) {
    const counterpartName = purchasedFor[0]?.name ?? "someone";
    const possessive = payerName === "You" ? "your" : "their";
    return `${payerName} settled ${possessive} debt with ${counterpartName} (${log.amount} ${log.currency})`;
  }
  return `${payerName} spent ${log.amount} ${log.currency}`;
}

function formatDebt(debt: number, currency: string) {
  const roundedDebt = Math.round(debt * 100) / 100;
  const isSettled = roundedDebt === 0;
  const isOwed = roundedDebt > 0;
  const amountLabel = `${Math.abs(roundedDebt)}${currency ? ` ${currency}` : ""}`;
  return { isSettled, isOwed, amountLabel };
}

function MemberRow({
  member,
  debt,
  currency,
  onPress,
}: {
  member: GroupMember;
  debt: number;
  currency: string;
  onPress: () => void;
}) {
  const { isSettled, isOwed, amountLabel } = formatDebt(debt, currency);

  return (
    <Pressable style={styles.memberRow} onPress={onPress}>
      <View style={[styles.avatar, !member.isActive && styles.avatarInactive]}>
        <Text style={styles.avatarText}>{getInitials(member.name)}</Text>
      </View>
      <View style={styles.memberNameColumn}>
        <Text style={[styles.memberName, !member.isActive && styles.memberNameInactive]}>
          {member.name}
        </Text>
        {!member.isActive ? <Text style={styles.leftLabel}>Left group</Text> : null}
      </View>
      <View style={styles.memberDivider} />
      <View style={styles.debtColumn}>
        {isSettled ? (
          <Text style={styles.debtSettled}>Settled up</Text>
        ) : (
          <>
            <Text style={[styles.debtLabel, isOwed ? styles.debtPositive : styles.debtNegative]}>
              {isOwed ? "owes you" : "you owe"}
            </Text>
            <Text style={[styles.debtAmount, isOwed ? styles.debtPositive : styles.debtNegative]}>
              {amountLabel}
            </Text>
          </>
        )}
      </View>
    </Pressable>
  );
}

function MemberDetailOverlay({
  member,
  debt,
  currency,
  onClose,
  onSettle,
}: {
  member: GroupMember | null;
  debt: number;
  currency: string;
  onClose: () => void;
  onSettle: () => void;
}) {
  const { isSettled, isOwed, amountLabel } = formatDebt(debt, currency);
  const [promoteFillAnim] = useState(() => new Animated.Value(0));
  const [isPromoted, setIsPromoted] = useState(false);
  const [promoteRowWidth, setPromoteRowWidth] = useState(0);
  const promoteLabel = isPromoted ? "Promoted to admin" : "Promote to admin";
  const promoteFillWidth = promoteFillAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0%", "100%"],
  });

  const handlePromotePressIn = () => {
    Animated.timing(promoteFillAnim, {
      toValue: 1,
      duration: 600,
      useNativeDriver: false,
      // Only reaching full black (not just tapping/releasing early) counts
      // as "held long enough" — a pressOut before this fires interrupts the
      // animation, so `finished` comes back false and nothing locks in.
    }).start(({ finished }) => {
      if (!finished) return;
      setIsPromoted(true);
      showComingSoon(`Promoting ${member?.name ?? "members"} to admin`);
    });
  };

  const handlePromotePressOut = () => {
    Animated.timing(promoteFillAnim, {
      toValue: 0,
      duration: 250,
      useNativeDriver: false,
    }).start();
  };

  return (
    <Modal transparent visible={!!member} animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.detailBackdrop} onPress={onClose}>
        <Pressable style={styles.detailBox} onPress={() => {}}>
          {member ? (
            <>
              <View style={styles.memberDetailCloseRow}>
                <Pressable onPress={onClose} hitSlop={12}>
                  <Ionicons name="close" size={22} color={Colors.text} />
                </Pressable>
              </View>

              <View style={styles.memberDetailHeader}>
                <View style={[styles.avatarLarge, !member.isActive && styles.avatarInactive]}>
                  <Text style={styles.avatarLargeText}>{getInitials(member.name)}</Text>
                </View>
                <Text style={styles.memberDetailName}>{member.name}</Text>
                {isSettled ? (
                  <Text style={styles.debtSettled}>Settled up</Text>
                ) : (
                  <Text
                    style={[
                      styles.memberDetailDebt,
                      isOwed ? styles.debtPositive : styles.debtNegative,
                    ]}
                  >
                    {isOwed ? "Owes you " : "You owe "}
                    {amountLabel}
                  </Text>
                )}
              </View>

              <View style={styles.memberDetailRowsList}>
                <Pressable
                  style={[styles.actionRow, isPromoted && styles.actionRowDisabled]}
                  onLayout={(event) => setPromoteRowWidth(event.nativeEvent.layout.width)}
                  onPress={() => {}}
                  onPressIn={handlePromotePressIn}
                  onPressOut={handlePromotePressOut}
                  disabled={isPromoted}
                >
                  <Animated.View
                    pointerEvents="none"
                    style={[styles.promoteFill, { width: promoteFillWidth }]}
                  />
                  <View style={styles.actionRowContent} pointerEvents="none">
                    <Ionicons name="arrow-up" size={20} color={Colors.text} />
                    <Text style={styles.rowLabel}>{promoteLabel}</Text>
                  </View>
                  {/* White copy of the same content, revealed only where the
                      black fill has swept past, so the text appears to
                      invert to white as the wipe passes under it. */}
                  <Animated.View
                    pointerEvents="none"
                    style={[styles.promoteRevealClip, { width: promoteFillWidth }]}
                  >
                    <View style={[styles.actionRowContent, { width: promoteRowWidth }]}>
                      <Ionicons name="arrow-up" size={20} color="#FFFFFF" />
                      <Text style={[styles.rowLabel, styles.rowLabelWhite]}>{promoteLabel}</Text>
                    </View>
                  </Animated.View>
                </Pressable>
                <Pressable
                  style={[styles.actionRow, isSettled && styles.actionRowDisabled]}
                  onPress={onSettle}
                  disabled={isSettled}
                >
                  <View style={styles.actionRowContent}>
                    <MaterialCommunityIcons name="handshake-outline" size={20} color={Colors.text} />
                    <Text style={styles.rowLabel}>Debt was settled</Text>
                  </View>
                </Pressable>
              </View>
            </>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function MembersPane({
  groupId,
  currency,
  members,
  currentUserId,
}: {
  groupId: string;
  currency: string;
  members: GroupMember[];
  currentUserId: string;
}) {
  const { logs, settleDebt } = useLogs();
  const [selectedMember, setSelectedMember] = useState<GroupMember | null>(null);
  const balances = useMemo(
    () => calculateMemberBalances(logs, groupId, currentUserId),
    [logs, groupId, currentUserId]
  );
  // Active members first; members who've left sink to the bottom rather than
  // interrupting the active list.
  const sortedMembers = useMemo(
    () => [...members].sort((a, b) => Number(!a.isActive) - Number(!b.isActive)),
    [members]
  );

  const handleSettle = () => {
    if (!selectedMember) return;
    const debt = balances[selectedMember.id] ?? 0;
    const { amountLabel, isOwed, isSettled } = formatDebt(debt, currency);
    if (isSettled) return;

    // A settlement can't be undone from the UI once created, so confirm
    // first rather than silently writing a permanent log entry.
    Alert.alert(
      "Mark debt as settled?",
      `This adds a log entry recording that ${isOwed ? `${selectedMember.name} paid you` : `you paid ${selectedMember.name}`} ${amountLabel}.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Confirm",
          onPress: () => {
            // The debtor is always recorded as paidBy: whichever direction
            // the debt runs, this is the same "who owes whom" logic
            // calculateMemberBalances already uses, just settling it to 0
            // instead of adding to it.
            const paidBy = isOwed ? selectedMember.id : currentUserId;
            const otherUserId = isOwed ? currentUserId : selectedMember.id;
            settleDebt({
              groupId,
              paidBy,
              otherUserId,
              amount: Math.abs(Math.round(debt * 100) / 100),
              currency,
            });
            setSelectedMember(null);
          },
        },
      ]
    );
  };

  if (members.length === 0) {
    return (
      <View style={styles.pane}>
        <Text style={styles.paneText}>No other members yet</Text>
      </View>
    );
  }

  return (
    <>
      <FlatList<GroupMember>
        data={sortedMembers}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.membersList}
        renderItem={({ item }) => (
          <MemberRow
            member={item}
            debt={balances[item.id] ?? 0}
            currency={currency}
            onPress={() => setSelectedMember(item)}
          />
        )}
      />
      <MemberDetailOverlay
        member={selectedMember}
        debt={selectedMember ? (balances[selectedMember.id] ?? 0) : 0}
        currency={currency}
        onClose={() => setSelectedMember(null)}
        onSettle={handleSettle}
      />
    </>
  );
}

function LogRow({
  log,
  members,
  currentUserId,
  viewerName,
  onPress,
}: {
  log: LogEntry;
  members: GroupMember[];
  currentUserId: string;
  viewerName: string;
  onPress: () => void;
}) {
  const purchasedFor = resolvePurchasedFor(log, members, currentUserId, viewerName);
  const payerName =
    log.paidBy === currentUserId
      ? "You"
      : (members.find((member) => member.id === log.paidBy)?.name ?? "Someone");

  return (
    <Pressable style={styles.logCard} onPress={onPress}>
      <Text style={styles.logAmount}>{formatLogHeadline(log, payerName, purchasedFor)}</Text>
      {purchasedFor.length > 0 ? (
        <View style={styles.logAvatars}>
          {purchasedFor.map((member, index) => (
            <View
              key={member.id}
              style={[styles.logAvatar, index > 0 && styles.logAvatarOverlap]}
            >
              <Text style={styles.logAvatarText}>{getInitials(member.name)}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

function LogDetailOverlay({
  log,
  members,
  currentUserId,
  viewerName,
  onClose,
  onDelete,
}: {
  log: LogEntry | null;
  members: GroupMember[];
  currentUserId: string;
  viewerName: string;
  onClose: () => void;
  onDelete: (log: LogEntry) => void;
}) {
  const purchasedFor = log ? resolvePurchasedFor(log, members, currentUserId, viewerName) : [];
  const payerName = log
    ? log.paidBy === currentUserId
      ? "You"
      : (members.find((member) => member.id === log.paidBy)?.name ?? "Someone")
    : "";

  return (
    <Modal transparent visible={!!log} animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.detailBackdrop} onPress={onClose}>
        <Pressable style={styles.detailBox} onPress={() => {}}>
          {log ? (
            <>
              <View style={styles.detailHeader}>
                <Text style={[styles.logAmount, styles.detailHeaderText]}>
                  {formatLogHeadline(log, payerName, purchasedFor)}
                </Text>
                <Pressable onPress={onClose} hitSlop={12}>
                  <Ionicons name="close" size={22} color={Colors.text} />
                </Pressable>
              </View>

              {log.details ? <Text style={styles.description}>{log.details}</Text> : null}

              <View style={styles.detailMembersList}>
                {purchasedFor.map((member) => (
                  <View key={member.id} style={styles.detailMemberRow}>
                    <View style={styles.avatar}>
                      <Text style={styles.avatarText}>{getInitials(member.name)}</Text>
                    </View>
                    <Text style={styles.memberName}>{member.name}</Text>
                  </View>
                ))}
              </View>

              {log.paidBy === currentUserId ? (
                <Pressable style={styles.actionRow} onPress={() => onDelete(log)}>
                  <View style={styles.actionRowContent}>
                    <Ionicons name="trash-outline" size={20} color={Colors.danger} />
                    <Text style={[styles.rowLabel, styles.rowLabelDanger]}>Delete entry</Text>
                  </View>
                </Pressable>
              ) : null}
            </>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function LogsPane({
  groupId,
  members,
  currentUserId,
  viewerName,
}: {
  groupId: string;
  members: GroupMember[];
  currentUserId: string;
  viewerName: string;
}) {
  const { logs, deleteLog } = useLogs();
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);
  const groupLogs = logs
    .filter((log) => log.groupId === groupId)
    .sort((a, b) => b.createdAt - a.createdAt);

  const handleDelete = (log: LogEntry) => {
    // Deleting isn't reversible from the UI, so confirm first — same
    // reasoning as the settle-debt confirmation.
    Alert.alert("Delete entry?", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const { error } = await deleteLog(log.id);
          if (error) {
            Alert.alert("Couldn't delete entry", error);
            return;
          }
          setSelectedLog(null);
        },
      },
    ]);
  };

  if (groupLogs.length === 0) {
    return (
      <View style={styles.pane}>
        <Text style={styles.paneText}>No entries yet</Text>
      </View>
    );
  }

  return (
    <>
      <FlatList<LogEntry>
        data={groupLogs}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.membersList}
        renderItem={({ item }) => (
          <LogRow
            log={item}
            members={members}
            currentUserId={currentUserId}
            viewerName={viewerName}
            onPress={() => setSelectedLog(item)}
          />
        )}
      />
      <LogDetailOverlay
        log={selectedLog}
        members={members}
        currentUserId={currentUserId}
        viewerName={viewerName}
        onClose={() => setSelectedLog(null)}
        onDelete={handleDelete}
      />
    </>
  );
}

export default function GroupDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();
  const { profile } = useProfile();
  const { groups, updateGroup, changeGroupCurrency, removeGroup } = useGroups();
  const group = groups.find((item) => item.id === id);
  const insets = useSafeAreaInsets();
  const [tabIndex, setTabIndex] = useState(0);
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editCurrency, setEditCurrency] = useState("");
  const [isCurrencyPickerVisible, setIsCurrencyPickerVisible] = useState(false);
  const { logs, refresh: refreshLogs } = useLogs();
  const { members: allMembers } = useGroupMembers(group?.id);
  // The list of "other" members is what everything below actually wants;
  // seeing your own name in your own balance list would be meaningless.
  const members = allMembers.filter((member) => member.id !== session?.user.id);

  const totalBalance = useMemo(() => {
    if (!group || !session) return 0;
    const balances = calculateMemberBalances(logs, group.id, session.user.id);
    return Object.values(balances).reduce((sum, value) => sum + value, 0);
  }, [logs, group, session]);

  const openMenu = (event: GestureResponderEvent) => {
    const { pageX, pageY } = event.nativeEvent;
    setMenuAnchor({ x: pageX, y: pageY });
  };

  if (!group) {
    return (
      <View style={styles.flex}>
        <PageHeader onBack={goBackOrToGroups} />
        <View style={styles.notFound}>
          <Text style={styles.notFoundText}>This group could not be found.</Text>
        </View>
      </View>
    );
  }

  const handleEditToggle = async () => {
    setMenuAnchor(null);
    if (isEditing) {
      await updateGroup(group.id, {
        name: editName.trim() || group.name,
        description: editDescription.trim(),
      });

      const newCurrency = editCurrency.trim() || group.currency;
      if (newCurrency !== group.currency) {
        const { error } = await changeGroupCurrency(group.id, group.currency, newCurrency);
        if (error) {
          Alert.alert("Couldn't change currency", error);
          return;
        }
        // change_group_currency rescales every log's converted_amount
        // server-side, but useLogs' own cached copy doesn't know that
        // happened — without this, balances would keep showing pre-rescale
        // numbers under the new currency label until something else
        // happened to trigger a logs refresh.
        await refreshLogs();
      }

      setIsEditing(false);
    } else {
      setEditName(group.name);
      setEditDescription(group.description);
      setEditCurrency(group.currency);
      setIsEditing(true);
    }
  };

  const handleInvite = () => {
    setMenuAnchor(null);
    const url = Linking.createURL(`join/${group.id}`);
    Share.share({ message: url }).catch((error) => {
      Alert.alert("Couldn't open share sheet", String(error));
    });
  };

  const handleAddEntry = () => {
    router.push({ pathname: "/add-entry", params: { groupId: group.id } });
  };

  const handleLeave = () => {
    setMenuAnchor(null);
    // Best-effort check for which confirmation copy to show; leave_group
    // itself (schema.sql) makes the actual delete-vs-leave call server-side,
    // so a stale count here can't cause the wrong thing to happen, only the
    // wrong warning to be shown for it.
    const isLastMember = allMembers.filter((member) => member.isActive).length <= 1;

    Alert.alert(
      isLastMember ? "Delete group" : "Leave group",
      isLastMember
        ? "You're the last member of this group. Leaving will permanently delete the group and all its logs and balances — this can't be undone."
        : "Are you sure you want to leave this group?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: isLastMember ? "Delete" : "Leave",
          style: "destructive",
          onPress: () => {
            removeGroup(group.id);
            goBackOrToGroups();
          },
        },
      ]
    );
  };

  const currentUserId = session?.user.id ?? "";

  const renderScene = ({ route }: { route: TabRoute }) => {
    switch (route.key) {
      case "members":
        return (
          <MembersPane
            groupId={group.id}
            currency={group.currency}
            members={members}
            currentUserId={currentUserId}
          />
        );
      case "logs":
        return (
          <LogsPane
            groupId={group.id}
            members={members}
            currentUserId={currentUserId}
            viewerName={profile.name}
          />
        );
    }
  };

  const renderTabBar = (
    props: SceneRendererProps & { navigationState: NavigationState<TabRoute> }
  ) => (
    <View>
      <View style={styles.segmentRow}>
        {props.navigationState.routes.map((route, i) => {
          const isActive = i === props.navigationState.index;
          return (
            <Pressable
              key={route.key}
              onPress={() => setTabIndex(i)}
              style={[styles.segmentItem, isActive && styles.segmentItemActive]}
            >
              <Text style={[styles.segmentText, isActive && styles.segmentTextActive]}>
                {route.title}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.summaryBar}>
        {totalBalance === 0 ? (
          <Text style={styles.summarySettled}>Settled up</Text>
        ) : (
          <Text
            style={[
              styles.summaryText,
              totalBalance > 0 ? styles.debtPositive : styles.debtNegative,
            ]}
          >
            {totalBalance > 0 ? "You're owed " : "You owe "}
            {Math.abs(Math.round(totalBalance * 100) / 100)}
            {group.currency ? ` ${group.currency}` : ""} in total
          </Text>
        )}
      </View>
    </View>
  );

  return (
    <View style={styles.flex}>
      <PageHeader
        onBack={goBackOrToGroups}
        rightIcon={isEditing ? "checkmark" : "ellipsis"}
        onRightPress={isEditing ? handleEditToggle : openMenu}
      />

      <View style={styles.detailBody}>
        {isEditing ? (
          <TextInput
            value={editName}
            onChangeText={setEditName}
            style={[styles.groupName, styles.editableInput]}
          />
        ) : (
          <Text style={styles.groupName}>{group.name}</Text>
        )}

        {isEditing ? (
          <TextInput
            value={editDescription}
            onChangeText={setEditDescription}
            style={[styles.description, styles.editableInput]}
            multiline
          />
        ) : group.description ? (
          <Text style={styles.description}>{group.description}</Text>
        ) : null}

        {isEditing ? (
          <Pressable style={styles.editableInput} onPress={() => setIsCurrencyPickerVisible(true)}>
            <Text style={styles.currency}>{editCurrency || "Select a currency"}</Text>
          </Pressable>
        ) : (
          <Text style={styles.currency}>Currency: {group.currency || "Not set"}</Text>
        )}
      </View>

      <CurrencyPickerModal
        visible={isCurrencyPickerVisible}
        selectedCode={editCurrency}
        onSelect={(code) => {
          setEditCurrency(code);
          setIsCurrencyPickerVisible(false);
        }}
        onClose={() => setIsCurrencyPickerVisible(false)}
      />

      <TabView<TabRoute>
        navigationState={{ index: tabIndex, routes: TAB_ROUTES }}
        onIndexChange={setTabIndex}
        renderScene={renderScene}
        renderTabBar={renderTabBar}
        initialLayout={{ width: Dimensions.get("window").width }}
        style={styles.tabView}
      />

      <Pressable
        style={[styles.fab, { bottom: 20 + insets.bottom }]}
        onPress={handleAddEntry}
        hitSlop={4}
      >
        <Ionicons name="add" size={28} color={Colors.accentText} />
      </Pressable>

      <GroupActionsMenu
        anchor={menuAnchor}
        onClose={() => setMenuAnchor(null)}
        onEdit={handleEditToggle}
        onInvite={handleInvite}
        onLeave={handleLeave}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  notFound: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  notFoundText: {
    color: Colors.muted,
    fontSize: 15,
  },
  detailBody: {
    padding: 20,
    gap: 8,
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
  editableInput: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  segmentRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 16,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  segmentItem: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  segmentItemActive: {
    backgroundColor: Colors.surfaceSelected,
  },
  segmentText: {
    fontSize: 15,
    fontWeight: "500",
    color: Colors.muted,
  },
  segmentTextActive: {
    color: Colors.text,
    fontWeight: "600",
  },
  tabView: {
    flex: 1,
  },
  summaryBar: {
    paddingBottom: 14,
    paddingHorizontal: 20,
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  summaryText: {
    fontSize: 16,
    fontWeight: "700",
  },
  summarySettled: {
    fontSize: 16,
    fontWeight: "600",
    color: Colors.muted,
  },
  pane: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  paneText: {
    fontSize: 15,
    color: Colors.muted,
  },
  membersList: {
    padding: 20,
    gap: 12,
  },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 16,
    gap: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarInactive: {
    backgroundColor: Colors.muted,
  },
  avatarText: {
    color: Colors.accentText,
    fontSize: 14,
    fontWeight: "700",
  },
  memberNameColumn: {
    flex: 1,
    gap: 2,
  },
  memberName: {
    fontSize: 16,
    fontWeight: "600",
    color: Colors.text,
  },
  memberNameInactive: {
    color: Colors.muted,
  },
  leftLabel: {
    fontSize: 12,
    color: Colors.muted,
  },
  memberDivider: {
    width: 1,
    height: 28,
    backgroundColor: Colors.border,
  },
  debtColumn: {
    alignItems: "flex-end",
    minWidth: 72,
    gap: 2,
  },
  debtLabel: {
    fontSize: 12,
    fontWeight: "600",
  },
  debtAmount: {
    fontSize: 14,
    fontWeight: "700",
  },
  debtPositive: {
    color: Colors.success,
  },
  debtNegative: {
    color: Colors.danger,
  },
  debtSettled: {
    fontSize: 13,
    color: Colors.muted,
  },
  logCard: {
    backgroundColor: Colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 16,
    gap: 10,
  },
  logAmount: {
    fontSize: 16,
    fontWeight: "600",
    color: Colors.text,
  },
  logAvatars: {
    flexDirection: "row",
  },
  logAvatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: Colors.background,
  },
  logAvatarOverlap: {
    marginLeft: -8,
  },
  logAvatarText: {
    color: Colors.accentText,
    fontSize: 9,
    fontWeight: "700",
  },
  detailBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(17, 24, 28, 0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  detailBox: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: Colors.background,
    borderRadius: 16,
    padding: 20,
    gap: 12,
  },
  detailHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  detailHeaderText: {
    flex: 1,
  },
  detailMembersList: {
    gap: 12,
    marginTop: 4,
  },
  detailMemberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  memberDetailCloseRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  memberDetailHeader: {
    alignItems: "center",
    gap: 6,
    marginTop: -8,
  },
  avatarLarge: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  avatarLargeText: {
    color: Colors.accentText,
    fontSize: 30,
    fontWeight: "700",
  },
  memberDetailName: {
    fontSize: 20,
    fontWeight: "700",
    color: Colors.text,
  },
  memberDetailDebt: {
    fontSize: 15,
    fontWeight: "600",
  },
  memberDetailRowsList: {
    marginTop: 8,
    gap: 12,
  },
  actionRow: {
    backgroundColor: Colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  actionRowDisabled: {
    opacity: 0.5,
  },
  actionRowContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 16,
  },
  promoteFill: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: "#000000",
  },
  promoteRevealClip: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    overflow: "hidden",
  },
  rowLabel: {
    fontSize: 15,
    color: Colors.text,
  },
  rowLabelWhite: {
    color: "#FFFFFF",
  },
  rowLabelDanger: {
    color: Colors.danger,
  },
  fab: {
    position: "absolute",
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 6,
  },
});
