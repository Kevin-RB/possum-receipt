import {
  columnFilteringFeature,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_includesString,
  metaHelper,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
} from "@tanstack/react-table";

/**
 * What a column tells the renderer about itself, beyond its data.
 *
 * `width` is a share of the table rather than a pixel value, because the table
 * is laid out `table-fixed`: the columns then keep their proportions at every
 * window width, and — the point here — a page of receipts cannot resize a
 * column by having longer content in it. The one column without a width takes
 * whatever is left.
 */
export interface ReceiptColumnMeta {
  width?: `${number}%`;
}

export const features = tableFeatures({
  columnFilteringFeature,
  columnMeta: metaHelper<ReceiptColumnMeta>(),
  filterFns: { includesString: filterFn_includesString },
  filteredRowModel: createFilteredRowModel(),
  // Slices whatever filtering and sorting produced, so a page is a window onto
  // the whole filtered list rather than a slice taken before filtering.
  paginatedRowModel: createPaginatedRowModel(),
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
  },
  sortedRowModel: createSortedRowModel(),
});

export type DataTableFeatures = typeof features;
