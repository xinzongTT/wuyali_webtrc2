import type { AdminUser } from "./api";

export type AdminUserStatusFilter = "all" | "live" | "offline" | "disabled";

export function filterAdminUsers(users: AdminUser[], query: string, status: AdminUserStatusFilter) {
  const normalizedQuery = query.trim().toLowerCase();
  return users.filter((user) => {
    const matchesQuery = !normalizedQuery
      || user.roomId.toLowerCase().includes(normalizedQuery)
      || user.displayName.toLowerCase().includes(normalizedQuery);
    const matchesStatus = status === "all"
      || (status === "disabled" ? !user.enabled : user.enabled && user.presence.status === status);
    return matchesQuery && matchesStatus;
  });
}
