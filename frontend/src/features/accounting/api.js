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

export const downloadExportCsv = async (params = {}) => {
  const response = await api.get("/accounting/reports/export-pack", {
    params: { ...params, format: "csv" },
    responseType: "blob",
  });
  return response.data;
};
