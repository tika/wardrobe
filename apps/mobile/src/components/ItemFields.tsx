import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { HEX_COLOR, PARTS, type Part } from "@wardrobe/core";
import { colors } from "../lib/theme";

/** Form state for an item's details; tags are edited as one comma-separated string. */
export interface ItemDraft {
  name: string;
  part: Part;
  color: string;
  secondaryColor: string;
  tags: string;
}

export const toDraft = (item: { name: string; part: Part; color: string; secondaryColor: string | null; tags: string[] }): ItemDraft => ({
  name: item.name,
  part: item.part,
  color: item.color,
  secondaryColor: item.secondaryColor || "",
  tags: item.tags.join(", "),
});

export const fromDraft = (draft: ItemDraft) => ({
  name: draft.name.trim(),
  part: draft.part,
  color: draft.color.toLowerCase(),
  secondaryColor: draft.secondaryColor ? draft.secondaryColor.toLowerCase() : null,
  tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
});

export const isValidDraft = (draft: ItemDraft) =>
  Boolean(draft.name.trim()) && HEX_COLOR.test(draft.color) && (!draft.secondaryColor || HEX_COLOR.test(draft.secondaryColor));

function ColorField({ label, value, onChange, optional }: { label: string; value: string; onChange: (value: string) => void; optional?: boolean }) {
  const valid = HEX_COLOR.test(value) || (optional && !value);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}{optional ? <Text style={styles.optional}>  optional</Text> : null}</Text>
      <View style={styles.colorRow}>
        <View style={[styles.swatch, { backgroundColor: HEX_COLOR.test(value) ? value : "transparent" }]} />
        <TextInput
          style={[styles.input, styles.colorInput, !valid && styles.invalid]}
          value={value}
          onChangeText={onChange}
          placeholder={optional ? "#hex or leave blank" : "#d8d0c2"}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
    </View>
  );
}

export function ItemFields({ draft, onChange }: { draft: ItemDraft; onChange: (draft: ItemDraft) => void }) {
  const set = <K extends keyof ItemDraft>(key: K) => (value: ItemDraft[K]) => onChange({ ...draft, [key]: value });
  return (
    <View style={styles.fields}>
      <View style={styles.field}>
        <Text style={styles.label}>Name</Text>
        <TextInput style={styles.input} value={draft.name} onChangeText={set("name")} placeholder="Name" />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Category</Text>
        <View style={styles.parts}>
          {PARTS.map(({ id, singular }) => (
            <Pressable key={id} onPress={() => set("part")(id)} style={[styles.chip, draft.part === id && styles.chipActive]}>
              <Text style={[styles.chipText, draft.part === id && styles.chipTextActive]}>{singular}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <ColorField label="Primary color" value={draft.color} onChange={set("color")} />
      <ColorField label="Secondary color" value={draft.secondaryColor} onChange={set("secondaryColor")} optional />
      <View style={styles.field}>
        <Text style={styles.label}>Details</Text>
        <TextInput style={styles.input} value={draft.tags} onChangeText={set("tags")} placeholder="casual, cotton, striped" autoCapitalize="none" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fields: { gap: 18 },
  field: { gap: 8 },
  label: { fontSize: 12, fontWeight: "600", letterSpacing: 1, textTransform: "uppercase", color: colors.muted },
  optional: { fontWeight: "400", textTransform: "none", letterSpacing: 0 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 16, color: colors.ink, backgroundColor: colors.card },
  invalid: { borderColor: colors.danger },
  colorRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  colorInput: { flex: 1, fontVariant: ["tabular-nums"] },
  swatch: { width: 36, height: 36, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  parts: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  chipActive: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontSize: 14, color: colors.ink },
  chipTextActive: { color: colors.paper },
});
