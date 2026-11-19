import { describe, expect, it, vi, beforeEach } from "vitest";

const id = "123e4567-e89b-12d3-a456-426614174000";

const mockFindReceiptByIdForOwner = vi
  .fn<
    (
      id: string,
      ownerId: string
    ) => Promise<{ id: string; objectKey: string } | null>
  >()
  .mockResolvedValue({ id, objectKey: `${id}.jpg` });

const streamOf = (bytes: number[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });

const mockTransformToByteArray = vi.fn<() => Promise<Uint8Array>>();

const mockDownloadObject = vi.fn<
  () => Promise<{
    transformToByteArray: typeof mockTransformToByteArray;
    transformToWebStream: () => ReadableStream;
  }>
>();

// @ts-expect-error mock types don't need to match Drizzle internals
vi.mock(import("@/lib/db"), () => ({
  findReceiptByIdForOwner: mockFindReceiptByIdForOwner,
}));

const mockGetSession = vi.fn<() => Promise<{ user: { id: string } } | null>>();

// @ts-expect-error mock types don't need to match Better Auth internals
vi.mock(import("@/lib/auth"), () => ({
  auth: { api: { getSession: mockGetSession } },
}));

// @ts-expect-error mock types don't need to match storage internals
vi.mock(import("@/lib/storage/client"), () => ({
  BUCKET: "receipts",
  downloadObject: mockDownloadObject,
}));

vi.mock(import("@/lib/storage/content-type"), () => ({
  contentTypeFromKey: vi
    .fn<(key: string) => string>()
    .mockReturnValue("image/jpeg"),
}));

const { GET } = await import("./route");

const params = Promise.resolve({ id });

describe("GET /api/receipts/:id/image", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
    mockFindReceiptByIdForOwner.mockResolvedValue({
      id,
      objectKey: `${id}.jpg`,
    });
    mockTransformToByteArray.mockResolvedValue(new Uint8Array([1, 2, 3]));
    mockDownloadObject.mockResolvedValue({
      transformToByteArray: mockTransformToByteArray,
      transformToWebStream: () => streamOf([1, 2, 3]),
    });
  });

  it("rejects unauthenticated requests", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost/api/receipts"), {
      params,
    });

    expect(res.status).toBe(401);
    expect(mockDownloadObject).not.toHaveBeenCalled();
  });

  it("rejects requests for a receipt the user does not own", async () => {
    mockFindReceiptByIdForOwner.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost/api/receipts"), {
      params,
    });

    expect(res.status).toBe(404);
    expect(mockFindReceiptByIdForOwner).toHaveBeenCalledWith(id, "user-1");
    expect(mockDownloadObject).not.toHaveBeenCalled();
  });

  it("streams the image bytes to an authenticated owner", async () => {
    const res = await GET(new Request("http://localhost/api/receipts"), {
      params,
    });

    expect(res.status).toBe(200);
    const body = await res.arrayBuffer();
    expect(new Uint8Array(body)).toStrictEqual(new Uint8Array([1, 2, 3]));
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    // The bytes are user-uploaded, so the type must not be guessed.
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("hands the object on as a stream instead of buffering it", async () => {
    // Vercel's 4.5 MB response limit applies only to a buffered body, and a
    // phone photo can be larger. Reading the whole object into memory first is
    // the thing this route must not do.
    const res = await GET(new Request("http://localhost/api/receipts"), {
      params,
    });

    await expect(res.arrayBuffer()).resolves.toBeInstanceOf(ArrayBuffer);
    expect(mockTransformToByteArray).not.toHaveBeenCalled();
  });
});
