const idOf = (value) => String(value?._id || value || "");
export const recordInvoicePayment = async ({ invoice, amount, fields, api, recordedPaymentId, onRecorded }) => {
  const response = await api.getInvoice(invoice._id);
  const fresh = response?.invoice || response?.data || response;
  const existing = async (paymentId) => (await api.listAllocations(fresh._id)).some((row) => idOf(row.paymentId) === idOf(paymentId));
  if (recordedPaymentId && await existing(recordedPaymentId)) return { alreadyApplied: true, invoice: fresh };
  const outstanding = Number(fresh.balanceDue || 0);
  if (outstanding <= 0) return { alreadyPaid: true, invoice: fresh };
  const requested = Number(amount);
  const tds = Number(fields.tdsAmount || 0);
  if (!Number.isFinite(requested) || requested <= 0) throw new Error("Enter an amount greater than zero.");
  if (!Number.isFinite(tds) || tds < 0) throw new Error("TDS must be zero or more.");
  // the customer's TDS settles the invoice along with the money received
  const settles = Math.round((requested + tds) * 100) / 100;
  if (settles > outstanding) throw new Error("Payment exceeds the invoice outstanding amount. Refresh the balance and try again.");
  const payment = await api.createPayment({
    amount: requested, direction: "RECEIVED", customerId: fresh.customerId?._id || fresh.customerId,
    currency: "INR", paymentMethod: fields.paymentMethod, paymentDate: fields.paymentDate,
    referenceNumber: fields.referenceNumber || "", notes: fields.notes || "", idempotencyKey: fields.idempotencyKey,
    ...(tds > 0 ? { tdsAmount: tds, tdsKind: fields.tdsKind || "" } : {}),
  });
  onRecorded(payment._id);
  if (await existing(payment._id)) return { alreadyApplied: true, invoice: fresh };
  await api.allocatePayment(payment._id, { invoiceId: fresh._id, allocatedAmount: settles });
  return { invoice: fresh, amount: settles };
};
