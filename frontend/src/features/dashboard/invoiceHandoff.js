export const hasInvoiceRate = value =>
  (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) &&
  Number.isFinite(Number(value)) && Number(value) >= 0;

export function handoffRate(item) {
  const reliable = item.rateReliable === true && hasInvoiceRate(item.rate);
  return { rate: reliable ? String(item.rate) : "", rateRequired: !reliable };
}
