// Outbound notification channel. Swap the concrete impl (console stub today,
// Telegram later) without touching consumers.

export type NotificationLevel = "info" | "warning" | "critical";

export interface NotificationMessage {
  body: string;
  title?: string;
  level?: NotificationLevel;
  /** Arbitrary structured context for the channel/renderer. */
  meta?: Record<string, unknown>;
}

export interface NotificationProvider {
  send(message: NotificationMessage): Promise<void>;
}
