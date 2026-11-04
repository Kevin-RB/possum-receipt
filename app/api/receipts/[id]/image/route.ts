import { NextResponse } from "next/server";
import { z } from "zod/v4";

import { auth } from "@/lib/auth";
import { findReceiptByIdForOwner } from "@/lib/db";
import { USER_ERROR } from "@/lib/errors";
import { BUCKET, downloadObject } from "@/lib/storage/client";
import { contentTypeFromKey } from "@/lib/storage/content-type";

const paramsSchema = z.object({
  id: z.uuid({ message: "Invalid receipt ID" }),
});

export const GET = async (
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const session = await auth.api.getSession({ headers: request.headers });

  if (!session) {
    return NextResponse.json(
      { error: USER_ERROR.unauthorized },
      { status: 401 }
    );
  }

  const { id } = paramsSchema.parse(await params);
  const receipt = await findReceiptByIdForOwner(id, session.user.id);

  if (!receipt?.objectKey) {
    return NextResponse.json(
      { error: "Receipt image not found" },
      { status: 404 }
    );
  }

  const body = await downloadObject({
    bucket: BUCKET,
    key: receipt.objectKey,
  });

  if (!body) {
    return NextResponse.json(
      { error: "Receipt image not found" },
      { status: 404 }
    );
  }

  const bytes = await body.transformToByteArray();
  const imageBlob = new Blob([Buffer.from(bytes)], {
    type: contentTypeFromKey(receipt.objectKey),
  });

  return new Response(imageBlob, {
    headers: {
      "Cache-Control": "private, max-age=300",
      "Content-Type": contentTypeFromKey(receipt.objectKey),
    },
  });
};
