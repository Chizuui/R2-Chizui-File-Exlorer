import { describe, it, expect } from "vitest";
import worker from "../src";

describe("file downloads", () => {
  it("renders absolute download links without encoding folder slashes", async () => {
    const env = createEnv({
      "tencent/tutorial cloud tencent pc mode.mp4": "video data"
    });
    const cookie = await loginCookie(env, "viewer", "viewerpass");

    const response = await worker.fetch(new Request("http://example.com/?q=tencent", {
      headers: { Cookie: cookie }
    }), env);
    const body = await response.text();

    expect(body).toContain('href="http://example.com/tencent/tutorial%20cloud%20tencent%20pc%20mode.mp4?download=1"');
    expect(body).not.toContain("tencent%2Ftutorial");
  });

  it("returns download headers that external download managers can understand", async () => {
    const env = createEnv({
      "tencent/tutorial cloud tencent pc mode.mp4": "video data"
    });
    const cookie = await loginCookie(env, "viewer", "viewerpass");

    const response = await worker.fetch(
      new Request("http://example.com/tencent/tutorial%20cloud%20tencent%20pc%20mode.mp4?download=1", {
        headers: { Cookie: cookie }
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("10");
    expect(response.headers.get("Accept-Ranges")).toBe("none");
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="tutorial cloud tencent pc mode.mp4"; filename*=UTF-8''tutorial%20cloud%20tencent%20pc%20mode.mp4`
    );
    expect(await response.text()).toBe("video data");
  });

  it("redirects anonymous users before showing the explorer", async () => {
    const env = createEnv({
      "video.mp4": "video data"
    });

    const response = await worker.fetch(new Request("http://example.com/"), env);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("http://example.com/login");
  });

  it("redirects anonymous users before serving direct files", async () => {
    const env = createEnv({
      "video.mp4": "video data"
    });

    const response = await worker.fetch(new Request("http://example.com/video.mp4?download=1"), env);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("http://example.com/login");
  });

  it("blocks viewer users from admin upload endpoints", async () => {
    const env = createEnv({
      "video.mp4": "video data"
    });
    const cookie = await loginCookie(env, "viewer", "viewerpass");

    const response = await worker.fetch(
      new Request("http://example.com/upload-presign", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ filename: "video.mp4" })
      }),
      env
    );

    expect(response.status).toBe(401);
  });

  it("ignores Range headers on forced downloads for FDM compatibility", async () => {
    const env = createEnv({
      "video.mp4": "video data"
    });
    const cookie = await loginCookie(env, "viewer", "viewerpass");

    const response = await worker.fetch(
      new Request("http://example.com/video.mp4?download=1", {
        headers: {
          Cookie: cookie,
          Range: "bytes=0-4"
        }
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("10");
    expect(response.headers.get("Accept-Ranges")).toBe("none");
    expect(response.headers.get("Content-Range")).toBeNull();
    expect(await response.text()).toBe("video data");
  });

  it("still returns a valid partial response for inline previews", async () => {
    const env = createEnv({
      "video.mp4": "video data"
    });
    const cookie = await loginCookie(env, "viewer", "viewerpass");

    const response = await worker.fetch(
      new Request("http://example.com/video.mp4", {
        headers: {
          Cookie: cookie,
          Range: "bytes=0-4"
        }
      }),
      env
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Length")).toBe("5");
    expect(response.headers.get("Content-Range")).toBe("bytes 0-4/10");
    expect(await response.text()).toBe("video");
  });
});

function createEnv(files) {
  return {
    BUCKET: new MockBucket(files),
    USERNAME: "admin",
    PASSWORD: "adminpass",
    VIEWER_USERNAME: "viewer",
    VIEWER_PASSWORD: "viewerpass",
    SECRET_KEY: "test-secret"
  };
}

async function loginCookie(env, username, password) {
  const response = await worker.fetch(new Request("http://example.com/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password })
  }), env);

  const cookie = response.headers.get("Set-Cookie");
  expect(cookie).toBeTruthy();
  return cookie.split(";")[0];
}

class MockBucket {
  constructor(files) {
    this.files = Object.fromEntries(
      Object.entries(files).map(([key, value]) => [
        key,
        new TextEncoder().encode(value)
      ])
    );
  }

  async list() {
    return {
      objects: Object.entries(this.files).map(([key, bytes]) => ({
        key,
        size: bytes.byteLength,
        uploaded: new Date("2026-05-04T10:00:00Z")
      })),
      delimitedPrefixes: [],
      truncated: false
    };
  }

  async get(key, options) {
    const bytes = this.files[key];
    if (!bytes) return null;

    const rangeHeader = options?.range instanceof Headers ? options.range.get("Range") : null;
    if (rangeHeader) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
      if (match) {
        const offset = Number(match[1]);
        const end = match[2] ? Number(match[2]) : bytes.byteLength - 1;
        const chunk = bytes.slice(offset, end + 1);
        return createObject(key, chunk, bytes.byteLength, {
          offset,
          length: chunk.byteLength
        });
      }
    }

    return createObject(key, bytes, bytes.byteLength);
  }

  async head(key) {
    const bytes = this.files[key];
    if (!bytes) return null;
    return createObject(key, new Uint8Array(), bytes.byteLength);
  }
}

function createObject(key, bytes, size, range) {
  return {
    key,
    size,
    range,
    httpEtag: '"mock-etag"',
    body: new Blob([bytes]).stream(),
    writeHttpMetadata(headers) {
      headers.set("Content-Type", key.endsWith(".mp4") ? "video/mp4" : "application/octet-stream");
    }
  };
}
