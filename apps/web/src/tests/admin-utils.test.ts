import { describe, expect, it } from "vitest";
import { filterAdminUsers } from "../admin-utils";
import type { AdminUser } from "../api";

const users: AdminUser[] = [
  user({ roomId: "xiaoyu", displayName: "小鱼", status: "live", enabled: true }),
  user({ roomId: "xinzong", displayName: "Xinzong", status: "offline", enabled: true }),
  user({ roomId: "paused001", displayName: "Paused Room", status: "offline", enabled: false })
];

describe("admin user filtering", () => {
  it("searches by room id and display name", () => {
    expect(filterAdminUsers(users, "yu", "all").map((item) => item.roomId)).toEqual(["xiaoyu"]);
    expect(filterAdminUsers(users, "xinzong", "all").map((item) => item.roomId)).toEqual(["xinzong"]);
  });

  it("filters by live, offline, and disabled states", () => {
    expect(filterAdminUsers(users, "", "live").map((item) => item.roomId)).toEqual(["xiaoyu"]);
    expect(filterAdminUsers(users, "", "offline").map((item) => item.roomId)).toEqual(["xinzong"]);
    expect(filterAdminUsers(users, "", "disabled").map((item) => item.roomId)).toEqual(["paused001"]);
  });
});

function user(input: { roomId: string; displayName: string; status: string; enabled: boolean }): AdminUser {
  return {
    id: input.roomId,
    roomId: input.roomId,
    displayName: input.displayName,
    enabled: input.enabled,
    createdAt: "2026-06-11T00:00:00.000Z",
    presence: {
      broadcasters: input.status === "live" ? 1 : 0,
      viewers: 0,
      status: input.status
    }
  };
}
