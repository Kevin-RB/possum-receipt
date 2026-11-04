import { describe, expect, it, vi, beforeEach } from "vitest";

import { USER_ERROR } from "@/lib/errors";

const {
  mockDelete,
  mockDeleteObject,
  mockDeleteWhere,
  mockFindFirst,
  mockGetSession,
  mockListAvailableModels,
  mockRevalidatePath,
  mockReturning,
  mockSend,
  mockUpdate,
  mockUpdateSet,
  mockUpdateWhere,
} = vi.hoisted(() => {
  const deleteWhere = vi.fn<() => Promise<void>>().mockResolvedValue();
  const deleteTable = vi
    .fn<(table: unknown) => { where: typeof deleteWhere }>()
    .mockReturnValue({ where: deleteWhere });

  const findFirst = vi
    .fn<
      () => Promise<{
        objectKey: string | null;
        processingStartedAt?: Date | null;
        status: string;
      } | null>
    >()
    .mockResolvedValue({ objectKey: "abc.jpg", status: "done" });

  const returning = vi
    .fn<() => Promise<{ id: string }[]>>()
    .mockResolvedValue([{ id: "123e4567-e89b-12d3-a456-426614174000" }]);
  const updateWhere = vi
    .fn<() => { returning: typeof returning }>()
    .mockReturnValue({ returning });
  const updateSet = vi
    .fn<(payload: Record<string, unknown>) => { where: typeof updateWhere }>()
    .mockReturnValue({ where: updateWhere });
  const updateTable = vi
    .fn<(table: unknown) => { set: typeof updateSet }>()
    .mockReturnValue({ set: updateSet });

  return {
    mockDelete: deleteTable,
    mockDeleteObject: vi.fn<() => Promise<void>>().mockResolvedValue(),
    mockDeleteWhere: deleteWhere,
    mockFindFirst: findFirst,
    mockGetSession: vi
      .fn<() => Promise<{ user: { id: string } } | null>>()
      .mockResolvedValue({ user: { id: "user-1" } }),
    mockListAvailableModels: vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValue(["glm-ocr", "google/gemma-4-e4b"]),
    mockReturning: returning,
    mockRevalidatePath: vi.fn<(path: string) => undefined>(),
    mockSend: vi.fn<(events: unknown) => Promise<void>>().mockResolvedValue(),
    mockUpdate: updateTable,
    mockUpdateSet: updateSet,
    mockUpdateWhere: updateWhere,
  };
});

// @ts-expect-error mock types don't match Drizzle internals
vi.mock(import("@/lib/db"), () => ({
  db: {
    delete: mockDelete,
    query: { receipts: { findFirst: mockFindFirst } },
    update: mockUpdate,
  },
  receipts: {},
}));

// @ts-expect-error mock types don't match Better Auth internals
vi.mock(import("@/lib/auth"), () => ({
  auth: { api: { getSession: mockGetSession } },
}));

vi.mock(import("next/headers"), () => ({
  headers: () => Promise.resolve(new Headers()),
}));

vi.mock(import("@/lib/storage/client"), () => ({
  BUCKET: "receipts",
  deleteObject: mockDeleteObject,
}));

vi.mock(import("next/cache"), () => ({
  revalidatePath: mockRevalidatePath,
}));

vi.mock(import("@/lib/ai/models"), async (importOriginal) => ({
  ...(await importOriginal()),
  listAvailableModels: mockListAvailableModels,
}));

// @ts-expect-error mock types don't match Inngest internals
vi.mock(import("@/lib/inngest/client"), () => ({
  inngest: { send: mockSend },
}));

const { deleteReceipt, listExtractionModels, reprocessReceipt } =
  await import("./actions");

const receiptId = "123e4567-e89b-12d3-a456-426614174000";

describe(deleteReceipt, () => {
  beforeEach(() => {
    mockGetSession.mockClear();
    mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
    mockFindFirst.mockClear();
    mockFindFirst.mockResolvedValue({
      objectKey: "abc.jpg",
      status: "done",
    });
    mockDeleteObject.mockClear();
    mockDeleteWhere.mockClear();
    mockDelete.mockClear();
    mockRevalidatePath.mockClear();
  });

  it("rejects unauthenticated requests without touching the database", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const result = await deleteReceipt(receiptId);

    expect(result).toStrictEqual({
      error: USER_ERROR.unauthorized,
      success: false,
    });
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it("returns not-found for another user's receipt without mutating anything", async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    const result = await deleteReceipt(receiptId);

    expect(result).toStrictEqual({
      error: "Receipt not found",
      success: false,
    });
    expect(mockDeleteObject).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("scopes the ownership lookup to the session user", async () => {
    await deleteReceipt(receiptId);

    expect(mockFindFirst).toHaveBeenCalledExactlyOnceWith({
      where: { id: receiptId, userId: "user-1" },
    });
  });

  it("deletes the storage object and the row for the owner", async () => {
    const result = await deleteReceipt(receiptId);

    expect(result).toStrictEqual({ success: true });
    expect(mockDeleteObject).toHaveBeenCalledExactlyOnceWith({
      bucket: "receipts",
      key: "abc.jpg",
    });
    expect(mockDeleteWhere).toHaveBeenCalledWith(
      expect.objectContaining({
        queryChunks: expect.arrayContaining([receiptId]),
      })
    );
    expect(mockRevalidatePath).toHaveBeenCalledExactlyOnceWith("/");
  });

  it("deletes the row without storage when there is no object key", async () => {
    mockFindFirst.mockResolvedValueOnce({
      objectKey: null,
      status: "uploading",
    });

    const result = await deleteReceipt(receiptId);

    expect(result).toStrictEqual({ success: true });
    expect(mockDeleteObject).not.toHaveBeenCalled();
    expect(mockDeleteWhere).toHaveBeenCalledOnce();
  });

  it("returns an error when deletion fails", async () => {
    mockDeleteObject.mockRejectedValueOnce(new Error("connection refused"));

    const result = await deleteReceipt(receiptId);

    expect(result).toStrictEqual({
      error: "Failed to delete receipt",
      success: false,
    });
  });
});

const input = {
  models: { ocr: "glm-ocr", parse: "google/gemma-4-e4b" },
  receiptId,
};

describe(reprocessReceipt, () => {
  beforeEach(() => {
    mockGetSession.mockClear();
    mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
    mockFindFirst.mockClear();
    mockFindFirst.mockResolvedValue({
      objectKey: "abc.jpg",
      status: "done",
    });
    mockListAvailableModels.mockClear();
    mockListAvailableModels.mockResolvedValue([
      "glm-ocr",
      "google/gemma-4-e4b",
    ]);
    mockRevalidatePath.mockClear();
    mockReturning.mockClear();
    mockReturning.mockResolvedValue([{ id: receiptId }]);
    mockSend.mockClear();
    mockUpdate.mockClear();
    mockUpdateSet.mockClear();
    mockUpdateWhere.mockClear();
  });

  it("rejects unauthenticated requests without touching the database", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const result = await reprocessReceipt(input);

    expect(result).toStrictEqual({
      error: USER_ERROR.unauthorized,
      success: false,
    });
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns not-found for another user's receipt", async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    const result = await reprocessReceipt(input);

    expect(result).toStrictEqual({
      error: "Receipt not found",
      success: false,
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("rejects an invalid payload", async () => {
    const result = await reprocessReceipt({ ...input, receiptId: "nope" });

    expect(result).toStrictEqual({
      error: "Validation failed",
      success: false,
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses an upload that has no image in storage yet", async () => {
    mockFindFirst.mockResolvedValueOnce({
      objectKey: "abc.jpg",
      status: "uploading",
    });

    const result = await reprocessReceipt(input);

    expect(result).toStrictEqual({
      error: "Receipt is not ready to re-process",
      success: false,
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  // Whether a claim is stale enough to take is decided by the WHERE clause, so
  // a mocked drizzle cannot exercise it — `mockReturning` stands in for that
  // verdict. What these cover is what the action does with each answer, and the
  // predicate itself is verified against a real database.
  it("takes over a claim that was abandoned", async () => {
    // The run that owed this receipt was never created, or died before its
    // failure handler could run. Without this the row is unreachable from the
    // app: nothing else moves it out of processing.
    mockFindFirst.mockResolvedValueOnce({
      objectKey: "abc.jpg",
      processingStartedAt: new Date(Date.now() - 31 * 60 * 1000),
      status: "processing",
    });

    const result = await reprocessReceipt(input);

    expect(result).toStrictEqual({ success: true });
    expect(mockSend).toHaveBeenCalledOnce();
  });

  it("takes over a claim stamped before the column existed", async () => {
    mockFindFirst.mockResolvedValueOnce({
      objectKey: "abc.jpg",
      processingStartedAt: null,
      status: "processing",
    });

    const result = await reprocessReceipt(input);

    expect(result).toStrictEqual({ success: true });
  });

  it("refuses a receipt that is queued rather than claimed", async () => {
    // A receipt waiting for a slot has never been extracted, so it can be
    // replaced outright; taking its claim over would race the run that already
    // owns it.
    mockReturning.mockResolvedValueOnce([]);
    mockFindFirst.mockResolvedValueOnce({
      objectKey: "abc.jpg",
      processingStartedAt: new Date(Date.now() - 31 * 60 * 1000),
      status: "pending",
    });

    const result = await reprocessReceipt(input);

    expect(result).toStrictEqual({
      error: "Receipt is already being processed",
      success: false,
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("names no prior status when taking over an abandoned claim", async () => {
    // A stale claim says nothing about what the receipt looked like before the
    // run that abandoned it, so a failure must land somewhere re-processable
    // rather than leaving the row claimed again.
    mockFindFirst.mockResolvedValueOnce({
      objectKey: "abc.jpg",
      processingStartedAt: new Date(Date.now() - 31 * 60 * 1000),
      status: "processing",
    });

    await reprocessReceipt(input);

    expect(mockSend).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({
        data: expect.objectContaining({ previousStatus: "error" }),
      }),
    ]);
  });

  it("refuses a receipt with no stored image to read", async () => {
    mockFindFirst.mockResolvedValueOnce({
      objectKey: null,
      status: "done",
    });

    const result = await reprocessReceipt(input);

    expect(result).toStrictEqual({
      error: "Receipt has no image to re-process",
      success: false,
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("says the server is unreachable rather than blaming the model", async () => {
    mockListAvailableModels.mockResolvedValueOnce([]);

    const result = await reprocessReceipt(input);

    expect(result).toStrictEqual({
      error: "The model server is not reachable",
      success: false,
    });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses a model the provider does not report", async () => {
    const result = await reprocessReceipt({
      ...input,
      models: { ocr: "made-up-model", parse: "google/gemma-4-e4b" },
    });

    expect(result).toStrictEqual({
      error: "That model is not available",
      success: false,
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("claims the receipt by moving it to processing", async () => {
    await reprocessReceipt(input);

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "processing" })
    );
    expect(mockUpdateWhere).toHaveBeenCalledOnce();
  });

  it("stamps the claim so it can later be told from an abandoned one", async () => {
    await reprocessReceipt(input);

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ processingStartedAt: expect.any(Date) })
    );
  });

  it("refuses a second request once the receipt is claimed", async () => {
    mockReturning.mockResolvedValueOnce([]);

    const result = await reprocessReceipt(input);

    expect(result).toStrictEqual({
      error: "Receipt is already being processed",
      success: false,
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("starts a run with the chosen models and the status to restore", async () => {
    const result = await reprocessReceipt(input);

    expect(result).toStrictEqual({ success: true });
    expect(mockSend).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({
        data: {
          models: { ocr: "glm-ocr", parse: "google/gemma-4-e4b" },
          previousStatus: "done",
          receiptId,
          userId: "user-1",
        },
        name: "receipt/reprocess",
      }),
    ]);
  });

  it("gives every request its own event id so a repeat is a new run", async () => {
    await reprocessReceipt(input);
    await reprocessReceipt(input);

    const ids = mockSend.mock.calls.flatMap(([events]) =>
      (events as { id: string }[]).map((event) => event.id)
    );

    expect(ids[0]).not.toBe(ids[1]);
  });

  it("records a failed receipt's status so a failure can restore it", async () => {
    mockFindFirst.mockResolvedValueOnce({
      objectKey: "abc.jpg",
      status: "error",
    });

    await reprocessReceipt(input);

    expect(mockSend).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({
        data: expect.objectContaining({ previousStatus: "error" }),
      }),
    ]);
  });

  it("releases the claim when the run cannot be enqueued", async () => {
    mockSend.mockRejectedValueOnce(new Error("inngest unreachable"));

    const result = await reprocessReceipt(input);

    expect(result).toStrictEqual({
      error: "Failed to start re-processing",
      success: false,
    });
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "done" })
    );
  });

  it("puts back the stamp it took when the run cannot be enqueued", async () => {
    // The claim wrote a fresh stamp. Leaving it behind re-locks the receipt for
    // another full lease — after the owner had already waited one out to get
    // here — which is the dead end this whole path exists to close.
    const abandoned = new Date(Date.now() - 40 * 60 * 1000);
    mockFindFirst.mockResolvedValueOnce({
      objectKey: "abc.jpg",
      processingStartedAt: abandoned,
      status: "processing",
    });
    mockSend.mockRejectedValueOnce(new Error("inngest unreachable"));

    await reprocessReceipt(input);

    expect(mockUpdateSet).toHaveBeenLastCalledWith(
      expect.objectContaining({
        processingStartedAt: abandoned,
        status: "processing",
      })
    );
  });
});

describe(listExtractionModels, () => {
  beforeEach(() => {
    mockGetSession.mockClear();
    mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
    mockListAvailableModels.mockClear();
  });

  it("returns nothing to an unauthenticated caller", async () => {
    // Server actions are HTTP endpoints, so this one is reachable without a
    // session unless it says otherwise.
    mockGetSession.mockResolvedValueOnce(null);

    await expect(listExtractionModels()).resolves.toStrictEqual({
      available: [],
      defaults: { ocr: "", parse: "" },
    });
    expect(mockListAvailableModels).not.toHaveBeenCalled();
  });

  it("does not reach the provider without a session", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    await listExtractionModels();

    expect(mockListAvailableModels).not.toHaveBeenCalled();
  });

  it("returns the ids the provider reports, alongside the defaults", async () => {
    mockListAvailableModels.mockResolvedValueOnce(["glm-ocr"]);

    await expect(listExtractionModels()).resolves.toStrictEqual({
      available: ["glm-ocr"],
      defaults: { ocr: "glm-ocr", parse: "google/gemma-4-e4b" },
    });
  });

  it("offers nothing rather than models the trigger would refuse", async () => {
    mockListAvailableModels.mockResolvedValueOnce([]);

    await expect(listExtractionModels()).resolves.toStrictEqual({
      available: [],
      defaults: { ocr: "glm-ocr", parse: "google/gemma-4-e4b" },
    });
  });

  it("does not offer a model the provider has not loaded", async () => {
    mockListAvailableModels.mockResolvedValueOnce(["glm-ocr"]);

    const result = await listExtractionModels();

    expect(result.available).toStrictEqual(["glm-ocr"]);
  });
});
