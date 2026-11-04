import { InngestTestEngine } from "@inngest/test";
import { beforeEach, describe, it, expect, vi } from "vitest";

import type { ReceiptInformationExtraction } from "@/lib/db/contract";

import { statusAfterFailedRun, transcribeReceipt } from "./transcribe-receipt";

const {
  mockDelete,
  mockDeleteWhere,
  mockFindReceiptByIdForOwner,
  mockInsert,
  mockInsertValues,
  mockParse,
  mockSet,
  mockTranscribe,
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

  const insertValues = vi
    .fn<(rows: unknown[]) => Promise<void>>()
    .mockResolvedValue();
  const insert = vi
    .fn<(table: unknown) => { values: typeof insertValues }>()
    .mockReturnValue({ values: insertValues });

  // Every write inside `storing` goes through the transaction handle, which
  // records its own calls so a test can assert the replace happened inside one.
  const tx = {
    delete: deleteTable,
    insert,
    update: updateTable,
  };
  const transaction = vi
    .fn<(fn: (t: typeof tx) => Promise<void>) => Promise<void>>()
    .mockImplementation(async (fn) => await fn(tx));

  return {
    mockDelete: deleteTable,
    mockDeleteWhere: deleteWhere,
    mockFindReceiptByIdForOwner:
      vi.fn<(id: string, ownerId: string) => Promise<unknown>>(),
    mockInsert: insert,
    mockInsertValues: insertValues,
    mockParse: vi
      .fn<(transcript: string, model?: string) => Promise<unknown>>()
      .mockResolvedValue({}),
    mockSet: setValue,
    mockTransaction: transaction,
    mockTranscribe: vi
      .fn<
        (base64: string, mimeType: string, model?: string) => Promise<string>
      >()
      .mockResolvedValue("FAKE OCR TRANSCRIPT"),
    mockUpdate: updateTable,
  };
});

// @ts-expect-error mock types don't match Drizzle internals
vi.mock(import("@/lib/db"), () => ({
  db: {
    delete: mockDelete,
    insert: mockInsert,
    transaction: mockTransaction,
    update: mockUpdate,
  },
  findReceiptByIdForOwner: mockFindReceiptByIdForOwner,
  receiptItems: {},
  receipts: {},
}));

// @ts-expect-error mock types don't match the AI module's own signatures
vi.mock(import("@/lib/ai/transcribe-receipt-image"), () => ({
  parseReceiptText: mockParse,
  transcribeReceiptImage: mockTranscribe,
}));

// Lets the `extracting` step run for real, which is the only way to observe
// which model the OCR call was given.
// @ts-expect-error mock types don't match the storage client
vi.mock(import("@/lib/storage/client"), () => ({
  BUCKET: "receipts",
  downloadObject: () =>
    Promise.resolve({ transformToString: () => Promise.resolve("BASE64") }),
}));

interface FunctionOutput {
  extraction: ReceiptInformationExtraction;
  integrityWarning: boolean;
  receiptId: string;
}

const mockExtraction: ReceiptInformationExtraction = {
  items: [
    { kind: "product", lineTotal: 4.5, name: "REG LATTE", quantity: 1 },
    { kind: "product", lineTotal: 12.9, name: "SRIRACHA CHICKEN", quantity: 1 },
  ],
  merchant: { name: "Test Cafe" },
  payment: { method: "card" },
  totals: { total: 17.4 },
  transaction: { datetime: "2025-01-15T10:30:00Z", receiptNumber: "ABC123" },
};

const mockPublish = vi.fn<() => Promise<void>>();

const mockSendEvent = vi.fn<() => Promise<void>>().mockResolvedValue();

/** A step stub: the value the step returns, replacing whatever it would do. */
interface StepStub {
  handler: () => unknown;
  id: string;
}

const baseSteps: StepStub[] = [
  {
    handler: () => ({
      id: "00000000-0000-0000-0000-000000000001",
      objectKey: "receipts/test.jpg",
      status: "pending",
    }),
    id: "lookup-receipt",
  },
  { handler: () => null, id: "mark-processing" },
  { handler: () => "FAKE OCR TRANSCRIPT", id: "extracting" },
  { handler: () => mockExtraction, id: "parsing" },
  { handler: () => null, id: "store-transcript" },
  { handler: () => null, id: "storing" },
];

const applyOverrides = (overrides?: Partial<StepStub>) =>
  overrides
    ? baseSteps.map((s) => (s.id === overrides.id ? { ...s, ...overrides } : s))
    : baseSteps;

const uploadedEvent = {
  data: {
    receiptId: "00000000-0000-0000-0000-000000000001",
    userId: "user-1",
  },
  name: "receipt/uploaded",
};

const reprocessEvent = {
  data: {
    models: { ocr: "big-vision", parse: "big-reasoner" },
    previousStatus: "done",
    receiptId: "00000000-0000-0000-0000-000000000001",
    userId: "user-1",
  },
  name: "receipt/reprocess",
};

const createEngine = (
  overrides?: Partial<StepStub>,
  realSteps: string[] = [],
  event: typeof uploadedEvent | typeof reprocessEvent = uploadedEvent
) =>
  new InngestTestEngine({
    events: [event],
    function: transcribeReceipt,
    steps: applyOverrides(overrides).filter((s) => !realSteps.includes(s.id)),
    transformCtx: (rawCtx) => {
      if (rawCtx.step && typeof rawCtx.step === "object") {
        const stepProxy = new Proxy(rawCtx.step, {
          get(target, prop) {
            if (prop === "realtime") {
              return { publish: mockPublish };
            }
            if (prop === "sendEvent") {
              return mockSendEvent;
            }
            return Reflect.get(target, prop, target);
          },
        });
        return { ...rawCtx, step: stepProxy as typeof rawCtx.step };
      }
      return rawCtx;
    },
  });

const reprocess = (overrides?: Partial<StepStub>, realSteps: string[] = []) =>
  createEngine(overrides, realSteps, reprocessEvent);

describe("transcribeReceipt function", () => {
  beforeEach(() => {
    mockDelete.mockClear();
    mockDeleteWhere.mockClear();
    mockInsert.mockClear();
    mockInsertValues.mockClear();
    mockParse.mockClear();
    mockFindReceiptByIdForOwner.mockClear();
    mockSet.mockClear();
    mockTransaction.mockClear();
    mockTranscribe.mockClear();
    mockUpdate.mockClear();
    mockSendEvent.mockClear();
  });

  it("runs extracting → parsing → storing and returns the extraction", async () => {
    const engine = createEngine();
    const { result } = await engine.execute();
    const output = result as FunctionOutput;

    expect(output).toBeDefined();
    expect(output.receiptId).toBe("00000000-0000-0000-0000-000000000001");
    expect(output.extraction).toStrictEqual(mockExtraction);
    expect(output.integrityWarning).toBeFalsy();
  });

  it("sets integrityWarning when line-sum mismatches total", async () => {
    const badExtraction: ReceiptInformationExtraction = {
      items: [{ kind: "product", lineTotal: 10, name: "Item 1", quantity: 1 }],
      merchant: { name: "Store" },
      payment: { method: "other" },
      totals: { total: 15 },
      transaction: {},
    };

    const engine = createEngine({
      handler: () => badExtraction,
      id: "parsing",
    });
    const { result } = await engine.execute();
    const output = result as FunctionOutput;

    expect(output.integrityWarning).toBeTruthy();
  });

  it("sets integrityWarning false when line sum matches total exactly", async () => {
    const exactExtraction: ReceiptInformationExtraction = {
      items: [
        { kind: "product", lineTotal: 5, name: "A", quantity: 1 },
        { kind: "product", lineTotal: 5, name: "B", quantity: 1 },
        { kind: "product", lineTotal: 0.01, name: "C", quantity: 1 },
      ],
      merchant: { name: "Store" },
      payment: { method: "other" },
      totals: { total: 10.01 },
      transaction: {},
    };

    const engine = createEngine({
      handler: () => exactExtraction,
      id: "parsing",
    });
    const { result } = await engine.execute();
    const output = result as FunctionOutput;

    expect(output.integrityWarning).toBeFalsy();
  });

  it("counts a card surcharge as a line that reconciles the total", async () => {
    const surchargeExtraction: ReceiptInformationExtraction = {
      items: [
        { kind: "product", lineTotal: 10, name: "Groceries", quantity: 1 },
        {
          kind: "surcharge",
          lineTotal: 0.37,
          name: "CREDIT SURCHARGE",
          quantity: 1,
        },
      ],
      merchant: { name: "ALDI" },
      payment: { method: "card" },
      totals: { subtotal: 10.37, total: 10.37 },
      transaction: {},
    };

    const engine = createEngine({
      handler: () => surchargeExtraction,
      id: "parsing",
    });
    const { result } = await engine.execute();
    const output = result as FunctionOutput;

    expect(output.integrityWarning).toBeFalsy();
    expect(output.extraction.items[1].kind).toBe("surcharge");
  });

  it("forces a negative line total to a discount regardless of model output", async () => {
    const discounted = {
      items: [
        { kind: "product", lineTotal: 10, name: "Groceries", quantity: 1 },
        { kind: "product", lineTotal: -2, name: "SPECIAL", quantity: 1 },
      ],
      merchant: { name: "Coles" },
      payment: { method: "card" },
      totals: { total: 8 },
      transaction: {},
    } as unknown as ReceiptInformationExtraction;

    const engine = createEngine({
      handler: () => discounted,
      id: "parsing",
    });
    const { result } = await engine.execute();
    const output = result as FunctionOutput;

    expect(output.extraction.items[1].kind).toBe("discount");
    expect(output.integrityWarning).toBeFalsy();
  });

  it("negates a discount the model reported as positive", async () => {
    const positiveDiscount = {
      items: [
        { kind: "product", lineTotal: 10, name: "Groceries", quantity: 1 },
        { kind: "discount", lineTotal: 2, name: "SPECIAL", quantity: 1 },
      ],
      merchant: { name: "Coles" },
      payment: { method: "card" },
      totals: { total: 8 },
      transaction: {},
    } as unknown as ReceiptInformationExtraction;

    const engine = createEngine({
      handler: () => positiveDiscount,
      id: "parsing",
    });
    const { result } = await engine.execute();
    const output = result as FunctionOutput;

    expect(output.extraction.items[1].kind).toBe("discount");
    expect(output.extraction.items[1].lineTotal).toBe(-2);
    expect(output.integrityWarning).toBeFalsy();
  });

  it("defaults a missing kind and quantity on an extracted line", async () => {
    const sparse = {
      items: [{ lineTotal: 10, name: "Product" }],
      merchant: { name: "Store" },
      payment: { method: "other" },
      totals: { total: 10 },
      transaction: {},
    } as unknown as ReceiptInformationExtraction;

    const engine = createEngine({ handler: () => sparse, id: "parsing" });
    const { result } = await engine.execute();
    const output = result as FunctionOutput;

    expect(output.extraction.items[0].kind).toBe("product");
    expect(output.extraction.items[0].quantity).toBe(1);
    expect(output.integrityWarning).toBeFalsy();
  });

  it("coerces a null quantity to one", async () => {
    const nullQuantity = {
      items: [
        { kind: "product", lineTotal: 10, name: "Product", quantity: null },
      ],
      merchant: { name: "Store" },
      payment: { method: "other" },
      totals: { total: 10 },
      transaction: {},
    } as unknown as ReceiptInformationExtraction;

    const engine = createEngine({ handler: () => nullQuantity, id: "parsing" });
    const { result } = await engine.execute();
    const output = result as FunctionOutput;

    expect(output.extraction.items[0].quantity).toBe(1);
  });

  it("leaves unprinted unit price, subtotal and gst absent", async () => {
    const sparse = {
      items: [{ lineTotal: 10, name: "Product" }],
      merchant: { name: "Store" },
      payment: { method: "other" },
      totals: { total: 10 },
      transaction: {},
    } as unknown as ReceiptInformationExtraction;

    const engine = createEngine({ handler: () => sparse, id: "parsing" });
    const { result } = await engine.execute();
    const output = result as FunctionOutput;

    expect(output.extraction.items[0].unitPrice).toBeUndefined();
    expect(output.extraction.totals.subtotal).toBeUndefined();
    expect(output.extraction.totals.gst).toBeUndefined();
  });

  it("completes without integrity warning when subtotal and gst are present", async () => {
    const fullExtraction: ReceiptInformationExtraction = {
      items: [{ kind: "product", lineTotal: 10, name: "Product", quantity: 1 }],
      merchant: { abn: "12345678901", name: "Full Store" },
      payment: { method: "card" },
      totals: { gst: 0.91, subtotal: 10, total: 10 },
      transaction: {
        datetime: "2025-06-01T12:00:00Z",
        receiptNumber: "RCPT-001",
      },
    };

    const engine = createEngine({
      handler: () => fullExtraction,
      id: "parsing",
    });
    const { result } = await engine.execute();
    const output = result as FunctionOutput;

    expect(output.integrityWarning).toBeFalsy();
    expect(output.extraction.totals.subtotal).toBe(10);
    expect(output.extraction.totals.gst).toBe(0.91);
  });

  it("runs the full function successfully", async () => {
    const engine = createEngine();
    const { result, error } = await engine.execute();
    const output = result as FunctionOutput;

    expect(error).toBeUndefined();
    expect(output.receiptId).toBeDefined();
    expect(output.extraction.items).toHaveLength(2);
    expect(output.extraction.merchant.name).toBe("Test Cafe");
  });

  it("stores the OCR transcript as soon as it is produced", async () => {
    const engine = createEngine(undefined, ["store-transcript"]);
    await engine.execute();

    expect(mockSet).toHaveBeenCalledWith({ transcript: "FAKE OCR TRANSCRIPT" });
  });

  it("keeps the OCR transcript of a first extraction when parsing fails", async () => {
    // ADR-0008: there is nothing else on the row, so the OCR text is the only
    // evidence of what the image said. A re-process has the opposite case — a
    // transcript that matches data still stored — and defers its write.
    const engine = createEngine(
      {
        handler: () => {
          throw new Error("parse blew up");
        },
        id: "parsing",
      },
      ["store-transcript"]
    );

    await engine.execute().catch(() => {});

    expect(mockSet).toHaveBeenCalledWith({ transcript: "FAKE OCR TRANSCRIPT" });
  });

  it("refuses a receipt that does not belong to the event's user", async () => {
    // The event carries a userId; if the run trusted the receiptId alone, anyone
    // able to send an event could name someone else's receipt and have its line
    // items deleted and its extraction overwritten.
    mockFindReceiptByIdForOwner.mockResolvedValueOnce(null);

    const { error } = await createEngine(undefined, [
      "lookup-receipt",
    ]).execute();

    expect(error).toBeDefined();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("looks the receipt up scoped to the event's user", async () => {
    mockFindReceiptByIdForOwner.mockResolvedValueOnce({
      id: "00000000-0000-0000-0000-000000000001",
      objectKey: "receipts/test.jpg",
      status: "pending",
    });

    await createEngine(undefined, ["lookup-receipt"]).execute();

    expect(mockFindReceiptByIdForOwner).toHaveBeenCalledWith(
      "00000000-0000-0000-0000-000000000001",
      "user-1"
    );
  });

  it("emits receipt/extracted once the receipt is stored", async () => {
    const engine = createEngine();
    await engine.execute();

    expect(mockSendEvent).toHaveBeenCalledWith(
      "emit-extracted",
      expect.objectContaining({
        data: {
          receiptId: "00000000-0000-0000-0000-000000000001",
          userId: "user-1",
        },
        name: "receipt/extracted",
      })
    );
  });

  it("runs the configured models when the receipt was just uploaded", async () => {
    mockParse.mockResolvedValueOnce(mockExtraction);

    await createEngine(undefined, ["extracting", "parsing"]).execute();

    // `undefined` rather than a model id: leaving the argument off is what
    // hands the call its environment default.
    expect(mockTranscribe).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      undefined
    );
    expect(mockParse).toHaveBeenCalledWith("FAKE OCR TRANSCRIPT", undefined);
  });

  describe("re-processing", () => {
    it("uses the models the run was started with", async () => {
      mockParse.mockResolvedValueOnce(mockExtraction);

      await reprocess(undefined, ["extracting", "parsing"]).execute();

      expect(mockTranscribe).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        "big-vision"
      );
      expect(mockParse).toHaveBeenCalledWith(
        "FAKE OCR TRANSCRIPT",
        "big-reasoner"
      );
    });

    it("accepts a receipt the trigger already moved to processing", async () => {
      const engine = reprocess({
        handler: () => ({
          id: "00000000-0000-0000-0000-000000000001",
          objectKey: "receipts/test.jpg",
          status: "processing" as const,
        }),
        id: "lookup-receipt",
      });

      const { error, result } = await engine.execute();

      expect(error).toBeUndefined();
      expect((result as FunctionOutput).receiptId).toBe(
        "00000000-0000-0000-0000-000000000001"
      );
    });

    it("replaces the stored line items rather than adding to them", async () => {
      await reprocess(undefined, ["storing"]).execute();

      expect(mockDeleteWhere).toHaveBeenCalledOnce();
      expect(mockInsertValues).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({ name: "REG LATTE" }),
        expect.objectContaining({ name: "SRIRACHA CHICKEN" }),
      ]);
    });

    it("writes the receipt and its line items in one transaction", async () => {
      await reprocess(undefined, ["storing"]).execute();

      expect(mockTransaction).toHaveBeenCalledOnce();
    });

    it("clears the categorization stamp the replaced items no longer justify", async () => {
      await reprocess(undefined, ["storing"]).execute();

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ categorizedAt: null })
      );
    });

    it("writes the transcript with the extraction it belongs to", async () => {
      await reprocess(undefined, ["storing"]).execute();

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ transcript: "FAKE OCR TRANSCRIPT" })
      );
    });

    it("leaves the stored transcript alone until the new extraction is stored", async () => {
      // The transcript on the row describes the extraction on the row. Writing
      // the new one early and then failing would leave a receipt that reads as
      // `done`, with the previous extraction and a transcript that produced
      // nothing.
      await reprocess(undefined, ["store-transcript", "storing"]).execute();

      expect(mockSet).not.toHaveBeenCalledWith({
        transcript: "FAKE OCR TRANSCRIPT",
      });
    });

    it("nulls every flat field so an omitted one is cleared, not kept", async () => {
      // `receiptToFlat` must null rather than leave undefined, because Drizzle
      // drops undefined from an update — which would keep the previous bad
      // extraction's value for anything the new parse omitted.
      const sparse = {
        items: [
          { kind: "product", lineTotal: 10, name: "Product", quantity: 1 },
        ],
        merchant: { name: "Store" },
        payment: { method: "other" },
        totals: { total: 10 },
        transaction: {},
      } as unknown as ReceiptInformationExtraction;

      await reprocess({ handler: () => sparse, id: "parsing" }, [
        "storing",
      ]).execute();

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          gst: null,
          merchantAbn: null,
          receiptNumber: null,
          subtotal: null,
        })
      );
    });

    it("categorizes the new items", async () => {
      await reprocess().execute();

      expect(mockSendEvent).toHaveBeenCalledWith(
        "emit-extracted",
        expect.objectContaining({
          data: {
            receiptId: "00000000-0000-0000-0000-000000000001",
            userId: "user-1",
          },
          name: "receipt/extracted",
        })
      );
    });
  });

  describe("after a failed run", () => {
    const processing = { status: "processing" as const };

    it("restores the status a re-process started from", () => {
      expect(statusAfterFailedRun(processing, "done")).toBe("done");
    });

    it("leaves a receipt that was already failed failed", () => {
      expect(statusAfterFailedRun(processing, "error")).toBe("error");
    });

    it("marks a first extraction as failed, having nothing to fall back to", () => {
      expect(statusAfterFailedRun(processing)).toBe("error");
    });

    it("writes nothing for a receipt the event's user does not own", () => {
      // A scoped lookup returning null means the event named someone else's
      // receipt. Falling through here is how the ownership gate gets bypassed:
      // the run reports a failure against a row it never proved it may touch.
      expect(statusAfterFailedRun(null, "done")).toBeNull();
    });

    it("writes nothing once the store has committed", () => {
      expect(statusAfterFailedRun({ status: "done" }, "error")).toBeNull();
    });
  });
});
