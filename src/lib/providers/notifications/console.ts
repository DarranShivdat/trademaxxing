import type {
  NotificationMessage,
  NotificationProvider,
} from "./provider";

/**
 * Stub notification provider that logs to the console. Real channels
 * (Telegram, etc.) come later behind the same interface.
 */
export class ConsoleNotificationProvider implements NotificationProvider {
  async send(message: NotificationMessage): Promise<void> {
    const level = message.level ?? "info";
    const prefix = `[notify:${level}]`;
    const title = message.title ? `${message.title} — ` : "";
    // eslint-disable-next-line no-console
    console.log(`${prefix} ${title}${message.body}`);
    if (message.meta && Object.keys(message.meta).length > 0) {
      // eslint-disable-next-line no-console
      console.log(`${prefix} meta:`, message.meta);
    }
  }
}
