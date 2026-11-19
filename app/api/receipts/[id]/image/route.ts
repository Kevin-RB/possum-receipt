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

  const contentType = contentTypeFromKey(receipt.objectKey);

  // Streamed, not buffered: a phone photo can exceed Vercel's 4.5 MB response
  // limit, and that limit applies only to a buffered body — a streamed one is
  // forwarded as it arrives. Buffering also assembled the whole object in
  // memory before handing it back, which this avoids.
  return new Response(body.transformToWebStream(), {
    headers: {
      "Cache-Control": "private, max-age=300",
      "Content-Type": contentType,
      // The bytes are user-uploaded; without this a browser may sniff its way
      // to a type the stored content type does not name.
      "X-Content-Type-Options": "nosniff",
    },
  });
};
