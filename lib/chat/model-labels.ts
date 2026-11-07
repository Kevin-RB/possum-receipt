import type { ChatProviderId, ChatSelection } from "@/lib/chat/catalogue";

/**
 * How a `{ provider, model }` selection reads on screen. Pure and free of any
 * provider import, so the picker can use it in the browser without pulling the
 * OpenRouter or LM Studio SDK into the bundle.
 *
 * Labels are derived from the selection rather than stored beside it, so the
 * catalogue stays data (`provider` + `model`) and a new entry needs no label
 * written by hand.
 */

/** The id with its vendor segment dropped: `deepseek-v4.1-flash`. */
const modelName = (model: string): string => {
  const slash = model.indexOf("/");

  return slash === -1 ? model : model.slice(slash + 1);
};

/**
 * `deepseek-v4.1-flash`, not `deepseek/deepseek-v4.1-flash`: the provider is
 * either the only one in the list or the heading above the row, so repeating it
 * on every line is noise.
 *
 * `local` is the exception and keeps its wrapper: it is the one entry whose
 * request does not leave for a hosted provider, and the reader should be able
 * to see that without opening the menu.
 */
export const modelLabel = ({ model, provider }: ChatSelection): string =>
  provider === "local" ? `local (${modelName(model)})` : modelName(model);

/**
 * The radio group needs one string per row; a model id alone would collide
 * across providers (`google/gemma-4-e4b` could be either). This is a value, not
 * a label — it is never rendered.
 */
export const selectionKey = ({ model, provider }: ChatSelection): string =>
  `${provider}/${model}`;

/**
 * Exhaustive on purpose: a provider added to the catalogue without a heading is
 * a build error, not a row grouped under `undefined`.
 */
const providerHeadings = {
  local: "Local",
  openrouter: "OpenRouter",
} satisfies Record<ChatProviderId, string>;

export interface ModelGroup {
  heading: string;
  provider: ChatProviderId;
  selections: ChatSelection[];
}

/**
 * The list as it is drawn: grouped by provider in the order the catalogue
 * orders them, which puts the cheaper remote entries above `local`. The caller
 * decides whether to draw the headings — one group means a flat list.
 */
export const modelGroups = (
  choices: readonly ChatSelection[]
): ModelGroup[] => {
  const groups = new Map<ChatProviderId, ChatSelection[]>();

  for (const selection of choices) {
    const selections = groups.get(selection.provider) ?? [];
    groups.set(selection.provider, [...selections, selection]);
  }

  return [...groups].map(([provider, selections]) => ({
    heading: providerHeadings[provider],
    provider,
    selections,
  }));
};
