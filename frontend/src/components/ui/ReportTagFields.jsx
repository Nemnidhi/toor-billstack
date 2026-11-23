import { useEffect, useState } from "react";
import api from "../../api/axios";

// Business line (vertical) and category (horizontal): the group-wide report tags set in
// Settings > Business lines & categories. Shown on invoices, expenses, purchases and recurring
// profiles once the lists have names; hidden until then.
let listsPromise = null;

export const loadTagLists = () => {
  if (!listsPromise) {
    listsPromise = api
      .get("/business/reporting-tags")
      .then((response) => response.data?.data || { businessLines: [], categories: [] })
      .catch(() => {
        listsPromise = null;
        return { businessLines: [], categories: [] };
      });
  }
  return listsPromise;
};

export const forgetTagLists = () => {
  listsPromise = null;
};

export const useTagLists = () => {
  const [lists, setLists] = useState({ businessLines: [], categories: [] });
  useEffect(() => {
    let live = true;
    const read = () => loadTagLists().then((data) => live && setLists(data));
    read();
    const onChange = () => {
      forgetTagLists();
      read();
    };
    window.addEventListener("billstack-tags-changed", onChange);
    window.addEventListener("billstack-entities-changed", onChange);
    return () => {
      live = false;
      window.removeEventListener("billstack-tags-changed", onChange);
      window.removeEventListener("billstack-entities-changed", onChange);
    };
  }, []);
  return lists;
};

// Active names, plus the document's own value when it has since been archived (so an old
// document still shows and keeps it).
const optionsFor = (list, current) => {
  const names = list.filter((row) => !row.archived).map((row) => row.name);
  if (current && !names.some((name) => name.toLowerCase() === String(current).toLowerCase())) names.push(current);
  return names;
};

export const TagSelect = ({ kind, value, onChange, className = "field", lists, disabled = false, name }) => {
  const list = kind === "businessLine" ? lists.businessLines : lists.categories;
  return (
    <select name={name || kind} className={className} value={value || ""} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      <option value="">Not set</option>
      {optionsFor(list, value).map((item) => (
        <option key={item} value={item}>
          {item}
          {list.find((row) => row.name === item)?.archived ? " (archived)" : ""}
        </option>
      ))}
    </select>
  );
};

/**
 * Both pickers. `value` is { businessLine, reportCategory }; `onChange(field, value)`.
 * `wrap` renders each labelled field (defaults to a plain label + select).
 */
const ReportTagFields = ({ value = {}, onChange, className = "field", labelClassName = "mb-2 block text-sm font-medium", disabled = false }) => {
  const lists = useTagLists();
  const show = (kind) => (kind === "businessLine" ? lists.businessLines : lists.categories).length > 0 || Boolean(value[kind]);
  if (!show("businessLine") && !show("reportCategory")) return null;
  return (
    <>
      {show("businessLine") ? (
        <label>
          <span className={labelClassName}>Business line</span>
          <TagSelect kind="businessLine" lists={lists} value={value.businessLine} onChange={(v) => onChange("businessLine", v)} className={className} disabled={disabled} />
        </label>
      ) : null}
      {show("reportCategory") ? (
        <label>
          {/* "Report category": the expense form already has a "Category" (the expense head). */}
          <span className={labelClassName}>Report category</span>
          <TagSelect kind="reportCategory" lists={lists} value={value.reportCategory} onChange={(v) => onChange("reportCategory", v)} className={className} disabled={disabled} />
        </label>
      ) : null}
    </>
  );
};

export default ReportTagFields;
