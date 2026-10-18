import { isGenerating, isVisibleJob } from "@wardrobe/core";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export const keys = { wardrobe: ["wardrobe"], jobs: ["jobs"], setup: ["setup"] } as const;

export const useWardrobe = () => useQuery({ queryKey: keys.wardrobe, queryFn: api.wardrobe });

export const useSetup = () => useQuery({ queryKey: keys.setup, queryFn: api.config });

/** Open import jobs; polls while the server is generating an image. */
export const useJobs = () => useQuery({
  queryKey: keys.jobs,
  queryFn: async () => (await api.jobs()).filter(isVisibleJob),
  refetchInterval: (query) => query.state.data?.some(isGenerating) ? 1500 : false,
});
