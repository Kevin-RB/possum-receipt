import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { objectExists, presignEndpointForHost, s3Client } from "./client";

describe(presignEndpointForHost, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("derives the storage host from the request host in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(presignEndpointForHost("kevin:3000")).toBe("kevin:9000");
    expect(presignEndpointForHost("localhost:3000")).toBe("localhost:9000");
  });

  it("falls back to the configured endpoint without a request host", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(presignEndpointForHost(null)).toBe("localhost:9000");
  });

  it("keeps the configured endpoint outside development", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(presignEndpointForHost("kevin:3000")).toBe("localhost:9000");
  });
});

describe(objectExists, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is true when the object store answers the HEAD", async () => {
    const send = vi.spyOn(s3Client, "send").mockResolvedValue({} as never);

    await expect(
      objectExists({ bucket: "receipts", key: "users/user-1/a.png" })
    ).resolves.toBeTruthy();
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
  });

  it.each([
    [
      "a 404",
      Object.assign(new Error("NotFound"), {
        $metadata: { httpStatusCode: 404 },
      }),
    ],
    [
      "an SDK NotFound",
      Object.assign(new Error("NotFound"), { name: "NotFound" }),
    ],
    [
      "a NoSuchKey code",
      Object.assign(new Error("NoSuchKey"), { Code: "NoSuchKey" }),
    ],
  ])("is false for %s", async (_label, error) => {
    vi.spyOn(s3Client, "send").mockRejectedValue(error);

    await expect(
      objectExists({ bucket: "receipts", key: "users/user-1/a.png" })
    ).resolves.toBeFalsy();
  });

  it.each([
    [
      "a 403 from a misconfigured token",
      Object.assign(new Error("Forbidden"), {
        $metadata: { httpStatusCode: 403 },
      }),
    ],
    ["a network failure", new Error("socket hang up")],
  ])(
    "rethrows %s rather than calling the object absent",
    async (_label, error) => {
      vi.spyOn(s3Client, "send").mockRejectedValue(error);

      await expect(
        objectExists({ bucket: "receipts", key: "users/user-1/a.png" })
      ).rejects.toBe(error);
    }
  );
});
