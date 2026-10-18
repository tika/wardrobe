import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  deriveStatus, failedStageFor, hasCleanupFailure, jobPreview, reviewStageFor,
  type ImportJob, type StageAction, type StageName,
} from "@wardrobe/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { Button } from "../components/Button";
import { fromDraft, isValidDraft, ItemFields, toDraft, type ItemDraft } from "../components/ItemFields";
import { api } from "../lib/api";
import { keys, useJobs, useSetup } from "../lib/queries";
import { colors } from "../lib/theme";

const STAGE_COPY: Record<StageName, { title: string; detail: string }> = {
  crop: { title: "Detected item", detail: "Check that this crop contains the whole item. Approving it starts the clean garment image." },
  garment: { title: "Garment image", detail: "Confirm the details, then approve to add it to your wardrobe and create a modeled photo." },
  modeled: { title: "Modeled image", detail: "Approve to attach this photo to the piece, or regenerate with a direction." },
};

function ReviewCard({ job, stage }: { job: ImportJob; stage: StageName }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ItemDraft>(() => toDraft(job.metadata));
  const [direction, setDirection] = useState("");

  const act = useMutation({
    mutationFn: async (action: StageAction) => {
      if (stage === "garment" && action === "approve") await api.updateMetadata(job.id, fromDraft(draft));
      return api.stageAction(job.id, stage, action, direction);
    },
    onSuccess: () => {
      setDirection("");
      queryClient.invalidateQueries({ queryKey: keys.jobs });
      queryClient.invalidateQueries({ queryKey: keys.wardrobe });
    },
    onError: (error) => Alert.alert("Import", error.message),
  });

  const asset = job.stages[stage].assetUrl;
  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>{STAGE_COPY[stage].title}</Text>
      {asset && <Image source={api.assetUrl(asset)} style={stage === "modeled" ? styles.modeled : styles.preview} contentFit="contain" transition={150} />}
      <Text style={styles.detail}>{STAGE_COPY[stage].detail}</Text>
      {stage === "garment" && <ItemFields draft={draft} onChange={setDraft} />}
      {stage !== "crop" && (
        <TextInput
          style={styles.direction}
          value={direction}
          onChangeText={setDirection}
          placeholder={stage === "garment" ? "Regeneration direction (optional)" : "Example: a quiet evening street"}
          multiline
        />
      )}
      <View style={styles.actions}>
        <Button title="Reject" variant="danger" onPress={() => act.mutate("reject")} disabled={act.isPending} />
        {stage !== "crop" && <Button title="Regenerate" onPress={() => act.mutate("regenerate")} disabled={act.isPending} />}
        <Button
          title={stage === "crop" ? "Use crop" : "Approve"}
          variant="primary"
          onPress={() => act.mutate("approve")}
          loading={act.isPending}
          disabled={stage === "garment" && !isValidDraft(draft)}
        />
      </View>
    </View>
  );
}

function JobRow({ job }: { job: ImportJob }) {
  const queryClient = useQueryClient();
  const status = deriveStatus(job);
  const failedStage = failedStageFor(job);
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.jobs });
  const onError = (error: Error) => Alert.alert("Import", error.message);
  const retry = useMutation({ mutationFn: (stage: StageName) => api.stageAction(job.id, stage, "regenerate"), onSuccess: refresh, onError });
  const cleanup = useMutation({ mutationFn: () => api.cleanup(job.id, "accept", job.stages.garment.cleanupTolerance), onSuccess: refresh, onError });
  const remove = useMutation({ mutationFn: () => api.deleteJob(job.id), onSuccess: refresh, onError });

  return (
    <View style={styles.row}>
      <Image source={api.assetUrl(jobPreview(job))} style={styles.rowImage} contentFit="contain" />
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>{job.metadata.name}</Text>
        <Text style={[styles.rowStatus, status.tone === "error" && styles.error]} numberOfLines={3}>
          {status.tone === "error" ? status.detail : status.text}
        </Text>
        <View style={styles.rowActions}>
          {status.tone === "processing" && <ActivityIndicator size="small" color={colors.muted} />}
          {failedStage && <Pressable onPress={() => retry.mutate(failedStage)}><Text style={styles.link}>Retry</Text></Pressable>}
          {hasCleanupFailure(job) && <Pressable onPress={() => cleanup.mutate()}><Text style={styles.link}>Use cleanup anyway</Text></Pressable>}
          <Pressable onPress={() => remove.mutate()}><Text style={[styles.link, styles.error]}>Remove</Text></Pressable>
        </View>
      </View>
    </View>
  );
}

export default function ImportScreen() {
  const queryClient = useQueryClient();
  const { data: setup } = useSetup();
  const { data: jobs = [] } = useJobs();
  const reviewJob = jobs.find((job) => reviewStageFor(job));
  const reviewStage = reviewJob && reviewStageFor(reviewJob);

  const upload = useMutation({
    mutationFn: async (source: "library" | "camera") => {
      const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], base64: true, quality: 0.85 };
      if (source === "camera" && !(await ImagePicker.requestCameraPermissionsAsync()).granted) throw new Error("Camera access is needed to take a photo.");
      const result = source === "camera"
        ? await ImagePicker.launchCameraAsync(options)
        : await ImagePicker.launchImageLibraryAsync({ ...options, allowsMultipleSelection: true });
      if (result.canceled) return 0;
      let detected = 0;
      for (const asset of result.assets) {
        if (!asset.base64) continue;
        const { jobs: created } = await api.createJobs(`data:${asset.mimeType || "image/jpeg"};base64,${asset.base64}`);
        detected += created.length;
        await queryClient.invalidateQueries({ queryKey: keys.jobs });
      }
      if (!detected) Alert.alert("No clothing detected", "Try a clearer or more tightly framed photo.");
      return detected;
    },
    onError: (error) => Alert.alert("Import", error.message),
  });

  if (setup && !setup.ready) {
    return (
      <View style={styles.setup}>
        <Text style={styles.setupTitle}>Setup required</Text>
        <Text style={styles.detail}>
          On the computer running Wardrobe, add GEMINI_API_KEY to .env and a photo of yourself at {setup.modelReference}, then restart the server.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>
      <View style={styles.actions}>
        <Button title="Choose photos" variant="primary" onPress={() => upload.mutate("library")} loading={upload.isPending} />
        <Button title="Take photo" onPress={() => upload.mutate("camera")} disabled={upload.isPending} />
      </View>
      {upload.isPending && <Text style={styles.detail}>Finding the clothes in your photos…</Text>}
      {!jobs.length && !upload.isPending && (
        <Text style={styles.detail}>A single garment or a photo of a full outfit works. Each item is held for your approval before it joins your wardrobe.</Text>
      )}
      {reviewJob && reviewStage && <ReviewCard key={`${reviewJob.id}:${reviewStage}`} job={reviewJob} stage={reviewStage} />}
      {jobs.map((job) => <JobRow key={job.id} job={job} />)}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48, gap: 16 },
  actions: { flexDirection: "row", gap: 10 },
  detail: { fontSize: 15, lineHeight: 21, color: colors.muted },
  card: { gap: 14, padding: 16, borderRadius: 16, backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  eyebrow: { fontSize: 12, fontWeight: "600", letterSpacing: 1, textTransform: "uppercase", color: colors.muted },
  preview: { width: "100%", aspectRatio: 1 },
  modeled: { width: "100%", aspectRatio: 3 / 2, borderRadius: 10 },
  direction: { minHeight: 64, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: 10, padding: 12, fontSize: 15, color: colors.ink, textAlignVertical: "top" },
  row: { flexDirection: "row", gap: 12, alignItems: "center" },
  rowImage: { width: 64, height: 64, borderRadius: 8, backgroundColor: colors.card },
  rowBody: { flex: 1, gap: 3 },
  rowTitle: { fontSize: 16, fontWeight: "600", color: colors.ink },
  rowStatus: { fontSize: 14, color: colors.muted },
  rowActions: { flexDirection: "row", gap: 16, alignItems: "center", marginTop: 2 },
  link: { fontSize: 14, fontWeight: "600", color: colors.accent },
  error: { color: colors.danger },
  setup: { padding: 24, gap: 10 },
  setupTitle: { fontSize: 20, fontWeight: "600", color: colors.ink },
});
