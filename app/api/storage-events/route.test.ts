import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-webhook-secret";

const objectKey = "users/user-1/receipt-1.png";

const uploadingReceipt = {
  id: "00000000-0000-0000-0000-000000000001",
  objectKey,
  status: "uploading",
  userId: "user-1",
};

const mockFindReceiptByObjectKey =
  vi.fn<() => Promise<typeof uploadingReceipt | null>>();

const mockUpdateWhere = vi
  .fn<(where: unknown) => Promise<void>>()
  .mockResolvedValue();
const mockUpdateSet = vi
  .fn<(values: unknown) => { where: typeof mockUpdateWhere }>()
  .mockReturnValue({ where: mockUpdateWhere });
const mockUpdate = vi
  .fn<() => { set: typeof mockUpdateSet }>()
  .mockReturnValue({ set: mockUpdateSet });

// @ts-expect-error mock types don't need to match Drizzle internals
vi.mock(import("@/lib/db"), () => ({
  db: { update: mockUpdate },
  findReceiptByObjectKey: mockFindReceiptByObjectKey,
  receipts: { id: {} },
}));

const mockSend = vi.fn<(event: unknown) => Promise<void>>();

// @ts-expect-error mock types don't need to match the Inngest client
vi.mock(import("@/lib/inngest/client"), () => ({
  inngest: { send: mockSend },
}));

// The route reads the secret once, at module load.
vi.stubEnv("STORAGE_WEBHOOK_SECRET", SECRET);

const { POST } = await import("./route");

// Cloudflare's documented R2 Queue message, forwarded unchanged by the Worker
// (#252): https://developers.cloudflare.com/r2/buckets/event-notifications/
const r2Body = (
  action: string,
  key: string,
  object: Record<string, unknown> = {}
) => ({
  account: "3f4b7e3dcab231cbfdaa90a6a28bd548",
  action,
  bucket: "receipts",
  eventTime: "2026-11-19T05:36:44.379Z",
  object: {
    eTag: "c846ff7a18f28c2e262116d6e8719ef0",
    key,
    size: 65_536,
    ...object,
  },
});

const rustfsBody = (key: string, eventName = "s3:ObjectCreated:Put") => ({
  Records: [
    {
      eventName,
      eventSource: "rustfs:s3",
      s3: { object: { key } },
    },
  ],
});

const post = (body: unknown, token: string | null = SECRET) =>
  POST(
    new Request("http://localhost/api/storage-events", {
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: token ? { authorization: `Bearer ${token}` } : {},
      method: "POST",
    })
  );

describe("POST /api/storage-events", () => {
  beforeEach(() => {
    mockFindReceiptByObjectKey.mockResolvedValue(uploadingReceipt);
    // Re-established per test: `vi.restoreAllMocks` in `afterEach` resets the
    // implementation of every `vi.fn` created at module scope.
    mockUpdateWhere.mockClear().mockResolvedValue();
    mockUpdateSet.mockClear().mockReturnValue({ where: mockUpdateWhere });
    mockUpdate.mockClear().mockReturnValue({ set: mockUpdateSet });
    mockSend.mockReset();
    mockSend.mockResolvedValue();

    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("authentication", () => {
    it("rejects a missing bearer token without looking a receipt up", async () => {
      const res = await post(rustfsBody(objectKey), null);

      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toStrictEqual({
        error: "Unauthorized",
      });
      expect(mockFindReceiptByObjectKey).not.toHaveBeenCalled();
    });

    it("rejects a wrong bearer token", async () => {
      const res = await post(rustfsBody(objectKey), "wrong-secret");

      expect(res.status).toBe(401);
      expect(mockFindReceiptByObjectKey).not.toHaveBeenCalled();
    });
  });

  describe("body validation", () => {
    it("rejects a body that is not JSON", async () => {
      const res = await post("not-json");

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toStrictEqual({
        error: "Invalid body",
      });
      expect(mockFindReceiptByObjectKey).not.toHaveBeenCalled();
    });

    it("rejects an unrecognised shape and logs the parse failure", async () => {
      const res = await post({ events: [{ object: { key: "x" } }] });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toStrictEqual({
        error: "Invalid event format",
      });
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("storage-events: parse failed"),
        expect.anything(),
        expect.anything()
      );
      expect(mockFindReceiptByObjectKey).not.toHaveBeenCalled();
    });
  });

  describe("a RustFS upload bucket notification", () => {
    it("promotes an uploading receipt using the decoded object key", async () => {
      const encoded = objectKey.replaceAll("/", "%2F");

      const res = await post(rustfsBody(encoded));

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toStrictEqual({ received: true });
      expect(mockFindReceiptByObjectKey).toHaveBeenCalledWith(objectKey);
      expect(mockUpdateSet).toHaveBeenCalledWith({ status: "pending" });
      expect(mockSend).toHaveBeenCalledWith({
        data: {
          receiptId: uploadingReceipt.id,
          userId: uploadingReceipt.userId,
        },
        id: `receipt-uploaded-${uploadingReceipt.id}`,
        name: "receipt/uploaded",
      });
    });

    it("re-sends for a pending receipt without updating it", async () => {
      mockFindReceiptByObjectKey.mockResolvedValue({
        ...uploadingReceipt,
        status: "pending",
      });

      const res = await post(rustfsBody(objectKey));

      expect(res.status).toBe(200);
      expect(mockUpdateSet).not.toHaveBeenCalled();
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          id: `receipt-uploaded-${uploadingReceipt.id}`,
          name: "receipt/uploaded",
        })
      );
    });

    it.each(["processing", "done"])("ignores a %s receipt", async (status) => {
      mockFindReceiptByObjectKey.mockResolvedValue({
        ...uploadingReceipt,
        status,
      });

      const res = await post(rustfsBody(objectKey));

      expect(res.status).toBe(200);
      expect(mockUpdateSet).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("ignores an object-removed notification as not an upload", async () => {
      const res = await post(rustfsBody(objectKey, "s3:ObjectRemoved:Delete"));

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toStrictEqual({ received: true });
      expect(mockFindReceiptByObjectKey).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("storage-events: not an upload — ignored"),
        expect.anything()
      );
    });
  });

  describe("an R2 upload message", () => {
    it("promotes an uploading receipt using the object key as is", async () => {
      const res = await post(r2Body("PutObject", objectKey));

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toStrictEqual({ received: true });
      expect(mockFindReceiptByObjectKey).toHaveBeenCalledWith(objectKey);
      expect(mockUpdateSet).toHaveBeenCalledWith({ status: "pending" });
      expect(mockSend).toHaveBeenCalledWith({
        data: {
          receiptId: uploadingReceipt.id,
          userId: uploadingReceipt.userId,
        },
        id: `receipt-uploaded-${uploadingReceipt.id}`,
        name: "receipt/uploaded",
      });
    });

    it("promotes on a completed multipart upload", async () => {
      const res = await post(r2Body("CompleteMultipartUpload", objectKey));

      expect(res.status).toBe(200);
      expect(mockFindReceiptByObjectKey).toHaveBeenCalledWith(objectKey);
      expect(mockUpdateSet).toHaveBeenCalledWith({ status: "pending" });
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ name: "receipt/uploaded" })
      );
    });

    it.each([
      // Delete messages carry no size or eTag.
      ["DeleteObject", { eTag: undefined, size: undefined }],
      ["LifecycleDeletion", { eTag: undefined, size: undefined }],
      [
        "CopyObject",
        { copySource: { bucket: "receipts", object: "original.png" } },
      ],
    ])("ignores an R2 %s message as not an upload", async (action, object) => {
      const res = await post(r2Body(action, objectKey, object));

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toStrictEqual({ received: true });
      expect(mockFindReceiptByObjectKey).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("storage-events: not an upload — ignored"),
        expect.anything()
      );
    });
  });

  it("ignores an object key no receipt claims", async () => {
    mockFindReceiptByObjectKey.mockResolvedValue(null);

    const res = await post(rustfsBody("users/user-1/unknown.png"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toStrictEqual({ received: true });
    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns 500 when the event cannot be enqueued", async () => {
    mockSend.mockRejectedValue(new Error("inngest unavailable"));

    const res = await post(rustfsBody(objectKey));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toStrictEqual({
      error: "Failed to enqueue extraction",
    });
  });

  it("ignores an empty object key without looking a receipt up", async () => {
    const res = await post(rustfsBody(""));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toStrictEqual({ received: true });
    expect(mockFindReceiptByObjectKey).not.toHaveBeenCalled();
  });
});
