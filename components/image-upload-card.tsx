"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Camera, ImagePlusIcon } from "lucide-react";
import Image from "next/image";
import { useEffect, useId, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup } from "@/components/ui/field";
import { browserTimezone } from "@/lib/browser-timezone";
import { isUserMessage, USER_ERROR } from "@/lib/errors";
import { compressReceiptImage } from "@/lib/images/compress-receipt-image";
import { ACCEPTED_MIME_TYPES } from "@/lib/storage/constants";
import { cn } from "@/lib/utils";

const formSchema = z.object({
  receipt: z
    .file()
    .min(1, "Please select a file")
    .mime([...ACCEPTED_MIME_TYPES], "Invalid file type"),
});

type FormValues = z.infer<typeof formSchema>;
type UploadStage = "requesting-url" | "uploading-to-storage";

const UPLOAD_STAGE_LABEL: Record<UploadStage, string> = {
  "requesting-url": "Starting the upload…",
  "uploading-to-storage": "Uploading your receipt…",
};

/**
 * One line, not one per percent: the reader gets the stage that is happening
 * now, and the outcome arrives in the toast. The card shows it rather than a
 * live region (accessibility guide §8); the busy control keeps focus and
 * points `aria-describedby` here, so the stage is announced in place.
 */
const resolveBusyLabel = (input: {
  isCompressing: boolean;
  processingLabel: string | undefined;
  stage: UploadStage | null;
}): string | undefined => {
  if (input.processingLabel !== undefined) {
    return input.processingLabel;
  }
  if (input.isCompressing) {
    return "Compressing your photo…";
  }
  return input.stage ? UPLOAD_STAGE_LABEL[input.stage] : undefined;
};

const UploadResponse = z.object({
  receiptId: z.string(),
  uploadUrl: z.string(),
});

class UploadError extends Error {
  stage: UploadStage;
  constructor(stage: UploadStage, message: string) {
    super(message);
    this.name = "UploadError";
    this.stage = stage;
  }
}

/**
 * The endpoint answers a failure with `{ error }`, but only wording from the
 * catalogue is safe to show — the body can also be a validation string from
 * the server. Anything else becomes the upload's own line rather than a status
 * code in a form field.
 */
const failureMessage = async (response: Response): Promise<string> => {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  const message = typeof body?.error === "string" ? body.error : "";

  return isUserMessage(message) ? message : USER_ERROR.uploadFailed;
};

const uploadReceipt = async (
  file: File,
  onStageChange?: (stage: UploadStage) => void
): Promise<string> => {
  onStageChange?.("requesting-url");

  const res = await fetch("/api/upload", {
    body: JSON.stringify({
      contentType: file.type,
      fileSize: file.size,
      // Read at upload time, not at render time: the reader may have travelled
      // since the page loaded. See #200.
      timezone: browserTimezone(),
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!res.ok) {
    throw new UploadError("requesting-url", await failureMessage(res));
  }

  const parsed = UploadResponse.safeParse(await res.json());
  if (!parsed.success) {
    throw new UploadError(
      "requesting-url",
      "Invalid response from upload endpoint"
    );
  }

  const { receiptId, uploadUrl } = parsed.data;

  onStageChange?.("uploading-to-storage");

  const putRes = await fetch(uploadUrl, {
    body: file,
    headers: { "Content-Type": file.type },
    method: "PUT",
  });

  if (!putRes.ok) {
    throw new UploadError(
      "uploading-to-storage",
      "Failed to upload image to storage"
    );
  }

  return receiptId;
};

export const ImageUploadCard = ({
  autoFocusOnMount = false,
  className,
  processingLabel,
  onUploadComplete,
  onUploadError,
  onUploadStateChange,
}: {
  /**
   * Focus the drop zone when this card mounts. The parent sets it when the
   * card that was just replaced held focus — `UploadFlow` remounts the card to
   * clear a finished receipt's preview, and a plain remount would otherwise
   * drop focus to `<body>`.
   */
  autoFocusOnMount?: boolean;
  className?: string;
  /**
   * What to say while the uploaded receipt is being processed. Presence is
   * also what makes the card busy: the parent owns the run, so it owns the
   * wording (`resolveProgressLabel` in `receipt-toast-notifier`).
   */
  processingLabel?: string;
  onUploadComplete?: (receiptId: string) => void;
  onUploadError?: () => void;
  onUploadStateChange?: (stage: UploadStage) => void;
}) => {
  const [preview, setPreview] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isCompressing, setIsCompressing] = useState(false);
  const [stage, setStage] = useState<UploadStage | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef<string | null>(null);
  const statusId = useId();

  const form = useForm<FormValues>({
    defaultValues: { receipt: undefined as File | undefined },
    mode: "onSubmit",
    resolver: zodResolver(formSchema),
  });
  const isBusy =
    form.formState.isSubmitting ||
    isCompressing ||
    processingLabel !== undefined;

  // A stage must not outlive the attempt that set it: a failed upload returns
  // the card to idle with `stage` still holding the last phase, and the status
  // line, the bar and both `aria-describedby`s all render from this label.
  const busyLabel = isBusy
    ? resolveBusyLabel({ isCompressing, processingLabel, stage })
    : undefined;

  useEffect(
    () => () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
    },
    []
  );

  const reportStage = (next: UploadStage) => {
    setStage(next);
    onUploadStateChange?.(next);
  };

  const onSubmit = async (data: FormValues) => {
    try {
      const receiptId = await uploadReceipt(data.receipt, reportStage);
      onUploadComplete?.(receiptId);
    } catch (error) {
      onUploadError?.();
      // The throw carries either catalogue wording from `failureMessage` or a
      // diagnostic line of ours ("Failed to upload image to storage"), which is
      // not ours to show. Only the former reaches the field. See ADR-0014.
      form.setError("receipt", {
        message:
          error instanceof Error && isUserMessage(error.message)
            ? error.message
            : USER_ERROR.uploadFailed,
      });
    }
  };

  const handleFile = async (file: File) => {
    if (isBusy) {
      return;
    }
    setStage(null);
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
    }
    previewUrlRef.current = URL.createObjectURL(file);
    setPreview(previewUrlRef.current);
    form.clearErrors("receipt");
    setIsCompressing(true);

    let valid = false;
    try {
      const compressed = await compressReceiptImage(file);
      form.setValue("receipt", compressed);
      valid = await form.trigger("receipt");
    } catch {
      form.setError("receipt", {
        message: "We couldn't process that image. Try another photo.",
      });
    }

    setIsCompressing(false);
    if (inputRef.current) {
      inputRef.current.value = "";
    }
    if (cameraInputRef.current) {
      cameraInputRef.current.value = "";
    }

    if (valid) {
      form.handleSubmit(onSubmit)();
    }

    return valid;
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) {
      void handleFile(selected);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) {
      void handleFile(dropped);
    }
  };

  const openPicker = () => {
    if (!isBusy) {
      inputRef.current?.click();
    }
  };

  const openCamera = () => {
    if (!isBusy) {
      cameraInputRef.current?.click();
    }
  };

  return (
    <form
      id="upload-form"
      onSubmit={form.handleSubmit(onSubmit)}
      className={cn("contents", className)}
    >
      <FieldGroup>
        <Controller
          name="receipt"
          control={form.control}
          render={({ fieldState, field }) => {
            const { name, onBlur: handleBlur } = field;
            return (
              <Field data-invalid={fieldState.invalid}>
                {/* Holds the drop zone and the in-flight bar, so the bar can
                    ride the drop zone's bottom edge without living inside the
                    button (a button's descendants are presentational, so a
                    progressbar there would never reach assistive tech). */}
                <div className="relative">
                  <button
                    type="button"
                    // `autoFocus` is mount-only, so a later render does not pull
                    // focus back off whatever the reader is on.
                    autoFocus={autoFocusOnMount}
                    onClick={openCamera}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setIsDragOver(true);
                    }}
                    onDragLeave={(e) => {
                      e.preventDefault();
                      setIsDragOver(false);
                    }}
                    onDrop={handleDrop}
                    // Not `disabled`: that removes the control the reader just
                    // activated from the focus order, so focus falls to <body>
                    // mid-upload. `aria-disabled` keeps it, and the handlers
                    // above refuse the activation instead.
                    aria-disabled={isBusy}
                    aria-busy={isBusy}
                    aria-describedby={busyLabel ? statusId : undefined}
                    // No `aria-label`: the name is the copy inside the button,
                    // so a voice-control user can say what they see (WCAG
                    // 2.5.3). Exactly one of the two sentences below is
                    // rendered — each is a `display: none` breakpoint pair, not
                    // `sr-only` — so the name is never doubled.
                    className={cn(
                      "border-border bg-card hover:border-accent hover:bg-muted flex w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-none border-2 border-dashed transition-colors",
                      preview ? "p-2" : "p-8",
                      isDragOver && "border-primary bg-muted",
                      isBusy && "cursor-not-allowed opacity-50"
                    )}
                  >
                    {preview ? (
                      <div className="enter-rise relative h-[50vh] max-h-96 w-full">
                        <Image
                          src={preview}
                          alt="Receipt preview"
                          fill
                          sizes="(min-width: 640px) 28rem, 100vw"
                          className="object-contain"
                        />
                      </div>
                    ) : (
                      <>
                        <Camera className="text-muted-foreground size-10 sm:hidden" />
                        <ImagePlusIcon className="text-muted-foreground hidden size-10 sm:block" />
                        <div className="flex flex-col items-center gap-1 text-center">
                          <span className="text-xs font-medium sm:hidden">
                            Take a photo or choose one below
                          </span>
                          <span className="hidden text-xs font-medium sm:inline">
                            Click to browse or drag and drop
                          </span>
                        </div>
                      </>
                    )}
                  </button>
                  {/* No `value`: indeterminate. Named by the stage text, never
                      focusable, and mounted for as long as the stage row is, so
                      the segment does not restart per stage.

                      The width is explicit: an absolutely positioned
                      <progress> keeps its UA intrinsic inline size (10em) even
                      with `inset-x` on both sides, so the inset pair alone
                      leaves a short bar in the corner. `left` + this width give
                      the same 8px inset on both edges, in either direction. */}
                  {busyLabel && (
                    <progress
                      aria-labelledby={statusId}
                      className="upload-progress pointer-events-none absolute bottom-2 left-2 w-[calc(100%-1rem)]"
                    />
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={openPicker}
                  aria-disabled={isBusy}
                  aria-describedby={busyLabel ? statusId : undefined}
                  className="w-full sm:hidden"
                >
                  <ImagePlusIcon data-icon="inline-start" />
                  Choose image
                </Button>
                {busyLabel && (
                  <p
                    className="shimmer text-muted-foreground text-sm"
                    id={statusId}
                  >
                    {busyLabel}
                  </p>
                )}
                {fieldState.invalid && (
                  <FieldError errors={[fieldState.error]} />
                )}
                <input
                  ref={inputRef}
                  id="receipt-input"
                  name={name}
                  onBlur={handleBlur}
                  type="file"
                  accept="image/*"
                  onChange={handleChange}
                  className="sr-only"
                  aria-label="Upload receipt image"
                  aria-invalid={fieldState.invalid}
                  disabled={isBusy}
                />
                <input
                  ref={cameraInputRef}
                  id="receipt-camera-input"
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handleChange}
                  className="sr-only"
                  aria-label="Take a photo of a receipt"
                  disabled={isBusy}
                />
              </Field>
            );
          }}
        />
      </FieldGroup>
    </form>
  );
};
