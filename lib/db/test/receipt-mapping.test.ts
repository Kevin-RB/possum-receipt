import { describe, expect, it } from "vitest";

import { receiptToFlat, receiptToNested } from "@/lib/db/receipt-mapping";
import { receiptNestedSchema } from "@/lib/db/schema/receipt";
import type { ReceiptNested, ReceiptSelect } from "@/lib/db/schema/receipt";

const dtypeReceipt = new Date("2026-06-15T04:32:00.000Z");

const flatReceipt: ReceiptSelect = {
  categorizedAt: null,
  createdAt: dtypeReceipt,
  gst: 1,
  hasIntegrityWarning: false,
  id: "123e4567-e89b-12d3-a456-426614174000",
  merchantAbn: "89 654 321 098",
  merchantAddress: "123 Smith St, Fitzroy VIC 3065",
  merchantName: "Coles",
  merchantStoreId: "0342",
  objectKey: "abc.jpg",
  paymentMethod: "card",
  processingStartedAt: dtypeReceipt,
  receiptNumber: "0342-0087-1234",
  status: "done",
  subtotal: 9.9,
  total: 10.9,
  transactionDateTime: "2026-06-15 14:32:00",
  transcript: null,
  userId: "user-1",
};

const nestedReceipt: ReceiptNested = {
  merchant: {
    abn: "89 654 321 098",
    address: "123 Smith St, Fitzroy VIC 3065",
    name: "Coles",
    storeId: "0342",
  },
  payment: { method: "card" },
  totals: { gst: 1, subtotal: 9.9, total: 10.9 },
  transaction: {
    datetime: "2026-06-15T14:32:00+10:00",
    receiptNumber: "0342-0087-1234",
  },
};

describe(receiptToNested, () => {
  it("reads flat columns into the nested receipt shape", () => {
    expect(receiptToNested(flatReceipt)).toStrictEqual({
      merchant: {
        abn: "89 654 321 098",
        address: "123 Smith St, Fitzroy VIC 3065",
        name: "Coles",
        storeId: "0342",
      },
      payment: { method: "card" },
      totals: { gst: 1, subtotal: 9.9, total: 10.9 },
      transaction: {
        datetime: "2026-06-15T14:32",
        receiptNumber: "0342-0087-1234",
      },
    });
  });

  it("falls back to 'other' when the payment method is missing or unrecognized", () => {
    expect(
      receiptToNested({ ...flatReceipt, paymentMethod: null })
    ).toMatchObject({ payment: { method: "other" } });
    expect(
      receiptToNested({
        ...flatReceipt,
        paymentMethod: "VISA",
      } as ReceiptSelect)
    ).toMatchObject({ payment: { method: "other" } });
  });

  it("omits the datetime when none is stored", () => {
    expect(
      receiptToNested({ ...flatReceipt, transactionDateTime: null }).transaction
        .datetime
    ).toBeUndefined();
  });

  it("omits optional fields when the flat columns are null", () => {
    const minimal: ReceiptSelect = {
      ...flatReceipt,
      gst: null,
      merchantAbn: null,
      merchantAddress: null,
      merchantStoreId: null,
      receiptNumber: null,
      subtotal: null,
      transactionDateTime: null,
    };
    expect(receiptToNested(minimal)).toStrictEqual({
      merchant: {
        abn: undefined,
        address: undefined,
        name: "Coles",
        storeId: undefined,
      },
      payment: { method: "card" },
      totals: { gst: undefined, subtotal: undefined, total: 10.9 },
      transaction: { datetime: undefined, receiptNumber: undefined },
    });
  });
});

describe(receiptToFlat, () => {
  it("maps the nested shape to flat columns pinned to the insert schema", () => {
    expect(receiptToFlat(nestedReceipt)).toStrictEqual({
      gst: 1,
      merchantAbn: "89 654 321 098",
      merchantAddress: "123 Smith St, Fitzroy VIC 3065",
      merchantName: "Coles",
      merchantStoreId: "0342",
      paymentMethod: "card",
      receiptNumber: "0342-0087-1234",
      subtotal: 9.9,
      total: 10.9,
      transactionDateTime: flatReceipt.transactionDateTime,
    });
  });

  it("clears the transaction datetime when none is provided", () => {
    const { datetime: _datetime, ...transaction } = nestedReceipt.transaction;
    expect(
      receiptToFlat({ ...nestedReceipt, transaction }).transactionDateTime
    ).toBeNull();
  });

  it("clears the transaction datetime when it cannot be parsed", () => {
    expect(
      receiptToFlat({
        ...nestedReceipt,
        transaction: {
          ...nestedReceipt.transaction,
          datetime: "28/07/2026 6:51pm",
        },
      }).transactionDateTime
    ).toBeNull();
  });

  it("nulls an absent optional rather than leaving it undefined", () => {
    // Drizzle drops `undefined` from an update, which would leave the stored
    // value in place instead of clearing it.
    const minimal: ReceiptNested = {
      merchant: { name: "Coles" },
      payment: { method: "card" },
      totals: { total: 10.9 },
      transaction: {},
    };

    expect(receiptToFlat(minimal)).toStrictEqual({
      gst: null,
      merchantAbn: null,
      merchantAddress: null,
      merchantName: "Coles",
      merchantStoreId: null,
      paymentMethod: "card",
      receiptNumber: null,
      subtotal: null,
      total: 10.9,
      transactionDateTime: null,
    });
  });

  it("round-trips a nested receipt through the flat columns", () => {
    expect(receiptToFlat(receiptToNested(flatReceipt))).toStrictEqual(
      receiptToFlat(nestedReceipt)
    );
  });
});

describe("receiptNestedSchema as the single bridge shape", () => {
  it("parses the nested write input", () => {
    expect(receiptNestedSchema.parse(nestedReceipt)).toStrictEqual(
      nestedReceipt
    );
  });
});
