import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { Button } from "../../components/Button";
import { fromDraft, isValidDraft, ItemFields, toDraft, type ItemDraft } from "../../components/ItemFields";
import { api } from "../../lib/api";
import { keys, useWardrobe } from "../../lib/queries";
import { colors } from "../../lib/theme";

export default function ItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: items } = useWardrobe();
  const item = items?.find((candidate) => candidate.id === id);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ItemDraft | null>(item ? toDraft(item) : null);

  useEffect(() => {
    if (item) setDraft(toDraft(item));
  }, [item]);

  const save = useMutation({
    mutationFn: (value: ItemDraft) => api.updateItem(id, fromDraft(value)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.wardrobe }),
    onError: (error) => Alert.alert("Could not save changes", error.message),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteItem(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.wardrobe });
      router.back();
    },
    onError: (error) => Alert.alert("Could not delete", error.message),
  });

  if (!item || !draft) return <Text style={styles.status}>This piece is no longer in your wardrobe.</Text>;

  const dirty = JSON.stringify(fromDraft(draft)) !== JSON.stringify(fromDraft(toDraft(item)));
  const confirmDelete = () => Alert.alert(`Delete ${item.name}?`, "This removes the piece and its images.", [
    { text: "Cancel", style: "cancel" },
    { text: "Delete", style: "destructive", onPress: () => remove.mutate() },
  ]);

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>
      {item.modeledImage && (
        <Image source={api.assetUrl(item.modeledImage)} style={styles.modeled} contentFit="cover" transition={150} accessibilityLabel={`${item.name} worn by a model`} />
      )}
      <View style={styles.garmentRow}>
        <Image source={api.assetUrl(item.image)} style={styles.garment} contentFit="contain" transition={150} accessibilityLabel={item.name} />
        <Text style={styles.title}>{draft.name || item.name}</Text>
      </View>
      <ItemFields draft={draft} onChange={setDraft} />
      <View style={styles.actions}>
        <Button title="Delete" variant="danger" onPress={confirmDelete} loading={remove.isPending} />
        <Button title="Save" variant="primary" onPress={() => save.mutate(draft)} disabled={!dirty || !isValidDraft(draft)} loading={save.isPending} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48, gap: 22 },
  modeled: { width: "100%", aspectRatio: 3 / 2, borderRadius: 14, backgroundColor: colors.card },
  garmentRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  garment: { width: 96, height: 96 },
  title: { flex: 1, fontSize: 24, fontWeight: "600", color: colors.ink },
  actions: { flexDirection: "row", gap: 12 },
  status: { padding: 32, textAlign: "center", color: colors.muted },
});
