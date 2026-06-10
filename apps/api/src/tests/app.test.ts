import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createMemoryStore, type AppStore } from "../store.js";

describe("app API", () => {
  let store: AppStore;
  let app: ReturnType<typeof createApp>["app"];

  beforeEach(async () => {
    store = createMemoryStore();
    app = createApp({ store, jwtSecret: "test-secret" }).app;
    await store.ensureAdmin("admin", "admin123456");
  });

  afterEach(async () => {
    await store.close();
  });

  it("lets an admin create a user and the user login with room id", async () => {
    const adminLogin = await request(app)
      .post("/api/admin/login")
      .send({ username: "admin", password: "admin123456" })
      .expect(200);

    await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${adminLogin.body.token}`)
      .send({ roomId: "xiaoyu2", password: "pass123456", displayName: "小鱼 2" })
      .expect(201);

    const userLogin = await request(app)
      .post("/api/login")
      .send({ roomId: "xiaoyu2", password: "pass123456" })
      .expect(200);

    expect(userLogin.body.user).toMatchObject({
      roomId: "xiaoyu2",
      displayName: "小鱼 2"
    });
  });

  it("records room events and exposes diagnostics to admin", async () => {
    const adminLogin = await request(app)
      .post("/api/admin/login")
      .send({ username: "admin", password: "admin123456" })
      .expect(200);

    await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${adminLogin.body.token}`)
      .send({ roomId: "diag001", password: "pass123456" })
      .expect(201);

    const userLogin = await request(app)
      .post("/api/login")
      .send({ roomId: "diag001", password: "pass123456" })
      .expect(200);

    await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${userLogin.body.token}`)
      .send({
        type: "turn_selected",
        role: "broadcaster",
        detail: "TURN UDP",
        stats: { bitrateKbps: 2800, fps: 30 }
      })
      .expect(201);

    const diagnostics = await request(app)
      .get("/api/admin/rooms/diag001/diagnostics")
      .set("Authorization", `Bearer ${adminLogin.body.token}`)
      .expect(200);

    expect(diagnostics.body.events[0]).toMatchObject({
      type: "turn_selected",
      role: "broadcaster",
      detail: "TURN UDP"
    });
  });

  it("lets an admin save the default low latency mode", async () => {
    const adminLogin = await request(app)
      .post("/api/admin/login")
      .send({ username: "admin", password: "admin123456" })
      .expect(200);

    await request(app)
      .put("/api/admin/settings")
      .set("Authorization", `Bearer ${adminLogin.body.token}`)
      .send({ lowLatencyDefault: true })
      .expect(200);

    const settings = await request(app)
      .get("/api/admin/settings")
      .set("Authorization", `Bearer ${adminLogin.body.token}`)
      .expect(200);

    expect(settings.body).toMatchObject({ lowLatencyDefault: true });
  });

  it("accepts viewer diagnostics from an existing room without exposing user auth", async () => {
    const adminLogin = await request(app)
      .post("/api/admin/login")
      .send({ username: "admin", password: "admin123456" })
      .expect(200);

    await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${adminLogin.body.token}`)
      .send({ roomId: "viewerdiag", password: "pass123456" })
      .expect(201);

    await request(app)
      .post("/api/rooms/viewerdiag/events")
      .send({
        type: "rtc_stats",
        role: "viewer",
        detail: "DIRECT UDP 1080x1920",
        stats: { rttMs: 24, jitterMs: 6, bitrateBps: 4100000 }
      })
      .expect(201);

    const diagnostics = await request(app)
      .get("/api/admin/rooms/viewerdiag/diagnostics")
      .set("Authorization", `Bearer ${adminLogin.body.token}`)
      .expect(200);

    expect(diagnostics.body.events[0]).toMatchObject({
      type: "rtc_stats",
      role: "viewer",
      detail: "DIRECT UDP 1080x1920"
    });
  });
});
