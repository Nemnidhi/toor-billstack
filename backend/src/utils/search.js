// Turn what a person typed in a search box into a safe, literal, case-insensitive
// pattern. Typed text is never treated as a regular expression: "+91 98...", "(",
// "a*" must search for those characters, not crash the request or slow the server.
const MAX_SEARCH_LENGTH = 100;

const escapeRegex = (value) => String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The search text as a plain string (first value if sent twice), trimmed and capped; "" if none. */
const searchText = (value) => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || typeof raw === "object") return "";
  return String(raw).trim().slice(0, MAX_SEARCH_LENGTH);
};

/** A RegExp matching the typed text literally, or null when nothing was typed. */
const searchRegex = (value) => {
  const text = searchText(value);
  return text ? new RegExp(escapeRegex(text), "i") : null;
};

module.exports = { MAX_SEARCH_LENGTH, escapeRegex, searchText, searchRegex };
