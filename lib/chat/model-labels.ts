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

/**
 * The id's author segment dropped: `deepseek-v4.1-flash`. It is the model's
 * author, not the provider — `local` serves `google/gemma-4-e4b` — and the
 * provider is already either the only one in the list or the heading above the
 * row, so repeating it on every line is noise.
 */
const modelName = (model: string): string => {
  const slash = model.indexOf("/");

  return slash === -1 ? model : model.slice(slash + 1);
};

/**
 * One record per provider, exhaustive on purpose: a provider added to the
 * catalogue without a heading or a label rule is a build error, and its
 * presentation lives in one place rather than in two switches.
 */
const providerPresentation = {
  local: {
    heading: "Local",
    // The one entry whose request does not leave for a hosted provider, so the
    // label says so without opening the menu.
    label: (name: string) => `local (${name})`,
  },
  openrouter: { heading: "OpenRouter", label: (name: string) => name },
} satisfies Record<
  ChatProviderId,
  { heading: string; label: (name: string) => string }
>;

export const modelLabel = ({ model, provider }: ChatSelection): string =>
  providerPresentation[provider].label(modelName(model));

/**
 * The radio group needs one string per row; a model id alone would collide
 * across providers (`google/gemma-4-e4b` could be either). This is a value, not
 * a label — it is never rendered.
 */
export const selectionKey = ({ model, provider }: ChatSelection): string =>
  `${provider}/${model}`;

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
    heading: providerPresentation[provider].heading,
    provider,
    selections,
  }));
};
