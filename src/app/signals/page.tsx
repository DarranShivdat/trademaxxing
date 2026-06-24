// Signals page — server component. Reads real signals (with their risk verdict
// and latest LLM explanation) from the DB and hands them to the client island
// that owns the accept/reject/explain interactivity.

import { getSignalRows } from "@/lib/dashboard/data";
import { SignalsClient } from "./signals-client";

// Always reflect the latest signals; never statically cache.
export const dynamic = "force-dynamic";

export default async function SignalsPage() {
  const rows = await getSignalRows();
  return <SignalsClient rows={rows} />;
}
