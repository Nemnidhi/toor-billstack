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
