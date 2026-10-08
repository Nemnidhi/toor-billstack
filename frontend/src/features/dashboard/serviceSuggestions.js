import { useEffect, useState } from "react";
import { listServiceSuggestionsRequest } from "../auth/api";

// Prefix for picker values that come from billing history rather than the catalog.
export const HISTORY_PREFIX = "history:";

export const suggestionValue = (item) => (item.productId ? String(item.productId) : `${HISTORY_PREFIX}${item.key}`);

export const findSuggestion = (suggestions, value) =>
  suggestions.find((item) => suggestionValue(item) === String(value || ""));

export const groupSuggestions = (suggestions) => ({
  saved: suggestions.filter((item) => item.productId),
  history: suggestions.filter((item) => !item.productId),
});

/** Loads service suggestions once; falls back to an empty list if unavailable. */
export const useServiceSuggestions = (reloadKey = 0) => {
  const [suggestions, setSuggestions] = useState([]);
  useEffect(() => {
    let active = true;
    listServiceSuggestionsRequest()
      .then((rows) => { if (active) setSuggestions(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (active) setSuggestions([]); });
    return () => { active = false; };
  }, [reloadKey]);
  return suggestions;
};
