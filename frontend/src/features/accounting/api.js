import api from "../../api/axios";

export const getAccountsRequest = async (params = {}) => {
  const response = await api.get("/accounting/accounts", { params });
  return response.data.data;
};

export const getTrialBalanceRequest = async (params = {}) => {
  const response = await api.get("/accounting/trial-balance", { params });
  return response.data.data;
};

export const getAccountLedgerRequest = async (accountId, params = {}) => {
  const url = accountId ? `/accounting/account-ledger/${accountId}` : "/accounting/account-ledger";
  const response = await api.get(url, { params });
  return response.data.data;
};

export const getProfitLossRequest = async (params = {}) => {
  const response = await api.get("/accounting/reports/profit-loss", { params });
  return response.data.data;
};

export const getBalanceSheetRequest = async (params = {}) => {
  const response = await api.get("/accounting/reports/balance-sheet", { params });
  return response.data.data;
};

export const getBankBookRequest = async (params = {}) => {
  const response = await api.get("/accounting/reports/bank-book", { params });
  return response.data.data;
};

export const getCashBookRequest = async (params = {}) => {
  const response = await api.get("/accounting/reports/cash-book", { params });
  return response.data.data;
};

export const getHistoricalWarningRequest = async (params = {}) => {
  const response = await api.get("/accounting/reports/historical-warning", { params });
  return response.data.data;
};

export const getExportPackRequest = async (params = {}) => {
  const response = await api.get("/accounting/reports/export-pack", { params });
  return response.data.data;
};

export const downloadExportXlsx = async (params = {}) => {
  const response = await api.get("/accounting/reports/export-pack", {
    params: { ...params, format: "xlsx" },
    responseType: "blob",
  });
  return response.data;
};

export const downloadExportCsv = async (params = {}) => {
  const response = await api.get("/accounting/reports/export-pack", {
    params: { ...params, format: "csv" },
    responseType: "blob",
  });
  return response.data;
};


export const runBackfillRequest = async (payload) => {
  const response = await api.post("/accounting/backfill", payload);
  return response.data.data;
};

export const postOpeningBalancesRequest = async (payload) => {
  const response = await api.post("/accounting/opening-balances", payload);
  return response.data.data;
};

export const getBankAccountsRequest = async (params = {}) => {
  const response = await api.get("/accounting/bank-accounts", { params });
  return response.data.data;
};

export const createBankAccountRequest = async (payload) => {
  const response = await api.post("/accounting/bank-accounts", payload);
  return response.data.data;
};

export const updateBankAccountRequest = async (id, payload) => {
  const response = await api.put("/accounting/bank-accounts/" + id, payload);
  return response.data.data;
};

export const importBankStatementRequest = async (payload) => {
  const response = await api.post("/accounting/bank-statements/import", payload);
  return response.data.data;
};

export const getReconciliationRequest = async (params = {}) => {
  const response = await api.get("/accounting/bank-reconciliation", { params });
  return response.data.data;
};

export const confirmMatchRequest = async (payload) => {
  const response = await api.post("/accounting/bank-reconciliation/match", payload);
  return response.data.data;
};

export const unmatchRequest = async (payload) => {
  const response = await api.post("/accounting/bank-reconciliation/unmatch", payload);
  return response.data.data;
};

// ---- TDS (books phase 2)
export const getTdsMetaRequest = async () => (await api.get("/accounting/tds/meta")).data.data;
export const getTdsReceivableRequest = async (params = {}) => (await api.get("/accounting/tds/receivable", { params })).data.data;
export const updateTdsReceivableRequest = async (id, payload, params = {}) => (await api.patch(`/accounting/tds/receivable/${id}`, payload, { params })).data.data;
export const importTds26asRequest = async (payload, params = {}) => (await api.post("/accounting/tds/26as/import", payload, { params })).data.data;
export const getTdsPayableRequest = async (params = {}) => (await api.get("/accounting/tds/payable", { params })).data.data;
export const getTdsChallansRequest = async (params = {}) => (await api.get("/accounting/tds/challans", { params })).data.data;
export const createTdsChallanRequest = async (payload, params = {}) => (await api.post("/accounting/tds/challans", payload, { params })).data.data;
export const cancelTdsChallanRequest = async (id, reason, params = {}) => (await api.post(`/accounting/tds/challans/${id}/cancel`, { reason }, { params })).data.data;
export const getTdsForm131Request = async (params = {}) => (await api.get("/accounting/tds/form131", { params })).data.data;
export const downloadTdsForm140 = async (params = {}) => (await api.get("/accounting/tds/form140", { params, responseType: "blob" })).data;

// Controls: period lock, edit log, Goldhawk GST watch
export const getPeriodLockRequest = async (params = {}) => (await api.get("/accounting/period-lock", { params })).data.data;
export const setPeriodLockRequest = async (payload, params = {}) => (await api.put("/accounting/period-lock", payload, { params })).data.data;
export const getEditLogRequest = async (params = {}) => (await api.get("/accounting/edit-log", { params })).data.data;
export const downloadEditLogCsv = async (params = {}) => (await api.get("/accounting/edit-log/export", { params, responseType: "blob" })).data;
export const getGoldhawkWatchRequest = async () => (await api.get("/accounting/goldhawk-watch")).data.data;

// Documents attached to purchases, expenses and suppliers
export const uploadDocumentRequest = async (recordType, recordId, payload) => (await api.post(`/documents/${recordType}/${recordId}`, payload)).data.data;
export const downloadDocumentBlob = async (recordType, recordId, attachmentId) => (await api.get(`/documents/${recordType}/${recordId}/${attachmentId}`, { responseType: "blob" })).data;
export const removeDocumentRequest = async (recordType, recordId, attachmentId) => (await api.delete(`/documents/${recordType}/${recordId}/${attachmentId}`)).data.data;
export const getExpiringAgreementsRequest = async (params = {}) => (await api.get("/documents/agreements/expiring", { params })).data.data;

// Year end: deposits, fixed assets, Schedule III, MSME 45-day, GSTR-9, Tally
export const getDepositsRequest = async (params = {}) => (await api.get("/accounting/deposits", { params })).data.data;
export const createDepositRequest = async (payload, params = {}) => (await api.post("/accounting/deposits", payload, { params })).data.data;
export const moveDepositRequest = async (id, payload, params = {}) => (await api.post(`/accounting/deposits/${id}/movements`, payload, { params })).data.data;
export const cancelDepositRequest = async (id, params = {}) => (await api.post(`/accounting/deposits/${id}/cancel`, {}, { params })).data.data;
export const getAssetClassesRequest = async () => (await api.get("/accounting/fixed-assets/classes")).data.data;
export const getAssetsRequest = async (params = {}) => (await api.get("/accounting/fixed-assets", { params })).data.data;
export const createAssetRequest = async (payload, params = {}) => (await api.post("/accounting/fixed-assets", payload, { params })).data.data;
export const disposeAssetRequest = async (id, payload, params = {}) => (await api.post(`/accounting/fixed-assets/${id}/dispose`, payload, { params })).data.data;
export const cancelAssetRequest = async (id, params = {}) => (await api.post(`/accounting/fixed-assets/${id}/cancel`, {}, { params })).data.data;
export const getAssetRegisterRequest = async (params = {}) => (await api.get("/accounting/fixed-assets/register", { params })).data.data;
export const getItBlocksRequest = async (params = {}) => (await api.get("/accounting/fixed-assets/it-blocks", { params })).data.data;
export const runDepreciationRequest = async (payload, params = {}) => (await api.post("/accounting/fixed-assets/depreciation", payload, { params })).data.data;
export const getScheduleIIIRequest = async (params = {}) => (await api.get("/accounting/year-end/schedule-iii", { params })).data.data;
export const getMsmeReportRequest = async (params = {}) => (await api.get("/accounting/year-end/msme", { params })).data.data;
export const getGstr9Request = async (params = {}) => (await api.get("/accounting/year-end/gstr9", { params })).data.data;
export const downloadTallyXml = async (params = {}) => (await api.get("/accounting/year-end/tally", { params, responseType: "blob" })).data;
