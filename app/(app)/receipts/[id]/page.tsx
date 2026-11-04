import { ArrowLeft } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { requireSession } from "@/lib/auth/dal";
import { groupCategoryOptions } from "@/lib/category/options";
import { findReceiptByIdWithItems, listCategoryOptions } from "@/lib/db";
import type { ReceiptSelect } from "@/lib/db/schema/receipt";
import { cn } from "@/lib/utils";
import { viewerToday } from "@/lib/viewer";

import { ReceiptEditForm } from "./receipt-edit-form";

interface ReceiptDetailPageProps {
  params: Promise<{ id: string }>;
}

const statusBadgeVariant: Record<
  ReceiptSelect["status"],
  "default" | "destructive" | "outline" | "secondary"
> = {
  done: "default",
  error: "destructive",
  pending: "secondary",
  processing: "secondary",
  uploading: "secondary",
};

const ReceiptImage = ({
  hasImage,
  receiptId,
  className,
}: {
  hasImage: boolean;
  receiptId: string;
  className?: string;
}) => (
  <div
    className={cn(
      "relative",
      // A receipt is tall, not wide: half the phone's viewport shows the top of
      // it, and the whole image is a tap away. "No image available" needs none
      // of that, so it collapses instead of holding 400px of empty space.
      hasImage ? "min-h-[50svh] lg:min-h-[400px]" : "min-h-40",
      className
    )}
  >
    {hasImage ? (
      <Image
        alt="Receipt image"
        className="object-contain p-4"
        fill
        sizes="(max-width: 1024px) 100vw, 50vw"
        src={`/api/receipts/${receiptId}/image`}
        unoptimized
      />
    ) : (
      <div className="text-muted-foreground absolute inset-0 flex items-center justify-center">
        No image available
      </div>
    )}
  </div>
);

const ReceiptTranscript = ({ transcript }: { transcript: string }) => (
  <details className="transcript-details border-border bg-card mt-8 rounded-lg border">
    <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
      OCR transcript
    </summary>
    <pre className="border-border text-muted-foreground overflow-x-auto border-t px-4 py-3 font-mono text-xs whitespace-pre-wrap">
      {transcript}
    </pre>
  </details>
);

const ReceiptDetailPage = async ({ params }: ReceiptDetailPageProps) => {
  const session = await requireSession();

  const { id } = await params;
  const receipt = await findReceiptByIdWithItems(id, session.user.id);

  if (!receipt) {
    notFound();
  }

  const isEditable = receipt.status === "done";
  const categoryGroups = isEditable
    ? groupCategoryOptions(await listCategoryOptions())
    : [];
  // The date field's ceiling: a receipt cannot be bought after the viewer's
  // own today, which a client component cannot know at render time without
  // disagreeing with the server-rendered one.
  const today = await viewerToday(session.user.timezone);

  return (
    <main className="container mx-auto p-6">
      <div className="mb-6 flex items-center gap-3">
        <Link
          aria-label="Back to receipts"
          className="text-muted-foreground hover:text-foreground"
          href="/receipts"
        >
          <ArrowLeft className="size-5" />
        </Link>
        <h1 className="text-2xl font-bold">Receipt Details</h1>
        <Badge variant={statusBadgeVariant[receipt.status]}>
          {receipt.status}
        </Badge>
      </div>

      {isEditable ? (
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          <div className="lg:sticky lg:top-6 lg:self-start">
            <ReceiptImage
              className="lg:h-[calc(100dvh-5rem)] lg:min-h-0"
              hasImage={!!receipt.objectKey}
              receiptId={receipt.id}
            />
          </div>
          <ReceiptEditForm
            categoryGroups={categoryGroups}
            receipt={receipt}
            today={today.toString()}
          />
        </div>
      ) : (
        <ReceiptImage
          className="lg:h-[calc(100dvh-5rem)] lg:min-h-0"
          hasImage={!!receipt.objectKey}
          receiptId={receipt.id}
        />
      )}

      {receipt.transcript ? (
        <ReceiptTranscript transcript={receipt.transcript} />
      ) : null}
    </main>
  );
};

export default ReceiptDetailPage;
