import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod/v4";

import { auth } from "@/lib/auth";
import { db, receipts } from "@/lib/db";
import { USER_ERROR } from "@/lib/errors";
import {
  BUCKET,
  createPresignedUrl,
  presignEndpointForHost,
} from "@/lib/storage/client";
import { ACCEPTED_MIME_TYPES } from "@/lib/storage/constants";
import { extensionForMime } from "@/lib/storage/content-type";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const PRESIGNED_URL_EXPIRY_SECONDS = 60 * 5;

const UploadRequest = z.object({
  contentType: z.enum(ACCEPTED_MIME_TYPES, {
    error: "Unsupported content type",
  }),
  fileSize: z
    .number({ error: "fileSize must be a number" })
    .int({ error: "fileSize must be an integer" })
    .positive({ error: "fileSize must be > 0" })
    .max(MAX_FILE_SIZE, { error: `fileSize must be <= ${MAX_FILE_SIZE}` }),
});

export const POST = async (request: Request) => {
  const session = await auth.api.getSession({ headers: request.headers });

  if (!session) {
    return NextResponse.json(
      { error: USER_ERROR.unauthorized },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }

  const parsed = UploadRequest.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
      { status: 400 }
    );
  }

  const { contentType } = parsed.data;

  // Object keys are namespaced by owner: `users/<userId>/<uuid>.<ext>`. The
  // bucket is shared and private and the app enforces ownership on read, so
  // this is defence in depth: it makes ownership obvious at the storage layer
  // and turns per-user bulk operations (export, erasure, lifecycle) into a
  // prefix operation. Existing unprefixed keys remain valid.
  const objectId = randomUUID();
  const ext = extensionForMime(contentType);
  const objectKey = `users/${session.user.id}/${objectId}.${ext}`;

  const [{ receiptId }] = await db
    .insert(receipts)
    .values({
      objectKey,
      status: "uploading",
      userId: session.user.id,
    })
    .returning({ receiptId: receipts.id });

  const uploadUrl = await createPresignedUrl({
    bucket: BUCKET,
    contentType,
    endpoint: presignEndpointForHost(request.headers.get("host")),
    expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
    key: objectKey,
  });

  return NextResponse.json({ receiptId, uploadUrl });
};
