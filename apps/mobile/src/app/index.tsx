import { useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { PARTS, reviewStageFor, sortItems, type Part } from "@wardrobe/core";
import { Image } from "expo-image";
import { Link, Stack } from "expo-router";
import { imageSource } from "../lib/api";
import { useJobs, useWardrobe } from "../lib/queries";
import { colors } from "../lib/theme";

type Filter = Part | "all";
const FILTERS: { id: Filter; label: string }[] = [{ id: "all", label: "All" }, ...PARTS];
const COLUMNS = 3;
const GUTTER = 16;

export default function Gallery() {
  const { data: items = [], isPending, error, refetch, isRefetching } = useWardrobe();
  const { data: jobs = [] } = useJobs();
  const [filter, setFilter] = useState<Filter>("all");
  const { width } = useWindowDimensions();
  const tile = (width - GUTTER * (COLUMNS + 1)) / COLUMNS;
  const reviewCount = jobs.filter((job) => reviewStageFor(job)).length;

  const visible = useMemo(
    () => sortItems(filter === "all" ? items : items.filter((item) => item.part === filter), filter === "all"),
    [filter, items],
  );

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Link href="/import" asChild>
              <Pressable hitSlop={12}>
                <Text style={styles.headerAction}>{reviewCount ? `Review (${reviewCount})` : jobs.length ? "Importing…" : "Add"}</Text>
              </Pressable>
            </Link>
          ),
        }}
      />
      <FlatList
        data={visible}
        keyExtractor={(item) => item.id}
        numColumns={COLUMNS}
        contentInsetAdjustmentBehavior="automatic"
        columnWrapperStyle={{ gap: GUTTER, paddingHorizontal: GUTTER }}
        contentContainerStyle={{ gap: GUTTER, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} />}
        ListHeaderComponent={(
          <View style={styles.header}>
            <Text style={styles.count}>{items.length} {items.length === 1 ? "piece" : "pieces"}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
              {FILTERS.map(({ id, label }) => (
                <Pressable key={id} onPress={() => setFilter(id)} style={[styles.chip, filter === id && styles.chipActive]}>
                  <Text style={[styles.chipText, filter === id && styles.chipTextActive]}>{label}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}
        ListEmptyComponent={(
          <Text style={styles.status}>
            {error ? `Could not reach the Wardrobe server.\n${error.message}` : isPending ? "Loading wardrobe…" : "Tap Add to import your first piece."}
          </Text>
        )}
        renderItem={({ item }) => (
          <Link href={{ pathname: "/item/[id]", params: { id: item.id } }} asChild>
            <Pressable accessibilityLabel={`View ${item.name}`} style={{ width: tile, height: tile / 0.78 }}>
              <Image source={imageSource(item.thumbnail || item.image)} style={styles.thumb} contentFit="contain" transition={150} />
            </Pressable>
          </Link>
        )}
      />
    </>
  );
}

const styles = StyleSheet.create({
  headerAction: { color: colors.accent, fontSize: 17, fontWeight: "600" },
  header: { paddingTop: 8, paddingBottom: 8, gap: 16 },
  count: { paddingHorizontal: GUTTER, fontSize: 13, fontWeight: "500", letterSpacing: 1.3, textTransform: "uppercase", color: colors.ink },
  filters: { paddingHorizontal: GUTTER, gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  chipActive: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontSize: 14, color: colors.ink },
  chipTextActive: { color: colors.paper },
  thumb: { flex: 1 },
  status: { padding: 32, textAlign: "center", color: colors.muted, fontSize: 15, lineHeight: 21 },
});
