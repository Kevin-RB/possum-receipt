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

// Follows Cloudflare's documented R2 Queue message rather than a captured one:
// https://developers.cloudflare.com/r2/buckets/event-notifications/
const r2Body = (
  action: string,
  key: string,
  object: Record<string, unknown> = {}
) => ({
  account: "3f4b7e3dcab231cbfdaa90a6a28bd548",
  action,
  bucket: "my-bucket",
  eventTime: "2024-05-24T19:36:44.379Z",
  object: {
    eTag: "c846ff7a18f28c2e262116d6e8719ef0",
    key,
    size: 65_536,
    ...object,
  },
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
  });

  describe("an R2 message", () => {
    it("turns a PutObject message into a storage event", () => {
      const result = storageEventSchema.safeParse(
        r2Body("PutObject", "users/user-1/receipt.png")
      );

      expect(result.success).toBeTruthy();
      expect(result.data).toStrictEqual({
        objectKey: "users/user-1/receipt.png",
      });
    });

    it("turns a CompleteMultipartUpload message into a storage event", () => {
      const result = storageEventSchema.safeParse(
        r2Body("CompleteMultipartUpload", "users/user-1/receipt.png")
      );

      expect(result.success).toBeTruthy();
      expect(result.data).toStrictEqual({
        objectKey: "users/user-1/receipt.png",
      });
    });

    it("does not decode the object key, which R2 sends as is", () => {
      const result = storageEventSchema.safeParse(
        r2Body("PutObject", "users/user-1/a%20b.png")
      );

      expect(result.success).toBeTruthy();
      expect(result.data).toStrictEqual({
        objectKey: "users/user-1/a%20b.png",
      });
    });

    it("ignores a DeleteObject message as not an upload", () => {
      // Delete messages carry no size or eTag.
      const result = storageEventSchema.safeParse(
        r2Body("DeleteObject", "users/user-1/receipt.png", {
          eTag: undefined,
          size: undefined,
        })
      );

      expect(result.success).toBeTruthy();
      expect(result.data).toBeNull();
    });

    it("ignores a LifecycleDeletion message as not an upload", () => {
      const result = storageEventSchema.safeParse(
        r2Body("LifecycleDeletion", "users/user-1/receipt.png", {
          eTag: undefined,
          size: undefined,
        })
      );

      expect(result.success).toBeTruthy();
      expect(result.data).toBeNull();
    });

    it("ignores a CopyObject message as not an upload", () => {
      // R2's documented CopyObject example: the copy creates an object, but the
      // app never copies one, so it is not an upload it can act on.
      const result = storageEventSchema.safeParse({
        account: "3f4b7e3dcab231cbfdaa90a6a28bd548",
        action: "CopyObject",
        bucket: "my-bucket",
        copySource: { bucket: "my-bucket", object: "my-original-object" },
        eventTime: "2024-05-24T19:36:44.379Z",
        object: {
          eTag: "c846ff7a18f28c2e262116d6e8719ef0",
          key: "my-new-object",
          size: 65_536,
        },
      });

      expect(result.success).toBeTruthy();
      expect(result.data).toBeNull();
    });

    it("returns failure when the action is missing", () => {
      expect(
        storageEventSchema.safeParse({ object: { key: "x" } }).success
      ).toBeFalsy();
    });
  });

  describe("shape selection", () => {
    it("decodes the object key of a RustFS notification but not of an R2 message", () => {
      // The two shapes cannot be confused, so the adapter is chosen by shape
      // rather than by an environment setting.
      const encoded = "users%2Fuser-1%2Freceipt.png";

      expect(
        storageEventSchema.safeParse(
          rustfsNotification(encoded, "s3:ObjectCreated:Put")
        ).data
      ).toStrictEqual({ objectKey: "users/user-1/receipt.png" });
      expect(
        storageEventSchema.safeParse(r2Body("PutObject", encoded)).data
      ).toStrictEqual({ objectKey: encoded });
    });

    it("returns failure for a bucket notification in a shape it does not know", () => {
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
