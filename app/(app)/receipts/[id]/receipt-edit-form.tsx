"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
import { Fragment, useId, useMemo } from "react";
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form";
import type {
  Control,
  FieldErrors,
  UseFormRegister,
  UseFormRegisterReturn,
} from "react-hook-form";
import type z from "zod";

import {
  LineReconciliationHints,
  ReconciliationBar,
} from "@/components/receipts/reconciliation-bar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/toast";
import { UNCATEGORISED_CATEGORY } from "@/lib/category/options";
import type { CategoryOptionGroup } from "@/lib/category/options";
import { receiptToNested } from "@/lib/db/receipt-mapping";
import { paymentMethodEnum } from "@/lib/db/schema/receipt";
import type { PaymentMethod, ReceiptSelect } from "@/lib/db/schema/receipt";
import { lineItemKindEnum } from "@/lib/db/schema/receipt-item";
import type {
  LineItemKind,
  ReceiptItemSelect,
} from "@/lib/db/schema/receipt-item";
import { reconcile } from "@/lib/receipt/integrity";
import {
  coerceLineItem,
  normalizeLineItems,
} from "@/lib/receipt/line-item-money";
import { receiptZone } from "@/lib/receipt/zone-caption";
import { cn } from "@/lib/utils";

import { updateReceipt } from "./actions";
import { CategorySelect } from "./category-select";
import { ReceiptZoneCaption } from "./receipt-zone-caption";
import { updateReceiptSchema } from "./schema";
import type { UpdateReceiptInput } from "./schema";
import { TimezoneSelect } from "./timezone-select";
import { TransactionDateTimeField } from "./transaction-date-time-field";

export type ReceiptWithItems = ReceiptSelect & {
  receiptItems: ReceiptItemSelect[];
};

interface ReceiptEditFormProps {
  categoryGroups: CategoryOptionGroup[];
  receipt: ReceiptWithItems;
  /** The viewer's day, resolved on the server — the date field's ceiling. */
  today: string;
  /**
   * The zone the viewer reads in, resolved on the server through the one chain
   * (ADR-0016). The zone caption needs it, and a client component cannot
   * resolve it without disagreeing with the server-rendered copy.
   */
  viewerZone: string;
}

type FormValues = z.input<typeof updateReceiptSchema>;

const toOptionalNumber = (value: string) =>
  value === "" ? undefined : Number(value);

const toRequiredNumber = (value: string) =>
  value === "" ? Number.NaN : Number(value);

const toLineTotal = (value: string) => (value === "" ? 0 : Number(value));

const toFiniteAmount = (value: unknown) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
};

const paymentMethodLabels: Record<PaymentMethod, string> = {
  card: "Card",
  cash: "Cash",
  other: "Other",
};

const paymentMethodDescriptions: Record<PaymentMethod, string> = {
  card: "Visa, Mastercard, EFTPOS, debit or credit",
  cash: "Notes and coins",
  other: "Cheque, gift card or unrecognised",
};

const paymentMethodOptions: {
  description: string;
  label: string;
  value: PaymentMethod;
}[] = paymentMethodEnum.options.map((value) => ({
  description: paymentMethodDescriptions[value],
  label: paymentMethodLabels[value],
  value,
}));

const lineItemKindLabels: Record<LineItemKind, string> = {
  discount: "Discount",
  product: "Product",
  surcharge: "Surcharge",
};

const lineItemKindItems = lineItemKindEnum.options.map((value) => ({
  label: lineItemKindLabels[value],
  value,
}));

const normalizeDatetime = (value: string | undefined) => {
  if (!value) {
    return;
  }
  return value.length === 16 ? `${value}:00` : value;
};

const buildDefaultValues = (receipt: ReceiptWithItems): FormValues => {
  const nested = receiptToNested(receipt);

  return {
    items: receipt.receiptItems.map((item) => ({
      categoryId: item.categoryId,
      itemId: item.id,
      kind: item.kind,
      lineTotal: item.lineTotal,
      name: item.name,
      quantity: item.quantity ?? undefined,
      unitPrice: item.unitPrice ?? undefined,
    })),
    merchant: nested.merchant,
    payment: nested.payment,
    receiptId: receipt.id,
    totals: nested.totals,
    transaction: nested.transaction,
    transactionTimezone: receipt.transactionTimezone ?? undefined,
  };
};

type FormFieldErrorProps = { message?: string } | undefined;

/**
 * Joins the ids a control is described by, dropping the ones whose element is
 * not rendered — a reference to a missing id is silently ignored by assistive
 * technology, but it is still a lie in the DOM.
 */
const describedBy = (...ids: (string | undefined)[]) => {
  const rendered = ids.filter((id): id is string => Boolean(id));
  return rendered.length > 0 ? rendered.join(" ") : undefined;
};

const FormFieldError = ({
  error,
  id,
}: {
  error?: FormFieldErrorProps;
  id: string;
}) =>
  error?.message ? (
    <FieldError errors={[{ message: error.message }]} id={id} />
  ) : null;

/**
 * The error element's id when the field has one to render, so a control never
 * describes itself with an element that is not in the document.
 */
const errorIdFor = (error: FormFieldErrorProps, id: string) =>
  error?.message ? id : undefined;

interface ReceiptItemRowProps {
  categoryGroups: CategoryOptionGroup[];
  control: Control<FormValues>;
  errors: FieldErrors<FormValues>;
  index: number;
  item: FormValues["items"][number] | undefined;
  onRemove: (index: number) => void;
  register: UseFormRegister<FormValues>;
}

/**
 * Whether the save will store this amount as typed. Asks the coercion rather
 * than restating the rule, so the hint cannot drift from what a save does.
 */
const storedAsTyped = (kind: LineItemKind, lineTotal: number): boolean =>
  coerceLineItem({ kind, lineTotal }).lineTotal === lineTotal;

/**
 * Explains the sign the save will apply, so a discount typed as a positive
 * amount does not look like it was quietly reinterpreted. The input keeps
 * showing what was typed — the negation happens on save, not as you type.
 */
const DiscountSignHint = ({ id }: { id: string }) => (
  <FieldDescription id={id}>
    A discount is stored as a deduction, so this amount will be negated on save.
  </FieldDescription>
);

interface LineTotalFieldProps {
  error: FormFieldErrorProps;
  id: string;
  item: FormValues["items"][number] | undefined;
  lineTotalField: UseFormRegisterReturn;
}

/**
 * The line total, plus the sign the save will apply: a discount is stored as a
 * deduction, so a positive amount typed for one is negated on the way in.
 */
const LineTotalField = ({
  error,
  id,
  item,
  lineTotalField,
}: LineTotalFieldProps) => {
  const lineTotal = toFiniteAmount(item?.lineTotal);
  const asTyped = storedAsTyped(item?.kind ?? "product", lineTotal);
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor={id}>Line Total</FieldLabel>
      <FieldContent>
        <Input
          aria-describedby={describedBy(
            asTyped ? undefined : hintId,
            error ? errorId : undefined
          )}
          aria-invalid={!!error}
          id={id}
          step="0.01"
          type="number"
          {...lineTotalField}
          onBlur={(event) => {
            lineTotalField.onBlur(event);
            if (event.target.value === "") {
              event.target.value = "0";
            }
          }}
        />
        {asTyped ? null : <DiscountSignHint id={hintId} />}
        <FormFieldError error={error} id={errorId} />
      </FieldContent>
    </Field>
  );
};

const ReceiptItemRow = ({
  categoryGroups,
  control,
  errors,
  index,
  item,
  onRemove,
  register,
}: ReceiptItemRowProps) => {
  // One base id per row, so the same field names in a second row cannot collide.
  const rowId = useId();

  const lineTotalField = register(`items.${index}.lineTotal` as const, {
    setValueAs: toLineTotal,
  });

  const nameError = errors.items?.[index]?.name;
  const categoryError = errors.items?.[index]?.categoryId;
  const quantityError = errors.items?.[index]?.quantity;
  const unitPriceError = errors.items?.[index]?.unitPrice;

  const removeLabel = item?.name?.trim()
    ? `Remove ${item.name.trim()}`
    : `Remove item ${index + 1}`;

  return (
    <FieldGroup className="grid grid-cols-4">
      <Field className="col-span-2" data-invalid={!!nameError}>
        <FieldLabel htmlFor={`${rowId}-name`}>Name</FieldLabel>
        <FieldContent>
          <Input
            aria-describedby={nameError ? `${rowId}-name-error` : undefined}
            aria-invalid={!!nameError}
            id={`${rowId}-name`}
            placeholder="Item name"
            {...register(`items.${index}.name` as const)}
          />
          <FormFieldError error={nameError} id={`${rowId}-name-error`} />
        </FieldContent>
      </Field>

      <Field className="col-span-1" data-invalid={!!categoryError}>
        <FieldLabel
          htmlFor={`${rowId}-category`}
          id={`${rowId}-category-label`}
        >
          Category
        </FieldLabel>
        <FieldContent>
          <Controller
            control={control}
            name={`items.${index}.categoryId` as const}
            render={({ field: categoryField }) => (
              <CategorySelect
                describedBy={
                  categoryError ? `${rowId}-category-error` : undefined
                }
                groups={categoryGroups}
                id={`${rowId}-category`}
                invalid={!!categoryError}
                labelledBy={`${rowId}-category-label`}
                onValueChange={(value) =>
                  categoryField.onChange(
                    value === UNCATEGORISED_CATEGORY ? null : value
                  )
                }
                value={categoryField.value ?? UNCATEGORISED_CATEGORY}
              />
            )}
          />
          <FormFieldError
            error={categoryError}
            id={`${rowId}-category-error`}
          />
        </FieldContent>
      </Field>

      <Button
        aria-label={removeLabel}
        className="col-span-1 self-end justify-self-end"
        onClick={() => onRemove(index)}
        type="button"
        variant="ghost"
        size="icon"
      >
        <Trash2 />
      </Button>

      <Field>
        <FieldLabel htmlFor={`${rowId}-kind`} id={`${rowId}-kind-label`}>
          Kind
        </FieldLabel>
        <FieldContent>
          <Controller
            control={control}
            name={`items.${index}.kind` as const}
            render={({ field: kindField }) => (
              <Select
                items={lineItemKindItems}
                onValueChange={(value) =>
                  kindField.onChange(value as LineItemKind)
                }
                value={kindField.value ?? "product"}
              >
                <SelectTrigger
                  aria-labelledby={`${rowId}-kind-label`}
                  className="w-full"
                  id={`${rowId}-kind`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {lineItemKindItems.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}
          />
        </FieldContent>
      </Field>
      <Field data-invalid={!!quantityError}>
        <FieldLabel htmlFor={`${rowId}-quantity`}>Quantity</FieldLabel>
        <FieldContent>
          <Input
            aria-describedby={
              quantityError ? `${rowId}-quantity-error` : undefined
            }
            aria-invalid={!!quantityError}
            id={`${rowId}-quantity`}
            min="0"
            step="any"
            type="number"
            {...register(`items.${index}.quantity` as const, {
              setValueAs: toOptionalNumber,
            })}
          />
          <FormFieldError
            error={quantityError}
            id={`${rowId}-quantity-error`}
          />
        </FieldContent>
      </Field>
      <Field data-invalid={!!unitPriceError}>
        <FieldLabel htmlFor={`${rowId}-unit-price`}>Unit Price</FieldLabel>
        <FieldContent>
          <Input
            aria-describedby={
              unitPriceError ? `${rowId}-unit-price-error` : undefined
            }
            aria-invalid={!!unitPriceError}
            id={`${rowId}-unit-price`}
            // No `min`: a discount's unit price is negative, and the input must
            // not refuse a value the save is about to store.
            step="0.01"
            type="number"
            {...register(`items.${index}.unitPrice` as const, {
              setValueAs: toOptionalNumber,
            })}
          />
          <FormFieldError
            error={unitPriceError}
            id={`${rowId}-unit-price-error`}
          />
          <LineReconciliationHints
            lineTotal={item?.lineTotal}
            quantity={item?.quantity}
            unitPrice={item?.unitPrice}
          />
        </FieldContent>
      </Field>
      <LineTotalField
        error={errors.items?.[index]?.lineTotal}
        id={`${rowId}-line-total`}
        item={item}
        lineTotalField={lineTotalField}
      />
    </FieldGroup>
  );
};

export const ReceiptEditForm = ({
  categoryGroups,
  receipt,
  today,
  viewerZone,
}: ReceiptEditFormProps) => {
  const {
    control,
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
  } = useForm<FormValues, undefined, UpdateReceiptInput>({
    defaultValues: buildDefaultValues(receipt),
    resolver: zodResolver(updateReceiptSchema),
  });

  // Every control's id is derived from one base, so the label, the control, its
  // description and its error stay in step instead of being written three times.
  const formId = useId();
  const fieldId = (name: string) => `${formId}-${name}`;

  // Read once each: the same error decides the field's invalid state, the id it
  // is described by and the message element's own id.
  const merchantNameError = errors.merchant?.name;
  const subtotalError = errors.totals?.subtotal;
  const gstError = errors.totals?.gst;
  const totalError = errors.totals?.total;
  const timezoneError = errors.transactionTimezone;

  // The category each stored line item started with, so a submit can tell a
  // deliberate change from a value that merely looks stale.
  const mountedCategoryByItemId = useMemo(
    () =>
      new Map(
        receipt.receiptItems.map((item) => [item.id, item.categoryId ?? null])
      ),
    [receipt.receiptItems]
  );

  const { append, fields, remove } = useFieldArray({
    control,
    name: "items",
  });

  const watchedItems = useWatch({ control, name: "items" });
  const watchedTotals = useWatch({ control, name: "totals" });
  // The caption follows the form rather than the row, so a corrected zone or
  // time is visible before the save.
  const watchedDateTime = useWatch({ control, name: "transaction.datetime" });
  const watchedTimezone = useWatch({ control, name: "transactionTimezone" });

  // The caption is the date and time field's description, so its id is only
  // handed to the controls when there is a caption to read: a zone that names
  // nothing renders none, and a reference to it would then dangle.
  const zoneCaption = useMemo(
    () =>
      receiptZone({
        viewerZone,
        wallClock: watchedDateTime ?? "",
        zone: watchedTimezone,
      }),
    [viewerZone, watchedDateTime, watchedTimezone]
  );
  const zoneCaptionId = zoneCaption ? fieldId("zone-caption") : undefined;

  const statedTotal =
    watchedTotals?.total === undefined
      ? undefined
      : Number(watchedTotals.total);

  const reconciliation = useMemo(
    () =>
      reconcile(
        normalizeLineItems(
          (watchedItems ?? []).map((item) => ({
            kind: item.kind ?? "product",
            lineTotal: toFiniteAmount(item.lineTotal),
          }))
        ),
        { total: statedTotal }
      ),
    [watchedItems, statedTotal]
  );

  const hasReconciliationData =
    (watchedItems?.length ?? 0) > 0 ||
    (statedTotal !== undefined && Number.isFinite(statedTotal));

  const onSubmit = async (data: UpdateReceiptInput) => {
    // The submitted category is the value the item had when the page loaded,
    // which says nothing about intent: a categorization run may have filled the
    // item in the meantime, and overwriting it with the stale form value would
    // record a clear the user never made. Only a category that differs from the
    // value the page started with is treated as a decision — compared by item id
    // rather than by row index, so removing a row cannot shift the comparison.
    // A line the user added has no entry here, and the insert path derives its
    // source from whatever category it carries.
    const items = data.items.map((item) => ({
      ...item,
      categoryTouched:
        item.itemId !== undefined &&
        item.categoryId !== mountedCategoryByItemId.get(item.itemId),
    }));

    const result = await updateReceipt({
      ...data,
      items,
      transaction: {
        ...data.transaction,
        datetime: normalizeDatetime(data.transaction.datetime),
      },
    });

    if (result.success) {
      toast.add({
        description: "Your changes have been stored.",
        title: "Receipt saved",
        type: "success",
      });
    } else {
      toast.add({
        description: result.error,
        title: "Save failed",
        type: "error",
      });
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)}>
      {hasReconciliationData ? (
        <ReconciliationBar
          reconciliation={reconciliation}
          statedTotal={statedTotal}
        />
      ) : null}

      <Card>
        <CardContent>
          <FieldGroup>
            <FieldSet>
              <FieldLegend>Merchant</FieldLegend>
              <FieldDescription>
                The merchant information is used to identify the store where the
                purchase was made.
              </FieldDescription>
              <Field data-invalid={!!merchantNameError}>
                <FieldLabel htmlFor={fieldId("merchant-name")}>Name</FieldLabel>
                <FieldContent>
                  <Input
                    aria-describedby={errorIdFor(
                      merchantNameError,
                      fieldId("merchant-name-error")
                    )}
                    aria-invalid={!!merchantNameError}
                    id={fieldId("merchant-name")}
                    {...register("merchant.name")}
                    placeholder="Store name"
                  />
                  <FormFieldError
                    error={merchantNameError}
                    id={fieldId("merchant-name-error")}
                  />
                </FieldContent>
              </Field>
              <Field>
                <FieldLabel htmlFor={fieldId("merchant-address")}>
                  Address
                </FieldLabel>
                <FieldContent>
                  <Input
                    id={fieldId("merchant-address")}
                    {...register("merchant.address")}
                    placeholder="Street address"
                  />
                </FieldContent>
              </Field>
              <FieldGroup className="grid grid-cols-1 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor={fieldId("merchant-abn")}>ABN</FieldLabel>
                  <FieldContent>
                    <Input
                      id={fieldId("merchant-abn")}
                      {...register("merchant.abn")}
                      placeholder="00 000 000 000"
                    />
                  </FieldContent>
                </Field>
                <Field>
                  <FieldLabel htmlFor={fieldId("merchant-store-id")}>
                    Store ID
                  </FieldLabel>
                  <FieldContent>
                    <Input
                      id={fieldId("merchant-store-id")}
                      {...register("merchant.storeId")}
                      placeholder="1234"
                    />
                  </FieldContent>
                </Field>
              </FieldGroup>
            </FieldSet>

            <FieldSeparator />

            <FieldSet>
              <FieldLegend>Transaction</FieldLegend>
              <FieldDescription>
                When the purchase was made and the receipt number.
              </FieldDescription>
              <Field>
                <FieldLabel
                  htmlFor={fieldId("transaction-datetime")}
                  id={fieldId("transaction-datetime-label")}
                >
                  Date &amp; Time
                </FieldLabel>
                <FieldContent>
                  <Controller
                    control={control}
                    name="transaction.datetime"
                    render={({ field: datetimeField }) => (
                      <TransactionDateTimeField
                        describedBy={zoneCaptionId}
                        id={fieldId("transaction-datetime")}
                        labelledBy={fieldId("transaction-datetime-label")}
                        onValueChange={(value) => datetimeField.onChange(value)}
                        today={today}
                        value={datetimeField.value}
                      />
                    )}
                  />
                  <ReceiptZoneCaption
                    id={zoneCaptionId}
                    viewerZone={viewerZone}
                    wallClock={watchedDateTime}
                    zone={watchedTimezone}
                  />
                </FieldContent>
              </Field>
              <Field data-invalid={!!timezoneError}>
                <FieldLabel
                  htmlFor={fieldId("timezone")}
                  id={fieldId("timezone-label")}
                >
                  Added from
                </FieldLabel>
                <FieldContent>
                  <Controller
                    control={control}
                    name="transactionTimezone"
                    render={({ field: timezoneField }) => (
                      <TimezoneSelect
                        describedBy={describedBy(
                          fieldId("timezone-description"),
                          errorIdFor(timezoneError, fieldId("timezone-error"))
                        )}
                        id={fieldId("timezone")}
                        invalid={!!timezoneError}
                        labelledBy={fieldId("timezone-label")}
                        onValueChange={(value) => timezoneField.onChange(value)}
                        value={timezoneField.value}
                      />
                    )}
                  />
                  <FieldDescription id={fieldId("timezone-description")}>
                    Where this receipt was added from, filled in by the browser
                    that uploaded it. It labels the time above; it never changes
                    the date.
                  </FieldDescription>
                  <FormFieldError
                    error={timezoneError}
                    id={fieldId("timezone-error")}
                  />
                </FieldContent>
              </Field>
              <Field>
                <FieldLabel htmlFor={fieldId("receipt-number")}>
                  Receipt Number
                </FieldLabel>
                <FieldContent>
                  <Input
                    id={fieldId("receipt-number")}
                    {...register("transaction.receiptNumber")}
                    placeholder="0001"
                  />
                </FieldContent>
              </Field>
            </FieldSet>

            <FieldSeparator />

            <FieldSet>
              <FieldLegend>Payment Method</FieldLegend>
              <Controller
                control={control}
                name="payment.method"
                render={({ field }) => (
                  <RadioGroup
                    className="grid grid-cols-1 sm:grid-cols-3"
                    onValueChange={(value) => field.onChange(value)}
                    value={field.value}
                  >
                    {paymentMethodOptions.map((option) => (
                      <FieldLabel
                        key={option.value}
                        htmlFor={`payment-${option.value}`}
                      >
                        <Field orientation="horizontal">
                          <FieldContent>
                            <div className="font-medium">{option.label}</div>
                            <FieldDescription>
                              {option.description}
                            </FieldDescription>
                          </FieldContent>
                          <RadioGroupItem
                            id={`payment-${option.value}`}
                            value={option.value}
                          />
                        </Field>
                      </FieldLabel>
                    ))}
                  </RadioGroup>
                )}
              />
            </FieldSet>

            <FieldSeparator />

            <FieldSet>
              <FieldLegend>Totals</FieldLegend>
              <FieldDescription>
                The amounts shown on the receipt, before and after tax.
              </FieldDescription>
              <FieldGroup className="grid grid-cols-3">
                <Field data-invalid={!!subtotalError}>
                  <FieldLabel htmlFor={fieldId("totals-subtotal")}>
                    Subtotal
                  </FieldLabel>
                  <FieldContent>
                    <Input
                      aria-describedby={errorIdFor(
                        subtotalError,
                        fieldId("totals-subtotal-error")
                      )}
                      aria-invalid={!!subtotalError}
                      id={fieldId("totals-subtotal")}
                      min="0"
                      step="0.01"
                      type="number"
                      {...register("totals.subtotal", {
                        setValueAs: toOptionalNumber,
                      })}
                    />
                    <FormFieldError
                      error={subtotalError}
                      id={fieldId("totals-subtotal-error")}
                    />
                  </FieldContent>
                </Field>
                <Field data-invalid={!!gstError}>
                  <FieldLabel htmlFor={fieldId("totals-gst")}>GST</FieldLabel>
                  <FieldContent>
                    <Input
                      aria-describedby={errorIdFor(
                        gstError,
                        fieldId("totals-gst-error")
                      )}
                      aria-invalid={!!gstError}
                      id={fieldId("totals-gst")}
                      min="0"
                      step="0.01"
                      type="number"
                      {...register("totals.gst", {
                        setValueAs: toOptionalNumber,
                      })}
                    />
                    <FormFieldError
                      error={gstError}
                      id={fieldId("totals-gst-error")}
                    />
                  </FieldContent>
                </Field>
                <Field data-invalid={!!totalError}>
                  <FieldLabel htmlFor={fieldId("totals-total")}>
                    Total
                  </FieldLabel>
                  <FieldContent>
                    <Input
                      aria-describedby={errorIdFor(
                        totalError,
                        fieldId("totals-total-error")
                      )}
                      aria-invalid={!!totalError}
                      id={fieldId("totals-total")}
                      min="0"
                      step="0.01"
                      type="number"
                      {...register("totals.total", {
                        setValueAs: toRequiredNumber,
                      })}
                    />
                    <FormFieldError
                      error={totalError}
                      id={fieldId("totals-total-error")}
                    />
                  </FieldContent>
                </Field>
              </FieldGroup>
            </FieldSet>

            <FieldSeparator />

            <FieldSet>
              <FieldLegend>Items</FieldLegend>
              <FieldDescription>
                The individual lines on the receipt, one per product or service.
              </FieldDescription>
              <FieldGroup>
                {fields.map((field, index) => (
                  <Fragment key={field.id}>
                    <ReceiptItemRow
                      categoryGroups={categoryGroups}
                      control={control}
                      errors={errors}
                      index={index}
                      item={watchedItems?.[index]}
                      onRemove={remove}
                      register={register}
                    />
                    {index < fields.length - 1 ? <Separator /> : null}
                  </Fragment>
                ))}

                <Button
                  className={cn(fields.length === 0 && "w-full")}
                  onClick={() =>
                    append(
                      {
                        categoryId: null,
                        kind: "product",
                        lineTotal: 0,
                        name: "",
                        quantity: undefined,
                        unitPrice: undefined,
                      },
                      // Name the field explicitly rather than relying on append's
                      // default focus, which targets the first field registered
                      // under the new line item — that is line total, since
                      // ReceiptItemRow registers it before rendering name.
                      { focusName: `items.${fields.length}.name` }
                    )
                  }
                  type="button"
                  variant="outline"
                >
                  <Plus data-icon="inline-start" />
                  Add Item
                </Button>
              </FieldGroup>
            </FieldSet>
          </FieldGroup>
        </CardContent>

        <CardFooter className="justify-end">
          <Button disabled={isSubmitting} type="submit">
            {isSubmitting ? "Saving…" : "Save"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
};
