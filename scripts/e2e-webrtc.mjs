import { chromium } from "playwright";

const baseUrl = process.env.WEB_BASE_URL ?? "http://localhost:5175";
const apiUrl = process.env.API_BASE_URL ?? "http://localhost:4200";
const adminUsername = process.env.ADMIN_USERNAME ?? "admin";
const adminPassword = process.env.ADMIN_PASSWORD ?? "admin123456";
const roomId = `e2e${Date.now().toString().slice(-8)}`;
const password = "pass123456";

async function apiJson(path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function createRoom() {
  const admin = await apiJson("/api/admin/login", {
    method: "POST",
    body: JSON.stringify({ username: adminUsername, password: adminPassword })
  });

  await apiJson("/api/admin/users", {
    method: "POST",
    headers: { Authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ roomId, password, displayName: "E2E WebRTC" })
  });

  const user = await apiJson("/api/login", {
    method: "POST",
    body: JSON.stringify({ roomId, password })
  });

  return { userToken: user.token };
}

async function waitForViewerVideo(page) {
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    const badges = [...document.querySelectorAll(".viewer-status .badge")].map((entry) => entry.textContent ?? "");
    const status = badges.join(" ");
    const bitrate = badges[2] ?? "";
    return Boolean(
      video &&
      video.videoWidth > 0 &&
      video.videoHeight > 0 &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      status.includes(`${video.videoWidth}x${video.videoHeight}`) &&
      !/^0 kbps$/.test(bitrate)
    );
  }, { timeout: 30_000 });
}

async function main() {
  const { userToken } = await createRoom();
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required"
    ]
  });

  const context = await browser.newContext({
    permissions: ["camera", "microphone"],
    viewport: { width: 1280, height: 900 }
  });

  const viewer = await context.newPage();
  const live = await context.newPage();

  try {
    await viewer.goto(`${baseUrl}/view/${roomId}`, { waitUntil: "domcontentloaded" });
    await viewer.waitForSelector(".viewer-status", { state: "attached", timeout: 10_000 });

    await live.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await live.locator('input[placeholder="xiaoyu"]').fill(roomId);
    await live.locator('input[type="password"]').fill(password);
    await live.getByRole("button", { name: "进入开播页" }).click();
    await live.getByRole("button", { name: "打开摄像头" }).click();
    await live.waitForFunction(() => /\d+x\d+/.test(document.body.textContent ?? ""), { timeout: 15_000 });
    await live.getByRole("button", { name: "开启直播" }).click();

    await waitForViewerVideo(viewer);
    const result = await viewer.evaluate(() => {
      const video = document.querySelector("video");
      const badges = [...document.querySelectorAll(".viewer-status .badge")].map((entry) => entry.textContent ?? "");
      return {
        videoWidth: video?.videoWidth ?? 0,
        videoHeight: video?.videoHeight ?? 0,
        readyState: video?.readyState ?? 0,
        status: badges.join(" "),
        badges
      };
    });

    if (!result.videoWidth || !result.videoHeight) {
      throw new Error(`viewer did not receive video: ${JSON.stringify(result)}`);
    }

    console.log(JSON.stringify({ roomId, ...result }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
