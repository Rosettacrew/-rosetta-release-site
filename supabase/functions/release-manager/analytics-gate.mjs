/**
 * Finance view gate. Matches hasOwnerAccess: owner, admin, or the owner key.
 * Staff (and every other role) are denied. The query runs only after the gate.
 */

export function ownerFinanceAccess(role, fallbackKey) {
  return !!fallbackKey || role === "owner" || role === "admin";
}

export function gateAnalyticsView(role, fallbackKey) {
  if (!ownerFinanceAccess(role, fallbackKey)) return { ok: false, status: 403, error: "Forbidden" };
  return { ok: true };
}

export async function readAnalytics({ role, fallbackKey, query }) {
  const gate = gateAnalyticsView(role, fallbackKey);
  if (!gate.ok) return { status: gate.status, body: { error: gate.error }, queried: false };
  const data = await query();
  return { status: 200, body: { analytics: data }, queried: true };
}
