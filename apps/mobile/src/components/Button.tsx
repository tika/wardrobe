import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native";
import { colors } from "../lib/theme";

interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  loading?: boolean;
}

export function Button({ title, onPress, variant = "secondary", disabled, loading }: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [styles.button, styles[variant], (disabled || pressed) && styles.dimmed]}
    >
      {loading
        ? <ActivityIndicator color={variant === "primary" ? colors.paper : colors.ink} />
        : <Text style={[styles.text, variant === "primary" && styles.primaryText, variant === "danger" && styles.dangerText]}>{title}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { flex: 1, minHeight: 46, borderRadius: 12, alignItems: "center", justifyContent: "center", paddingHorizontal: 14, borderWidth: StyleSheet.hairlineWidth },
  primary: { backgroundColor: colors.ink, borderColor: colors.ink },
  secondary: { backgroundColor: "transparent", borderColor: colors.line },
  danger: { backgroundColor: "transparent", borderColor: colors.line },
  dimmed: { opacity: 0.5 },
  text: { fontSize: 16, fontWeight: "600", color: colors.ink },
  primaryText: { color: colors.paper },
  dangerText: { color: colors.danger },
});
