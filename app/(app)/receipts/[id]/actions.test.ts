import { describe, expect, it, vi, beforeEach } from "vitest";

import { USER_ERROR } from "@/lib/errors";

import type { UpdateReceiptInput } from "./schema";

const {
  mockDelete,
  mockDeleteWhere,
  mockFindFirst,
  mockGetSession,
  mockInsert,
  mockInsertValues,
  mockListCategoryOptions,
  mockRevalidatePath,
  mockReceiptDateTimeToWallClock,
  mockSet,
  mockSetWhere,
  mockTransaction,
  mockUpdate,
} = vi.hoisted(() => {
  const setWhere = vi.fn<() => Promise<void>>().mockResolvedValue();
  const setValue = vi
    .fn<(payload: Record<string, unknown>) => { where: typeof setWhere }>()
    .mockReturnValue({ where: setWhere });
  const updateTable = vi
    .fn<(table: unknown) => { set: typeof setValue }>()
    .mockReturnValue({ set: setValue });

  const deleteWhere = vi.fn<() => Promise<void>>().mockResolvedValue();
  const deleteTable = vi
    .fn<(table: unknown) => { where: typeof deleteWhere }>()
    .mockReturnValue({ where: deleteWhere });

  const insertValues = vi.fn<() => Promise<void>>().mockResolvedValue();
  const insertTable = vi
    .fn<(table: unknown) => { values: typeof insertValues }>()
    .mockReturnValue({ values: insertValues });

  const tx = {
    delete: deleteTable,
    insert: insertTable,
    update: updateTable,
  };

  const transaction = vi
    .fn<
      (
        fn: (tx: {
          delete: typeof deleteTable;
          insert: typeof insertTable;
          update: typeof updateTable;
        }) => Promise<void>
      ) => Promise<void>
    >()
    .mockImplementation((fn) => fn(tx));

  const findFirst = vi
    .fn<
      () => Promise<{
        receiptItems: {
          categoryId: string | null;
          categorySource: "ai" | "user";
          id: string;
        }[];
        status: string;
      } | null>
    >()
    .mockResolvedValue({ receiptItems: [], status: "done" });

  const listCategoryOptions = vi
    .fn<
      () => Promise<
        { id: string; name: string; parentName: string | null; slug: string }[]
      >
    >()
    .mockResolvedValue([
      {
        id: "123e4567-e89b-12d3-a456-426614174010",
        name: "Dairy & Eggs",
        parentName: "Groceries",
        slug: "dairy-eggs",
      },
      {
        id: "123e4567-e89b-12d3-a456-426614174011",
        name: "Other",
        parentName: null,
        slug: "other",
      },
    ]);

  const revalidatePath = vi.fn<(path: string) => undefined>();
  const receiptDateTimeToWallClock = vi
    .fn<(datetime: string) => string>()
    .mockReturnValue("2026-01-01 10:00:00");
  const getSession = vi
    .fn<() => Promise<{ user: { id: string } } | null>>()
    .mockResolvedValue({ user: { id: "user-1" } });

  return {
    mockDelete: deleteTable,
    mockDeleteWhere: deleteWhere,
    mockFindFirst: findFirst,
    mockGetSession: getSession,
    mockInsert: insertTable,
    mockInsertValues: insertValues,
    mockListCategoryOptions: listCategoryOptions,
    mockReceiptDateTimeToWallClock: receiptDateTimeToWallClock,
    mockRevalidatePath: revalidatePath,
    mockSet: setValue,
    mockSetWhere: setWhere,
    mockTransaction: transaction,
    mockUpdate: updateTable,
  };
});

// @ts-expect-error mock types don't match Drizzle internals
vi.mock(import("@/lib/db"), () => ({
  db: {
    query: { receipts: { findFirst: mockFindFirst } },
    transaction: mockTransaction,
  },
  listCategoryOptions: mockListCategoryOptions,
  receiptItems: {},
  receipts: {},
}));

// @ts-expect-error mock types don't match Better Auth internals
vi.mock(import("@/lib/auth"), () => ({
  auth: { api: { getSession: mockGetSession } },
}));

vi.mock(import("next/headers"), () => ({
  headers: () => Promise.resolve(new Headers()),
}));

vi.mock(import("next/cache"), () => ({
  revalidatePath: mockRevalidatePath,
}));

vi.mock(import("@/lib/receipt/datetime"), () => ({
  receiptDateTimeToWallClock: mockReceiptDateTimeToWallClock,
  wallClockToLocalString: vi.fn<(value: string) => string>(),
}));

const { updateReceipt } = await import("./actions");

const receiptId = "123e4567-e89b-12d3-a456-426614174000";
const itemOneId = "123e4567-e89b-12d3-a456-426614174001";
const itemTwoId = "123e4567-e89b-12d3-a456-426614174002";
const otherReceiptsItemId = "123e4567-e89b-12d3-a456-426614174003";
const dairyId = "123e4567-e89b-12d3-a456-426614174010";
const otherId = "123e4567-e89b-12d3-a456-426614174011";

const validInput: UpdateReceiptInput = {
  items: [
    {
      categoryTouched: false,
      kind: "product",
      lineTotal: 10,
      name: "Milk",
      quantity: 1,
      unitPrice: 10,
    },
    {
      categoryTouched: false,
      kind: "product",
      lineTotal: 5.5,
      name: "Bread",
      quantity: 1,
      unitPrice: 5.5,
    },
  ],
  merchant: {
    address: "1 Main St",
    name: "Coles",
    storeId: "1234",
  },
  payment: { method: "card" },
  receiptId,
  totals: { gst: 1.5, subtotal: 15.5, total: 15.5 },
  transaction: {
    datetime: "2026-01-01T10:00:00Z",
    receiptNumber: "R-123",
  },
};

describe(updateReceipt, () => {
  beforeEach(() => {
    mockGetSession.mockClear();
    mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
    mockFindFirst.mockClear();
    mockFindFirst.mockResolvedValue({ receiptItems: [], status: "done" });
    mockListCategoryOptions.mockClear();
    mockSetWhere.mockClear();
    mockSet.mockClear();
    mockUpdate.mockClear();
    mockDeleteWhere.mockClear();
    mockDelete.mockClear();
    mockInsertValues.mockClear();
    mockInsert.mockClear();
    mockRevalidatePath.mockClear();
    mockTransaction.mockClear();
  });

  it("rejects payloads with negative totals", async () => {
    const result = await updateReceipt({
      ...validInput,
      totals: { ...validInput.totals, total: -10 },
    });

    expect(result).toStrictEqual({
      error: "Validation failed",
      success: false,
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects payloads with an empty merchant name", async () => {
    const result = await updateReceipt({
      ...validInput,
      merchant: { ...validInput.merchant, name: "" },
    });

    expect(result).toStrictEqual({
      error: "Validation failed",
      success: false,
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("accepts a negative line total as a discount", async () => {
    const result = await updateReceipt({
      ...validInput,
      items: [
        {
          categoryTouched: false,
          kind: "product",
          lineTotal: 10,
          name: "Groceries",
          quantity: 1,
        },
        {
          categoryTouched: false,
          kind: "discount",
          lineTotal: -2,
          name: "SPECIAL",
          quantity: 1,
        },
      ],
      totals: { gst: 0, subtotal: 8, total: 8 },
    });

    expect(result).toStrictEqual({ success: true });
  });

  it("negates a discount saved with a positive line total", async () => {
    await updateReceipt({
      ...validInput,
      items: [
        {
          categoryTouched: false,
          kind: "product",
          lineTotal: 10,
          name: "Groceries",
          quantity: 1,
        },
        {
          categoryTouched: false,
          kind: "discount",
          lineTotal: 2,
          name: "SPECIAL",
          quantity: 1,
        },
      ],
      totals: { gst: 0, subtotal: 8, total: 8 },
    });

    expect(mockInsertValues).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({
        kind: "product",
        lineTotal: 10,
        name: "Groceries",
        receiptId,
      }),
      expect.objectContaining({
        kind: "discount",
        lineTotal: -2,
        name: "SPECIAL",
        receiptId,
      }),
    ]);
  });

  it("keeps a product the user chose, even with a negative line total", async () => {
    await updateReceipt({
      ...validInput,
      items: [
        {
          categoryTouched: false,
          kind: "product",
          lineTotal: 10,
          name: "Groceries",
          quantity: 1,
        },
        {
          categoryTouched: false,
          kind: "product",
          lineTotal: -2,
          name: "RETURN",
          quantity: 1,
        },
      ],
      totals: { gst: 0, subtotal: 8, total: 8 },
    });

    expect(mockInsertValues).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({
        kind: "product",
        lineTotal: 10,
        name: "Groceries",
      }),
      expect.objectContaining({
        kind: "product",
        lineTotal: -2,
        name: "RETURN",
      }),
    ]);
  });

  it("stores no integrity warning when a positive discount makes the items sum to the total", async () => {
    await updateReceipt({
      ...validInput,
      items: [
        {
          categoryTouched: false,
          kind: "product",
          lineTotal: 10,
          name: "Groceries",
          quantity: 1,
        },
        {
          categoryTouched: false,
          kind: "discount",
          lineTotal: 2,
          name: "SPECIAL",
          quantity: 1,
        },
      ],
      totals: { gst: 0, subtotal: 8, total: 8 },
    });

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ hasIntegrityWarning: false })
    );
  });

  it("re-saves a stored discount, whose unit price is already negative", async () => {
    const result = await updateReceipt({
      ...validInput,
      items: [
        {
          categoryTouched: false,
          kind: "product",
          lineTotal: 10,
          name: "Groceries",
          quantity: 1,
        },
        {
          categoryTouched: false,
          kind: "discount",
          lineTotal: -2,
          name: "SPECIAL",
          quantity: 2,
          unitPrice: -1,
        },
      ],
      totals: { gst: 0, subtotal: 8, total: 8 },
    });

    expect(result).toStrictEqual({ success: true });
  });

  it("negates a discount's unit price when saving", async () => {
    await updateReceipt({
      ...validInput,
      items: [
        {
          categoryTouched: false,
          kind: "product",
          lineTotal: 10,
          name: "Groceries",
          quantity: 1,
        },
        {
          categoryTouched: false,
          kind: "discount",
          lineTotal: 2,
          name: "SPECIAL",
          quantity: 2,
          unitPrice: 1,
        },
      ],
      totals: { gst: 0, subtotal: 8, total: 8 },
    });

    expect(mockInsertValues).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({
        kind: "product",
        lineTotal: 10,
        name: "Groceries",
      }),
      expect.objectContaining({
        kind: "discount",
        lineTotal: -2,
        name: "SPECIAL",
        unitPrice: -1,
      }),
    ]);
  });

  it("negates a discount edited in place, on the update path", async () => {
    // The save plans updates against existing rows rather than reinserting, so
    // a discount the user corrects is written through `plan.updates` — a
    // different path from the insert one the coercion tests above cover.
    mockFindFirst.mockResolvedValue({
      receiptItems: [{ categoryId: null, categorySource: "ai", id: itemOneId }],
      status: "done",
    });

    await updateReceipt({
      ...validInput,
      items: [
        {
          categoryTouched: false,
          itemId: itemOneId,
          kind: "discount",
          lineTotal: 2,
          name: "SPECIAL",
          quantity: 2,
          unitPrice: 1,
        },
      ],
      totals: { gst: 0, subtotal: 0, total: 0 },
    });

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ lineTotal: -2, unitPrice: -1 })
    );
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("never lets a submitted itemId decide which row it writes to", async () => {
    // An id that is not among the receipt's own items must be treated as a new
    // row, never as an update against a line item on another receipt.
    mockFindFirst.mockResolvedValue({
      receiptItems: [{ categoryId: null, categorySource: "ai", id: itemOneId }],
      status: "done",
    });

    await updateReceipt({
      ...validInput,
      items: [
        {
          categoryTouched: false,
          itemId: otherReceiptsItemId,
          kind: "product",
          lineTotal: 10,
          name: "Milk",
        },
      ],
    });

    expect(mockInsertValues).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({
        categoryId: null,
        categorySource: "ai",
        name: "Milk",
        receiptId,
      }),
    ]);
    expect(JSON.stringify(mockSetWhere.mock.calls)).not.toContain(
      otherReceiptsItemId
    );
  });

  it("round-trips each line's kind through the save path", async () => {
    const items: UpdateReceiptInput["items"] = [
      {
        categoryTouched: false,
        kind: "surcharge",
        lineTotal: 0.37,
        name: "CREDIT SURCHARGE",
        quantity: 1,
      },
      {
        categoryTouched: false,
        kind: "discount",
        lineTotal: -2,
        name: "SPECIAL",
        quantity: 1,
      },
      {
        categoryTouched: false,
        kind: "product",
        lineTotal: 12,
        name: "Milk",
        quantity: 2,
      },
    ];

    await updateReceipt({
      ...validInput,
      items,
      totals: { gst: 0, subtotal: 10.37, total: 10.37 },
    });

    // `categoryTouched` is a signal about intent, not a column, so it never
    // reaches the insert.
    expect(mockInsertValues).toHaveBeenCalledExactlyOnceWith(
      items.map(({ categoryTouched: _touched, ...item }) => ({
        ...item,
        categoryId: null,
        categorySource: "ai",
        receiptId,
      }))
    );
  });

  it("rejects payloads with a non-enum payment method", async () => {
    const result = await updateReceipt({
      ...validInput,
      payment: { method: "VISA" },
    } as unknown as UpdateReceiptInput);

    expect(result).toStrictEqual({
      error: "Validation failed",
      success: false,
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects payloads with an invalid receipt id", async () => {
    const result = await updateReceipt({
      ...validInput,
      receiptId: "not-a-uuid",
    });

    expect(result).toStrictEqual({
      error: "Validation failed",
      success: false,
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects payloads missing the required totals.total", async () => {
    const result = await updateReceipt({
      ...validInput,
      totals: { subtotal: 15.5 },
    } as UpdateReceiptInput);

    expect(result).toStrictEqual({
      error: "Validation failed",
      success: false,
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("updates the receipt and its items in one transaction", async () => {
    const result = await updateReceipt(validInput);

    expect(result).toStrictEqual({ success: true });
    expect(mockTransaction).toHaveBeenCalledOnce();
    expect(mockUpdate).toHaveBeenCalledOnce();
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        gst: 1.5,
        merchantAddress: "1 Main St",
        merchantName: "Coles",
        merchantStoreId: "1234",
        paymentMethod: "card",
        receiptNumber: "R-123",
        subtotal: 15.5,
        total: 15.5,
      })
    );
  });

  it("inserts the new items array into the receipt items table", async () => {
    await updateReceipt(validInput);

    expect(mockInsert).toHaveBeenCalledOnce();
    expect(mockInsertValues).toHaveBeenCalledExactlyOnceWith(
      validInput.items.map(({ categoryTouched: _touched, ...item }) => ({
        ...item,
        categoryId: null,
        categorySource: "ai",
        receiptId,
      }))
    );
  });

  it("updates stored items in place instead of deleting them", async () => {
    mockFindFirst.mockResolvedValue({
      receiptItems: [
        { categoryId: dairyId, categorySource: "ai", id: itemOneId },
        { categoryId: null, categorySource: "ai", id: itemTwoId },
      ],
      status: "done",
    });

    await updateReceipt({
      ...validInput,
      items: [
        {
          categoryId: dairyId,
          categoryTouched: false,
          itemId: itemOneId,
          kind: "product",
          lineTotal: 10,
          name: "Milk",
        },
        {
          categoryTouched: false,
          itemId: itemTwoId,
          kind: "product",
          lineTotal: 5.5,
          name: "Bread",
        },
      ],
    });

    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    // No category columns: the user did not touch them, so the stored ones
    // stand.
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Milk" })
    );
    expect(mockSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: expect.anything() })
    );
  });

  it("deletes only the stored items the user removed", async () => {
    mockFindFirst.mockResolvedValue({
      receiptItems: [
        { categoryId: null, categorySource: "ai", id: itemOneId },
        { categoryId: null, categorySource: "ai", id: itemTwoId },
      ],
      status: "done",
    });

    await updateReceipt({
      ...validInput,
      items: [
        {
          categoryTouched: false,
          itemId: itemOneId,
          kind: "product",
          lineTotal: 10,
          name: "Milk",
        },
      ],
    });

    expect(mockDelete).toHaveBeenCalledOnce();
    expect(JSON.stringify(mockDeleteWhere.mock.calls)).toContain(itemTwoId);
    expect(JSON.stringify(mockDeleteWhere.mock.calls)).not.toContain(itemOneId);
  });

  it("stores a user-set category as the user's decision", async () => {
    mockFindFirst.mockResolvedValue({
      receiptItems: [
        { categoryId: dairyId, categorySource: "ai", id: itemOneId },
      ],
      status: "done",
    });

    await updateReceipt({
      ...validInput,
      items: [
        {
          categoryId: otherId,
          categoryTouched: true,
          itemId: itemOneId,
          kind: "product",
          lineTotal: 10,
          name: "Milk",
        },
      ],
    });

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        categoryId: otherId,
        categorySource: "user",
      })
    );
  });

  it("keeps a user-set category when other fields change", async () => {
    mockFindFirst.mockResolvedValue({
      receiptItems: [
        { categoryId: dairyId, categorySource: "user", id: itemOneId },
      ],
      status: "done",
    });

    await updateReceipt({
      ...validInput,
      items: [
        {
          categoryId: dairyId,
          categoryTouched: false,
          itemId: itemOneId,
          kind: "product",
          lineTotal: 10,
          name: "Whole Milk",
        },
      ],
    });

    // Untouched, so the update carries no category columns and the stored
    // `user` decision stands.
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Whole Milk" })
    );
    expect(mockSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ categorySource: expect.anything() })
    );
  });

  it("keeps an ai category when the user changes only the name", async () => {
    mockFindFirst.mockResolvedValue({
      receiptItems: [
        { categoryId: dairyId, categorySource: "ai", id: itemOneId },
      ],
      status: "done",
    });

    await updateReceipt({
      ...validInput,
      items: [
        {
          categoryId: dairyId,
          categoryTouched: false,
          itemId: itemOneId,
          kind: "product",
          lineTotal: 10,
          name: "Whole Milk",
        },
      ],
    });

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Whole Milk" })
    );
    expect(mockSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ categorySource: expect.anything() })
    );
  });

  it("rejects a category that is not in the taxonomy", async () => {
    const result = await updateReceipt({
      ...validInput,
      items: [
        {
          categoryId: "123e4567-e89b-12d3-a456-426614174099",
          categoryTouched: true,
          kind: "product",
          lineTotal: 10,
          name: "Milk",
        },
      ],
    });

    expect(result).toStrictEqual({
      error: "Validation failed",
      success: false,
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("accepts clearing a category, which is a user decision", async () => {
    mockFindFirst.mockResolvedValue({
      receiptItems: [
        { categoryId: dairyId, categorySource: "user", id: itemOneId },
      ],
      status: "done",
    });

    const result = await updateReceipt({
      ...validInput,
      items: [
        {
          categoryId: null,
          categoryTouched: true,
          itemId: itemOneId,
          kind: "product",
          lineTotal: 10,
          name: "Milk",
        },
      ],
    });

    expect(result).toStrictEqual({ success: true });
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: null, categorySource: "user" })
    );
  });

  it("does not let a categorization run be undone by an unrelated save", async () => {
    // The form was loaded while this item was uncategorised. Categorization
    // then filled it in, and the user saved having touched only the name. The
    // stale form value must not be written back as a user clear.
    mockFindFirst.mockResolvedValue({
      receiptItems: [
        { categoryId: dairyId, categorySource: "ai", id: itemOneId },
      ],
      status: "done",
    });

    await updateReceipt({
      ...validInput,
      items: [
        {
          categoryId: null,
          categoryTouched: false,
          itemId: itemOneId,
          kind: "product",
          lineTotal: 10,
          name: "Whole Milk",
        },
      ],
    });

    expect(mockSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: null })
    );
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Whole Milk" })
    );
  });

  it("rejects a line item id that is not a uuid", async () => {
    const result = await updateReceipt({
      ...validInput,
      items: [
        { itemId: "not-a-uuid", kind: "product", lineTotal: 10, name: "Milk" },
      ],
    } as UpdateReceiptInput);

    expect(result).toStrictEqual({
      error: "Validation failed",
      success: false,
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("syncs the transactionDateTime from the transaction datetime string", async () => {
    await updateReceipt(validInput);

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionDateTime: "2026-01-01 10:00:00",
      })
    );
  });

  it("skips the item insert when there are no items", async () => {
    const result = await updateReceipt({
      ...validInput,
      items: [],
      totals: { gst: 0, subtotal: 0, total: 0 },
    });

    expect(result).toStrictEqual({ success: true });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("stores a computed integrity warning when items do not sum to the total", async () => {
    await updateReceipt({
      ...validInput,
      items: [
        {
          categoryTouched: false,
          kind: "product",
          lineTotal: 10,
          name: "Milk",
          quantity: 1,
          unitPrice: 10,
        },
      ],
      totals: { gst: 0, subtotal: 10, total: 20 },
    });

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ hasIntegrityWarning: true })
    );
  });

  it("stores no integrity warning when items sum to the total", async () => {
    await updateReceipt(validInput);

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ hasIntegrityWarning: false })
    );
  });

  it("returns an error when the database transaction fails", async () => {
    mockSetWhere.mockRejectedValueOnce(new Error("connection refused"));

    const result = await updateReceipt(validInput);

    expect(result).toStrictEqual({
      error: "Failed to save receipt",
      success: false,
    });
  });

  it("clears the transactionDateTime when the datetime field is empty", async () => {
    await updateReceipt({
      ...validInput,
      transaction: {
        ...validInput.transaction,
        datetime: undefined,
      },
    });

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ transactionDateTime: null })
    );
  });

  it("rejects updates to a receipt that is not in done status", async () => {
    mockFindFirst.mockResolvedValueOnce({
      receiptItems: [],
      status: "processing",
    });

    const result = await updateReceipt(validInput);

    expect(result).toStrictEqual({
      error: "Receipt is not editable",
      success: false,
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects updates to a receipt that does not exist", async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    const result = await updateReceipt(validInput);

    expect(result).toStrictEqual({
      error: "Receipt is not editable",
      success: false,
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests without looking up or mutating", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const result = await updateReceipt(validInput);

    expect(result).toStrictEqual({
      error: USER_ERROR.unauthorized,
      success: false,
    });
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("returns not-found semantics for another user's receipt without mutating", async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    const result = await updateReceipt(validInput);

    expect(result).toStrictEqual({
      error: "Receipt is not editable",
      success: false,
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockSetWhere).not.toHaveBeenCalled();
  });

  it("scopes the ownership lookup to the session user", async () => {
    await updateReceipt(validInput);

    expect(mockFindFirst).toHaveBeenCalledExactlyOnceWith({
      where: { id: receiptId, userId: "user-1" },
      with: { receiptItems: true },
    });
  });

  it("revalidates the receipt path after a successful save", async () => {
    await updateReceipt(validInput);

    expect(mockRevalidatePath).toHaveBeenCalledExactlyOnceWith(
      `/receipts/${receiptId}`
    );
  });
});
