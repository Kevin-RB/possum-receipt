import { describe, it, expect, vi, beforeEach } from "vitest";

import { USER_ERROR } from "@/lib/errors";

const mockReturning = vi
  .fn<() => Promise<{ receiptId: string }[]>>()
  .mockResolvedValue([{ receiptId: "00000000-0000-0000-0000-000000000001" }]);
const mockInsertValues = vi
  .fn<() => { returning: typeof mockReturning }>()
  .mockReturnValue({ returning: mockReturning });
const mockInsert = vi
  .fn<() => { values: typeof mockInsertValues }>()
  .mockReturnValue({ values: mockInsertValues });

// @ts-expect-error mock types don't need to match Drizzle internals
vi.mock(import("@/lib/db"), () => ({
  db: { insert: mockInsert },
  receipts: {},
}));

const mockGetSession = vi.fn<() => Promise<{ user: { id: string } } | null>>();

// @ts-expect-error mock types don't need to match Better Auth internals
vi.mock(import("@/lib/auth"), () => ({
  auth: { api: { getSession: mockGetSession } },
}));

vi.mock(import("@/lib/storage/client"), () => ({
  BUCKET: "receipts",
  createPresignedUrl: vi
    .fn<() => Promise<string>>()
    .mockResolvedValue("http://rustfs:9000/receipts/abc.jpg?signature=xyz"),
  presignEndpointForHost: vi
    .fn<() => string>()
    .mockReturnValue("localhost:9000"),
}));

vi.mock(import("@/lib/storage/content-type"), () => ({
  extensionForMime: vi
    .fn<(mime: string) => string>()
    .mockImplementation((mime: string) =>
      mime === "image/jpeg" ? "jpg" : "png"
    ),
}));

// @ts-expect-error mock types don't need to match Drizzle internals
vi.mock(import("node:crypto"), () => ({
  randomUUID: vi
    .fn<() => string>()
    .mockReturnValue("00000000-0000-0000-0000-000000000001"),
}));

const { POST } = await import("./route");

describe("POST /api/upload", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("rejects unauthenticated requests", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await POST(
      new Request("http://localhost/api/upload", {
        body: JSON.stringify({
          contentType: "image/jpeg",
          fileSize: 1000,
        }),
        method: "POST",
      })
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe(USER_ERROR.unauthorized);
  });

  it("stamps the receipt with the session user's id", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user-1" } });

    const res = await POST(
      new Request("http://localhost/api/upload", {
        body: JSON.stringify({
          contentType: "image/jpeg",
          fileSize: 100_000,
        }),
        method: "POST",
      })
    );

    expect(res.status).toBe(200);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" })
    );
  });

  it("namespaces the object key under the owner's prefix", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user-1" } });

    await POST(
      new Request("http://localhost/api/upload", {
        body: JSON.stringify({
          contentType: "image/jpeg",
          fileSize: 100_000,
        }),
        method: "POST",
      })
    );

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        objectKey: "users/user-1/00000000-0000-0000-0000-000000000001.jpg",
      })
    );
  });

  it("rejects non-JPEG/PNG content types", async () => {
    const res = await POST(
      new Request("http://localhost/api/upload", {
        body: JSON.stringify({
          contentType: "image/gif",
          fileSize: 1000,
        }),
        method: "POST",
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Unsupported content type");
  });

  it("rejects invalid JSON body", async () => {
    const res = await POST(
      new Request("http://localhost/api/upload", {
        body: "not-json",
        method: "POST",
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid request body");
  });

  it("rejects files over 5 MB", async () => {
    const res = await POST(
      new Request("http://localhost/api/upload", {
        body: JSON.stringify({
          contentType: "image/jpeg",
          fileSize: 10 * 1024 * 1024,
        }),
        method: "POST",
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("5242880");
  });

  it("rejects zero or negative file sizes", async () => {
    const res = await POST(
      new Request("http://localhost/api/upload", {
        body: JSON.stringify({
          contentType: "image/jpeg",
          fileSize: 0,
        }),
        method: "POST",
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("fileSize must be > 0");
  });

  it("accepts a valid JPEG upload request", async () => {
    const res = await POST(
      new Request("http://localhost/api/upload", {
        body: JSON.stringify({
          contentType: "image/jpeg",
          fileSize: 100_000,
        }),
        method: "POST",
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("receiptId");
    expect(body).toHaveProperty("uploadUrl");
  });
});
