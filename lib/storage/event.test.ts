import { describe, it, expect } from "vitest";

import { storageEventSchema } from "./event";

// Captured from staging: RustFS percent-encodes the object key in the payload
// (slashes become %2F), so the schema must decode it back before lookup.
const encodedKey =
  "users%2FscOggddDQHY3HYGOJSYtPAEsjzD5Lkft%2Feed199a9-f8c8-41bc-aff6-2d544eda88f5.png";
const decodedKey =
  "users/scOggddDQHY3HYGOJSYtPAEsjzD5Lkft/eed199a9-f8c8-41bc-aff6-2d544eda88f5.png";

// Captured verbatim from RustFS 1.0.0-rc.6
// (sha256:97171b3d…f6035) delivering a PutObject event to a webhook.
const rustFsBody = {
  EventName: "s3:ObjectCreated:Put",
  Key: `receipts/${encodedKey}`,
  Records: [
    {
      awsRegion: "",
      eventName: "s3:ObjectCreated:Put",
      eventSource: "rustfs:s3",
      eventTime: "2026-09-15T02:57:20.191Z",
      eventVersion: "2.1",
      requestParameters: {
        accept: "*/*",
        "accept-encoding": "gzip, deflate",
        "accept-language": "*",
        connection: "keep-alive",
        "content-length": "6",
        "content-type": "image/jpeg",
        host: "localhost:19000",
        origin: "http://localhost:3000",
        principalId: "rustfsadmin",
        "sec-fetch-mode": "cors",
        "user-agent": "node",
        "x-request-id": "d590347b-c393-4574-98c8-9dc7be7a8053",
      },
      responseElements: {
        "x-amz-id-2": "",
        "x-amz-request-id": "d590347b-c393-4574-98c8-9dc7be7a8053",
      },
      s3: {
        bucket: {
          arn: "arn:aws:s3:::receipts",
          name: "receipts",
          ownerIdentity: { principalId: "rustfsadmin" },
        },
        configurationId: "Config",
        object: {
          contentType: "image/jpeg",
          eTag: "86de41916cffa4d8fbab89629cef063f",
          key: encodedKey,
          sequencer: "18D55F252B06B1FA",
          size: 6,
          userMetadata: { "content-type": "image/jpeg" },
        },
        s3SchemaVersion: "1.0",
      },
      source: { host: "localhost:19000", port: "19000", userAgent: "node" },
      userIdentity: { principalId: "rustfsadmin" },
    },
  ],
};

const rustfsNotification = (key: string, eventName: string) => ({
  Records: [
    {
      eventName,
      eventSource: "rustfs:s3",
      s3: { object: { key } },
    },
  ],
});

describe("storage event schema", () => {
  describe("a RustFS bucket notification", () => {
    it("turns the captured upload notification into a storage event", () => {
      const result = storageEventSchema.safeParse(rustFsBody);

      expect(result.success).toBeTruthy();
      expect(result.data).toStrictEqual({ objectKey: decodedKey });
    });

    it("leaves an unencoded object key unchanged and ignores MinIO-only fields", () => {
      // The RustFS envelope really is just S3's event shape: only the object
      // key of the first record is read, so no other field has to be present.
      const result = storageEventSchema.safeParse(
        rustfsNotification("abc.jpg", "s3:ObjectCreated:Put")
      );

      expect(result.success).toBeTruthy();
      expect(result.data).toStrictEqual({ objectKey: "abc.jpg" });
    });

    it("ignores a removal notification as not an upload", () => {
      const result = storageEventSchema.safeParse(
        rustfsNotification(encodedKey, "s3:ObjectRemoved:Delete")
      );

      expect(result.success).toBeTruthy();
      expect(result.data).toBeNull();
    });

    it("treats a copy as an upload, as the bucket rule does", () => {
      // RustFS registers `--event put`, which is `s3:ObjectCreated:*`, so a copy
      // notification is an object-created event and counts.
      const result = storageEventSchema.safeParse(
        rustfsNotification(encodedKey, "s3:ObjectCreated:Copy")
      );

      expect(result.success).toBeTruthy();
      expect(result.data).toStrictEqual({ objectKey: decodedKey });
    });

    it("does not decode a key that is not valid percent-encoding", () => {
      const result = storageEventSchema.safeParse(
        rustfsNotification("users/user-1/100%.png", "s3:ObjectCreated:Put")
      );

      expect(result.success).toBeTruthy();
      expect(result.data).toStrictEqual({ objectKey: "users/user-1/100%.png" });
    });

    it("returns failure for empty body", () => {
      expect(storageEventSchema.safeParse({}).success).toBeFalsy();
    });

    it("returns failure when Records is missing", () => {
      expect(
        storageEventSchema.safeParse({ EventName: "s3:ObjectCreated:Put" })
          .success
      ).toBeFalsy();
    });

    it("returns failure when Records is empty", () => {
      expect(storageEventSchema.safeParse({ Records: [] }).success).toBeFalsy();
    });

    it("returns failure when the object key is missing", () => {
      expect(
        storageEventSchema.safeParse({ Records: [{ s3: {} }] }).success
      ).toBeFalsy();
    });

    it("returns failure for a payload in a shape it does not know", () => {
      // R2 never posts a payload to the app (ADR-0021), so its Queue message
      // shape is not an adapter and must not be mistaken for a notification.
      expect(
        storageEventSchema.safeParse({
          action: "PutObject",
          object: { key: "users/user-1/receipt.png" },
        }).success
      ).toBeFalsy();
      expect(
        storageEventSchema.safeParse({
          events: [{ object: { key: "x" } }],
        }).success
      ).toBeFalsy();
    });

    it("returns failure for null body", () => {
      expect(storageEventSchema.safeParse(null).success).toBeFalsy();
    });

    it("returns failure for string body", () => {
      expect(storageEventSchema.safeParse("not an object").success).toBeFalsy();
    });
  });
});
