import { NextResponse } from "next/server";
import { z } from "zod/v4";

import { auth } from "@/lib/auth";
import { findReceiptByIdForOwner } from "@/lib/db";
import { USER_ERROR } from "@/lib/errors";
import {
  BUCKET,
  createPresignedUrl,
  presignEndpointForHost,
} from "@/lib/storage/client";
import { contentTypeFromKey } from "@/lib/storage/content-type";

const PRESIGNED_URL_EXPIRY_SECONDS = 60 * 5;

const paramsSchema = z.object({
  receiptId: z.uuid({ message: "Invalid receipt ID" }),
});

export const POST = async (
  request: Request,
  { params }: { params: Promise<{ receiptId: string }> }
) => {
  const session = await auth.api.getSession({ headers: request.headers });

  if (!session) {
    return NextResponse.json(
      { error: USER_ERROR.unauthorized },
      { status: 401 }
    );
  }

  const { receiptId } = paramsSchema.parse(await params);

  const receipt = await findReceiptByIdForOwner(receiptId, session.user.id);
  if (!receipt) {
    return NextResponse.json({ error: "Receipt not found" }, { status: 404 });
  }

  if (receipt.status !== "uploading") {
    return NextResponse.json(
      { error: "Can only retry uploads in uploading state" },
      { status: 400 }
    );
  }

  if (!receipt.objectKey) {
    return NextResponse.json(
      { error: "Receipt has no object key" },
      { status: 400 }
    );
  }

  const uploadUrl = await createPresignedUrl({
    bucket: BUCKET,
    contentType: contentTypeFromKey(receipt.objectKey),
    endpoint: presignEndpointForHost(request.headers.get("host")),
    expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
    key: receipt.objectKey,
  });

  return NextResponse.json({ receiptId, uploadUrl });
};
