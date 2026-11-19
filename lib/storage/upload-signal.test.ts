import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRESIGNED_URL_EXPIRY_SECONDS } from "./constants";

const NOW = new Date("2026-11-20T10:00:00.000Z");

const staleReceipt = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  objectKey: "users/user-1/receipt-1.png",
  status: "uploading",
  userId: "user-1",
};

const secondStaleReceipt = {
  id: "223e4567-e89b-12d3-a456-426614174001",
  objectKey: "users/user-1/receipt-2.png",
  status: "uploading",
  userId: "user-1",
};

const mockListStaleUploadSignalReceipts =
  vi.fn<
    (
      ownerId: string,
      before: Date
    ) => Promise<
      { id: string; objectKey: string | null; status: string; userId: string }[]
    >
  >();

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
  listStaleUploadSignalReceipts: mockListStaleUploadSignalReceipts,
  receipts: { id: {}, status: {} },
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

const { promoteVerifiedUpload, reconcileStaleUploads, verifyUploadObject } =
  await import("./upload-signal");

describe("verifyUploadObject", () => {
  beforeEach(() => {
    mockObjectExists.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is present when the object is in the bucket", async () => {
    await expect(
      verifyUploadObject("users/user-1/receipt-1.png")
    ).resolves.toBe("present");
    expect(mockObjectExists).toHaveBeenCalledExactlyOnceWith({
      bucket: "receipts",
      key: "users/user-1/receipt-1.png",
    });
  });

  it("is absent when every attempt says not found", async () => {
    mockObjectExists.mockResolvedValue(false);

    await expect(
      verifyUploadObject("users/user-1/receipt-1.png", 2)
    ).resolves.toBe("absent");
    expect(mockObjectExists).toHaveBeenCalledTimes(2);
  });

  it("finds an object the first attempt reported early", async () => {
    mockObjectExists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(
      verifyUploadObject("users/user-1/receipt-1.png", 3)
    ).resolves.toBe("present");
    expect(mockObjectExists).toHaveBeenCalledTimes(2);
  });

  it("rethrows a HEAD that could not be answered", async () => {
    const forbidden = Object.assign(new Error("Forbidden"), {
      $metadata: { httpStatusCode: 403 },
    });
    mockObjectExists.mockRejectedValue(forbidden);

    await expect(verifyUploadObject("users/user-1/receipt-1.png")).rejects.toBe(
      forbidden
    );
  });
});

describe("promoteVerifiedUpload", () => {
  beforeEach(() => {
    mockObjectExists.mockReset().mockResolvedValue(true);
    mockUpdateWhere.mockClear().mockResolvedValue();
    mockUpdateSet.mockClear().mockReturnValue({ where: mockUpdateWhere });
    mockUpdate.mockClear().mockReturnValue({ set: mockUpdateSet });
    mockSend.mockReset().mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("promotes and enqueues a receipt whose object is present", async () => {
    await expect(promoteVerifiedUpload(staleReceipt)).resolves.toBe("promoted");

    expect(mockUpdateSet).toHaveBeenCalledWith({ status: "pending" });
    expect(mockSend).toHaveBeenCalledExactlyOnceWith({
      data: { receiptId: staleReceipt.id, userId: staleReceipt.userId },
      id: `receipt-uploaded-${staleReceipt.id}`,
      name: "receipt/uploaded",
    });
  });

  it("leaves an uploading row alone when the object is absent", async () => {
    mockObjectExists.mockResolvedValue(false);

    await expect(promoteVerifiedUpload(staleReceipt)).resolves.toBe("absent");

    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("treats a row without an object key as absent without a HEAD", async () => {
    await expect(
      promoteVerifiedUpload({ ...staleReceipt, objectKey: null })
    ).resolves.toBe("absent");

    expect(mockObjectExists).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("reconcileStaleUploads", () => {
  beforeEach(() => {
    mockListStaleUploadSignalReceipts
      .mockReset()
      .mockResolvedValue([staleReceipt]);
    mockObjectExists.mockReset().mockResolvedValue(true);
    mockUpdateWhere.mockClear().mockResolvedValue();
    mockUpdateSet.mockClear().mockReturnValue({ where: mockUpdateWhere });
    mockUpdate.mockClear().mockReturnValue({ set: mockUpdateSet });
    mockSend.mockReset().mockResolvedValue();

    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("only asks for this owner's unsettled rows older than the presign window", async () => {
    await reconcileStaleUploads("user-1", NOW);

    expect(mockListStaleUploadSignalReceipts).toHaveBeenCalledExactlyOnceWith(
      "user-1",
      new Date(NOW.getTime() - PRESIGNED_URL_EXPIRY_SECONDS * 1000)
    );
  });

  it("promotes a stale uploading receipt whose object is present", async () => {
    await reconcileStaleUploads("user-1", NOW);

    expect(mockUpdateSet).toHaveBeenCalledWith({ status: "pending" });
    expect(mockSend).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: `receipt-uploaded-${staleReceipt.id}`,
        name: "receipt/uploaded",
      })
    );
  });

  it("fails a stale uploading receipt whose object is absent, and enqueues nothing", async () => {
    mockObjectExists.mockResolvedValue(false);

    await reconcileStaleUploads("user-1", NOW);

    expect(mockUpdateSet).toHaveBeenCalledWith({ status: "error" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("fails a stale uploading receipt that has no object key", async () => {
    mockListStaleUploadSignalReceipts.mockResolvedValue([
      { ...staleReceipt, objectKey: null },
    ]);

    await reconcileStaleUploads("user-1", NOW);

    expect(mockObjectExists).not.toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith({ status: "error" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("leaves an uploading row alone when the HEAD itself fails, and carries on", async () => {
    mockListStaleUploadSignalReceipts.mockResolvedValue([
      staleReceipt,
      secondStaleReceipt,
    ]);
    mockObjectExists
      .mockRejectedValueOnce(
        Object.assign(new Error("Forbidden"), {
          $metadata: { httpStatusCode: 403 },
        })
      )
      .mockResolvedValueOnce(true);

    await reconcileStaleUploads("user-1", NOW);

    // The first row keeps its status; the second is settled normally.
    expect(mockUpdateSet).toHaveBeenCalledExactlyOnceWith({
      status: "pending",
    });
    expect(mockSend).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: `receipt-uploaded-${secondStaleReceipt.id}`,
      })
    );
    expect(console.error).toHaveBeenCalledWith(
      "[receipts.reconcile-uploads]",
      expect.anything()
    );
  });

  it("re-sends a stale pending receipt without verifying or updating it", async () => {
    // The promotion committed but its enqueue failed, and the closed tab means
    // no browser is left to repeat the call.
    mockListStaleUploadSignalReceipts.mockResolvedValue([
      { ...staleReceipt, status: "pending" },
    ]);

    await reconcileStaleUploads("user-1", NOW);

    expect(mockObjectExists).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledExactlyOnceWith({
      data: { receiptId: staleReceipt.id, userId: staleReceipt.userId },
      id: `receipt-uploaded-${staleReceipt.id}`,
      name: "receipt/uploaded",
    });
  });

  it("keeps going when one row's send fails", async () => {
    mockListStaleUploadSignalReceipts.mockResolvedValue([
      { ...staleReceipt, status: "pending" },
      { ...secondStaleReceipt, status: "pending" },
    ]);
    mockSend
      .mockRejectedValueOnce(new Error("inngest unavailable"))
      .mockResolvedValueOnce();

    await reconcileStaleUploads("user-1", NOW);

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: `receipt-uploaded-${secondStaleReceipt.id}`,
      })
    );
    expect(console.error).toHaveBeenCalledWith(
      "[receipts.reconcile-uploads]",
      expect.anything()
    );
  });
});
