export default function Home() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-16">
      <h1 className="text-3xl font-semibold">Trademaxxing</h1>
      <p className="text-neutral-400">
        Foundation phase. The schema, shared types, and provider interfaces are
        in place. Trading features (indicators, setup detection, risk rules, the
        dashboard, and LLM prompts) are built by later agents.
      </p>
      <ul className="list-inside list-disc text-sm text-neutral-500">
        <li>Database: SQLite via Prisma (Postgres-compatible schema)</li>
        <li>Market data: TwelveDataProvider (MarketDataProvider)</li>
        <li>LLM: AnthropicProvider (LLMProvider)</li>
        <li>Notifications: ConsoleNotificationProvider (NotificationProvider)</li>
      </ul>
    </main>
  );
}
