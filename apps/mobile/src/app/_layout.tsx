import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { colors } from "../lib/theme";

const queryClient = new QueryClient();

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.paper },
          headerTintColor: colors.ink,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.paper },
        }}
      >
        <Stack.Screen name="index" options={{ title: "Wardrobe", headerLargeTitle: true }} />
        <Stack.Screen name="item/[id]" options={{ title: "" }} />
        <Stack.Screen name="import" options={{ title: "Add clothes", presentation: "modal" }} />
      </Stack>
    </QueryClientProvider>
  );
}
