import { router, useLocalSearchParams } from "expo-router";
import { Alert } from "react-native";

import { GroupForm, type GroupFormValues } from "@/components/group-form";
import { ModalHeader } from "@/components/modal-header";
import { useAuth } from "@/hooks/use-auth";
import { useGroups } from "@/hooks/use-groups";
import { useLogs } from "@/hooks/use-logs";
import { uploadGroupPhoto } from "@/utils/group-photo";

export default function NewGroupScreen() {
  const { session } = useAuth();
  const { groups, addGroup, updateGroup, changeGroupCurrency } = useGroups();
  const { refresh: refreshLogs } = useLogs();
  // Set when arriving from the group screen's "Edit group" menu item —
  // switches this same form (the create flow's) into edit-and-save-in-place
  // mode, the same way add-entry.tsx's logId param does for log entries.
  const { groupId } = useLocalSearchParams<{ groupId?: string }>();
  const isEditMode = !!groupId;
  const existingGroup = isEditMode ? groups.find((item) => item.id === groupId) : undefined;

  const handleSubmit = async (values: GroupFormValues) => {
    const userId = session?.user.id;
    if (!userId) return;
    if (isEditMode && !existingGroup) return;

    try {
      // Uploaded only now, on submit, so a photo swapped out or discarded
      // along the way never leaves an orphaned file with no group pointing
      // to it.
      const photoUrl = !values.photo
        ? null
        : values.photo.isNew
          ? await uploadGroupPhoto(userId, values.photo.uri)
          : values.photo.uri;

      if (isEditMode && existingGroup) {
        await updateGroup(existingGroup.id, {
          name: values.name,
          description: values.description,
          heroMotive: values.motive,
          heroHue: values.hue,
          photoUrl,
        });

        const newCurrency = values.currency || existingGroup.currency;
        if (newCurrency !== existingGroup.currency) {
          const { error } = await changeGroupCurrency(
            existingGroup.id,
            existingGroup.currency,
            newCurrency
          );
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
      } else {
        await addGroup(
          values.name,
          values.description,
          values.currency,
          values.motive,
          values.hue,
          photoUrl
        );
      }
      router.back();
    } catch (error) {
      console.warn(isEditMode ? "Failed to update group" : "Failed to create group", error);
      Alert.alert(
        isEditMode ? "Couldn't save changes" : "Couldn't create group",
        error instanceof Error ? error.message : "Please try again."
      );
    }
  };

  return (
    <GroupForm
      header={
        <ModalHeader
          title={isEditMode ? "Edit group" : "Create a new Group"}
          onClose={() => router.back()}
        />
      }
      initialValues={
        existingGroup && {
          name: existingGroup.name,
          description: existingGroup.description,
          currency: existingGroup.currency,
          motive: existingGroup.heroMotive,
          hue: existingGroup.heroHue,
          photoUri: existingGroup.photoUrl,
        }
      }
      submitLabel={isEditMode ? "Save changes" : "Create group"}
      submittingLabel={isEditMode ? "Saving…" : "Creating…"}
      disabled={isEditMode && !existingGroup}
      onSubmit={handleSubmit}
    />
  );
}
