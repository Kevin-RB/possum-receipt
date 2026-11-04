"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Camera, ImagePlusIcon } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup } from "@/components/ui/field";
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
  className,
  isProcessing = false,
  onUploadComplete,
  onUploadError,
  onUploadStateChange,
}: {
  className?: string;
  isProcessing?: boolean;
  onUploadComplete?: (receiptId: string) => void;
  onUploadError?: () => void;
  onUploadStateChange?: (stage: UploadStage) => void;
}) => {
  const [preview, setPreview] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isCompressing, setIsCompressing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef<string | null>(null);

  const form = useForm<FormValues>({
    defaultValues: { receipt: undefined as File | undefined },
    mode: "onSubmit",
    resolver: zodResolver(formSchema),
  });
  const isBusy = form.formState.isSubmitting || isCompressing || isProcessing;

  useEffect(
    () => () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
    },
    []
  );

  const onSubmit = async (data: FormValues) => {
    try {
      const receiptId = await uploadReceipt(data.receipt, onUploadStateChange);
      onUploadComplete?.(receiptId);
    } catch (error) {
      onUploadError?.();
      form.setError("receipt", {
        message: error instanceof Error ? error.message : "Upload failed",
      });
    }
  };

  const handleFile = async (file: File) => {
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
                <button
                  type="button"
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
                  disabled={isBusy}
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
                <Button
                  type="button"
                  variant="outline"
                  onClick={openPicker}
                  disabled={isBusy}
                  className="w-full sm:hidden"
                >
                  <ImagePlusIcon data-icon="inline-start" />
                  Choose image
                </Button>
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
