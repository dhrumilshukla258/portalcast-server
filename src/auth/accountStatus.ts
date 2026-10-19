import { User } from "@/models/User";

// Account status for the auth gate: one query per user per minute instead of per request.
const accountCache = new Map<number, { at: number; isActive: boolean; role: string }>();
export async function accountStatus(userId: number): Promise<{ isActive: boolean; role: string } | null> {
  const hit = accountCache.get(userId);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  const u = await User.findByPk(userId, { attributes: ["id", "isActive", "role"], raw: true }) as any;
  if (!u) { accountCache.delete(userId); return null; }
  const v = { at: Date.now(), isActive: !!u.isActive, role: String(u.role) };
  accountCache.set(userId, v);
  return v;
}
/** Call after an admin changes a user so the gate sees it at once. */
export function forgetAccountStatus(userId: number): void { accountCache.delete(userId); }

