import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { USER_ERROR } from "@/lib/errors";

const SECRET = "test-webhook-secret";

const objectKey = "users/user-1/receipt-1.png";

const uploadingReceipt = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  objectKey,
  status: "uploading",
  userId: "user-1",
};

const mockFindReceiptByObjectKey =
  vi.fn<() => Promise<typeof uploadingReceipt | null>>();
const mockFindReceiptByIdForOwner =
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
  findReceiptByIdForOwner: mockFindReceiptByIdForOwner,
  findReceiptByObjectKey: mockFindReceiptByObjectKey,
  listStaleUploadSignalReceipts: vi.fn<() => Promise<unknown[]>>(() =>
    Promise.resolve([])
  ),
  receipts: { id: {}, status: {} },
}));

const mockGetSession = vi.fn<() => Promise<{ user: { id: string } } | null>>();

// @ts-expect-error mock types don't need to match Better Auth internals
vi.mock(import("@/lib/auth"), () => ({
  auth: { api: { getSession: mockGetSession } },
}));

const mockSend = vi.fn<(event: unknown) => Promise<void>>();

// @ts-expect-error mock types don't need to match the Inngest client
vi.mock(import("@/lib/inngest/client"), () => ({
  inngest: { send: mockSend },
}));

const mockObjectExists = vi.fn<() => Promise<boolean>>();

vi.mock(import("@/lib/storage/client"), () => ({
  BUCKET: "receipts",
  objectExists: mockObjectExists,
}));

const { POST } = await import("./route");

const rustfsBody = (key: string, eventName = "s3:ObjectCreated:Put") => ({
  Records: [
    {
      eventName,
      eventSource: "rustfs:s3",
      s3: { object: { key } },
    },
  ],
});

const notification = (body: unknown, token: string | null = SECRET) =>
  POST(
    new Request("http://localhost/api/storage-events", {
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: token ? { authorization: `Bearer ${token}` } : {},
      method: "POST",
    })
  );

const uploadSignal = (receiptId: unknown, session = true) =>
  POST(
    new Request("http://localhost/api/storage-events", {
      body: JSON.stringify({ receiptId }),
      headers: session ? { cookie: "session=abc" } : {},
      method: "POST",
    })
  );

describe("POST /api/storage-events", () => {
  beforeEach(() => {
    vi.stubEnv("STORAGE_WEBHOOK_SECRET", SECRET);
    mockFindReceiptByObjectKey.mockResolvedValue(uploadingReceipt);
    mockFindReceiptByIdForOwner.mockResolvedValue(uploadingReceipt);
    mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
    mockObjectExists.mockResolvedValue(true);
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
    vi.unstubAllEnvs();
  });

  describe("choosing the path", () => {
    it("refuses a request carrying neither credentials", async () => {
      mockGetSession.mockResolvedValue(null);

      const res = await uploadSignal(uploadingReceipt.id, false);

      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toStrictEqual({
        error: USER_ERROR.unauthorized,
      });
      expect(mockFindReceiptByIdForOwner).not.toHaveBeenCalled();
      expect(mockFindReceiptByObjectKey).not.toHaveBeenCalled();
    });

    it("does not let a session reach the webhook path", async () => {
      // A RustFS-shaped body with a cookie but no Bearer token is a browser
      // request, so it fails the upload-signal body check instead of promoting
      // an object by key.
      const res = await notification(rustfsBody(objectKey), null);

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toStrictEqual({
        error: USER_ERROR.invalidInput,
      });
      expect(mockFindReceiptByObjectKey).not.toHaveBeenCalled();
      expect(mockUpdateSet).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("does not let a Bearer token reach the browser path", async () => {
      const res = await notification({ receiptId: uploadingReceipt.id });

      expect(res.status).toBe(400);
      expect(mockFindReceiptByIdForOwner).not.toHaveBeenCalled();
      expect(mockObjectExists).not.toHaveBeenCalled();
    });
  });

  describe("the RustFS webhook", () => {
    it("rejects a wrong bearer token", async () => {
      const res = await notification(rustfsBody(objectKey), "wrong-secret");

      expect(res.status).toBe(401);
      expect(mockFindReceiptByObjectKey).not.toHaveBeenCalled();
    });

    it("fails closed when no secret is configured", async () => {
      vi.stubEnv("STORAGE_WEBHOOK_SECRET", "");

      // The old behaviour accepted any RustFS-shaped body when the variable was
      // unset, which is the one case that must never be trusted.
      const res = await notification(rustfsBody(objectKey), SECRET);

      expect(res.status).toBe(401);
      expect(mockFindReceiptByObjectKey).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("rejects a body that is not JSON", async () => {
      const res = await notification("not-json");

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toStrictEqual({
        error: "Invalid body",
      });
    });

    it("rejects an unrecognised shape and logs the parse failure", async () => {
      const res = await notification({ events: [{ object: { key: "x" } }] });

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

    it("promotes an uploading receipt using the decoded object key", async () => {
      const encoded = objectKey.replaceAll("/", "%2F");

      const res = await notification(rustfsBody(encoded));

      expect(res.status).toBe(200);
      expect(mockFindReceiptByObjectKey).toHaveBeenCalledWith(objectKey);
      expect(mockUpdateSet).toHaveBeenCalledWith({ status: "pending" });
      expect(mockSend).toHaveBeenCalledExactlyOnceWith({
        data: {
          receiptId: uploadingReceipt.id,
          userId: uploadingReceipt.userId,
        },
        id: `receipt-uploaded-${uploadingReceipt.id}`,
        name: "receipt/uploaded",
      });
      // The webhook is the storage layer's own word, so it is not re-verified.
      expect(mockObjectExists).not.toHaveBeenCalled();
    });

    it("re-sends for a pending receipt without updating it", async () => {
      mockFindReceiptByObjectKey.mockResolvedValue({
        ...uploadingReceipt,
        status: "pending",
      });

      const res = await notification(rustfsBody(objectKey));

      expect(res.status).toBe(200);
      expect(mockUpdateSet).not.toHaveBeenCalled();
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          id: `receipt-uploaded-${uploadingReceipt.id}`,
          name: "receipt/uploaded",
        })
      );
    });

    it.each(["processing", "done", "error"])(
      "ignores a %s receipt",
      async (status) => {
        mockFindReceiptByObjectKey.mockResolvedValue({
          ...uploadingReceipt,
          status,
        });

        const res = await notification(rustfsBody(objectKey));

        expect(res.status).toBe(200);
        expect(mockUpdateSet).not.toHaveBeenCalled();
        expect(mockSend).not.toHaveBeenCalled();
      }
    );

    it("ignores an object-removed notification as not an upload", async () => {
      const res = await notification(
        rustfsBody(objectKey, "s3:ObjectRemoved:Delete")
      );

      expect(res.status).toBe(200);
      expect(mockFindReceiptByObjectKey).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("ignores an object key no receipt claims", async () => {
      mockFindReceiptByObjectKey.mockResolvedValue(null);

      const res = await notification(rustfsBody("users/user-1/unknown.png"));

      expect(res.status).toBe(200);
      expect(mockUpdateSet).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("returns 500 when the event cannot be enqueued", async () => {
      mockSend.mockRejectedValue(new Error("inngest unavailable"));

      const res = await notification(rustfsBody(objectKey));

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toStrictEqual({
        error: "Failed to enqueue extraction",
      });
    });

    it("ignores an empty object key without looking a receipt up", async () => {
      const res = await notification(rustfsBody(""));

      expect(res.status).toBe(200);
      expect(mockFindReceiptByObjectKey).not.toHaveBeenCalled();
    });
  });

  describe("the browser's upload signal", () => {
    it("rejects a body that names no receipt", async () => {
      const res = await uploadSignal({});

      expect(res.status).toBe(400);
      expect(mockFindReceiptByIdForOwner).not.toHaveBeenCalled();
    });

    it("rejects a receipt id that is not a uuid", async () => {
      const res = await uploadSignal("receipt-1");

      expect(res.status).toBe(400);
      expect(mockFindReceiptByIdForOwner).not.toHaveBeenCalled();
    });

    it("refuses another owner's receipt and changes nothing", async () => {
      mockFindReceiptByIdForOwner.mockResolvedValue(null);

      const res = await uploadSignal(uploadingReceipt.id);

      expect(res.status).toBe(404);
      expect(mockFindReceiptByIdForOwner).toHaveBeenCalledWith(
        uploadingReceipt.id,
        "user-1"
      );
      expect(mockObjectExists).not.toHaveBeenCalled();
      expect(mockUpdateSet).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("promotes a verified upload once, then enqueues it", async () => {
      const res = await uploadSignal(uploadingReceipt.id);

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toStrictEqual({ received: true });
      // The key comes from the row, never from the request.
      expect(mockObjectExists).toHaveBeenCalledExactlyOnceWith({
        bucket: "receipts",
        key: objectKey,
      });
      expect(mockUpdateSet).toHaveBeenCalledWith({ status: "pending" });
      expect(mockSend).toHaveBeenCalledExactlyOnceWith({
        data: {
          receiptId: uploadingReceipt.id,
          userId: uploadingReceipt.userId,
        },
        id: `receipt-uploaded-${uploadingReceipt.id}`,
        name: "receipt/uploaded",
      });
    });

    it("leaves an upload with no object uploading, and enqueues nothing", async () => {
      mockObjectExists.mockResolvedValue(false);

      const res = await uploadSignal(uploadingReceipt.id);

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toStrictEqual({
        error: USER_ERROR.uploadFailed,
      });
      // One HEAD per attempt, no promotion and no extraction.
      expect(mockObjectExists).toHaveBeenCalledTimes(3);
      expect(mockUpdateSet).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("returns 500 when the object cannot be checked, leaving the row alone", async () => {
      mockObjectExists.mockRejectedValue(
        Object.assign(new Error("Forbidden"), {
          $metadata: { httpStatusCode: 403 },
        })
      );

      const res = await uploadSignal(uploadingReceipt.id);

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toStrictEqual({
        error: USER_ERROR.generic,
      });
      expect(mockUpdateSet).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("re-sends for a pending receipt without updating it", async () => {
      mockFindReceiptByIdForOwner.mockResolvedValue({
        ...uploadingReceipt,
        status: "pending",
      });

      const res = await uploadSignal(uploadingReceipt.id);

      expect(res.status).toBe(200);
      expect(mockObjectExists).not.toHaveBeenCalled();
      expect(mockUpdateSet).not.toHaveBeenCalled();
      expect(mockSend).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          id: `receipt-uploaded-${uploadingReceipt.id}`,
          name: "receipt/uploaded",
        })
      );
    });

    it.each(["processing", "done"])(
      "ignores a %s receipt without enqueuing anything",
      async (status) => {
        mockFindReceiptByIdForOwner.mockResolvedValue({
          ...uploadingReceipt,
          status,
        });

        const res = await uploadSignal(uploadingReceipt.id);

        expect(res.status).toBe(200);
        expect(mockObjectExists).not.toHaveBeenCalled();
        expect(mockUpdateSet).not.toHaveBeenCalled();
        expect(mockSend).not.toHaveBeenCalled();
      }
    );

    it("refuses an error receipt, which nothing will ever extract", async () => {
      // Reconciliation can reach `error` before this call arrives: a slow PUT
      // started just inside the presign window can finish after `/receipts`
      // settled the row. Success here would tell the card the upload arrived.
      mockFindReceiptByIdForOwner.mockResolvedValue({
        ...uploadingReceipt,
        status: "error",
      });

      const res = await uploadSignal(uploadingReceipt.id);

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toStrictEqual({
        error: USER_ERROR.uploadFailed,
      });
      expect(mockObjectExists).not.toHaveBeenCalled();
      expect(mockUpdateSet).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("returns 500 when the enqueue fails after promotion", async () => {
      mockSend.mockRejectedValue(new Error("inngest unavailable"));

      const res = await uploadSignal(uploadingReceipt.id);

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toStrictEqual({
        error: USER_ERROR.generic,
      });
      // The promotion is committed; a repeat call takes the pending path.
      expect(mockUpdateSet).toHaveBeenCalledWith({ status: "pending" });
    });
  });
});
