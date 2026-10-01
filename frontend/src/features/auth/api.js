import api from "../../api/axios";
export const previewInvoiceTaxRequest = async payload => (await api.post("/invoices/tax-preview", payload)).data.data;

export const registerRequest = async (payload) => {
  const response = await api.post("/auth/register", payload);
  return response.data.data;
};

export const loginRequest = async (payload) => {
  const response = await api.post("/auth/login", payload);
  return response.data.data;
};

export const googleAuthRequest = async (payload) => {
  const response = await api.post("/auth/google", payload);
  return response.data.data;
};

export const forgotPasswordRequest = async (payload) => {
  const response = await api.post("/auth/forgot-password", payload);
  return response.data;
};

export const resetPasswordRequest = async (payload) => {
  const response = await api.post("/auth/reset-password", payload);
  return response.data;
};

export const logoutRequest = async () => {
  await api.post("/auth/logout");
};

export const currentSessionRequest = async () => {
  const response = await api.get("/auth/me");
  return response.data.data;
};

export const updateBusinessSetupRequest = async (payload) => {
  const response = await api.put("/business/setup", payload, {
    headers: {
      "Content-Type": "multipart/form-data",
    },
  });
  return response.data.data;
};

export const getBusinessModulesRequest = async () => {
  const response = await api.get("/modules");
  return response.data.data;
};

export const getIndustryCatalogueRequest = async () => {
  const response = await api.get("/modules/industries");
  return response.data.data;
};

export const workspaceRecommendationRequest = async (payload) => {
  const response = await api.post("/modules/recommendation", payload);
  return response.data.data;
};

export const updateBusinessProfileRequest = async (payload) => {
  const response = await api.put("/modules/profile", payload);
  return response.data.data;
};

export const updateBusinessModuleStateRequest = async (moduleKey, state) => {
  const response = await api.put(`/modules/${moduleKey}`, { state });
  return response.data.data;
};

export const createModuleRequestRequest = async (payload) => {
  const response = await api.post("/modules/requests", payload);
  return response.data.data;
};

export const acceptModuleOfferRequest = async (offerId, payload = {}) => {
  const response = await api.post(`/modules/offers/${offerId}/accept`, payload);
  return response.data.data;
};

export const declineModuleOfferRequest = async (offerId, payload = {}) => {
  const response = await api.post(`/modules/offers/${offerId}/decline`, payload);
  return response.data.data;
};

export const createModuleRazorpayOrderRequest = async (offerId) => {
  const response = await api.post(`/modules/offers/${offerId}/pay/razorpay`);
  return response.data.data;
};

export const submitModuleManualUpiRequest = async (offerId, payload) => {
  const response = await api.post(`/modules/offers/${offerId}/pay/manual-upi`, payload);
  return response.data.data;
};

export const verifyModuleRazorpayPaymentRequest = async (payload) => {
  const response = await api.post("/modules/payments/razorpay/verify", payload);
  return response.data.data;
};

export const listPlansRequest = async () => {
  const response = await api.get("/plans");
  return response.data.data;
};

export const currentPlanRequest = async () => {
  const response = await api.get("/plans/current");
  return response.data.data;
};

export const planRecommendationRequest = async () => {
  const response = await api.get("/business/plan-recommendation");
  return response.data.data;
};

export const createSampleDataRequest = async () => {
  const response = await api.post("/business/sample-data");
  return response.data.data;
};

export const removeSampleDataRequest = async () => {
  const response = await api.delete("/business/sample-data");
  return response.data.data;
};

export const updateBusinessPlanRequest = async (planCode) => {
  const response = await api.put("/business/plan", { planCode });
  return response.data.data;
};

export const listCustomersRequest = async (params) => {
  const response = await api.get("/customers", { params });
  return response.data.data;
};

export const createCustomerRequest = async (payload) => {
  const response = await api.post("/customers", payload);
  return response.data.data;
};

export const updateCustomerRequest = async (customerId, payload) => {
  const response = await api.put(`/customers/${customerId}`, payload);
  return response.data.data;
};

export const deleteCustomerRequest = async (customerId) => {
  await api.delete(`/customers/${customerId}`);
};

export const customerLedgerRequest = async (customerId) => {
  const response = await api.get(`/customers/${customerId}/ledger`);
  return response.data.data;
};

export const customerStatementRequest = async (customerId, params) => {
  const response = await api.get(`/customers/${customerId}/statement`, { params });
  return response.data.data;
};

export const customerStatementCsvRequest = async (customerId, params) => {
  const response = await api.get(`/customers/${customerId}/statement.csv`, { params, responseType: "blob" });
  return response.data;
};

export const customerStatementPdfRequest = async (customerId, params) => {
  const response = await api.get(`/customers/${customerId}/statement.pdf`, { params, responseType: "blob" });
  return response.data;
};

export const listPaymentsRequest = async (params) => {
  const response = await api.get("/payments", { params });
  return response.data.data;
};

export const createPaymentRequest = async (payload) => {
  const response = await api.post("/payments", payload);
  return response.data.data;
};


export const getCustomerAdvancesRequest = async (customerId) => {
  const response = await api.get(`/payments/customer/${customerId}/advances`);
  return response.data.data;
};

export const reissueInvoiceRequest = async (invoiceId, payload = {}) => {
  const response = await api.post(`/invoices/${invoiceId}/reissue`, payload);
  return response.data.data;
};

export const allocatePaymentRequest = async (paymentId, payload) => {
  const response = await api.post(`/payments/${paymentId}/allocate`, payload);
  return response.data.data;
};

export const reversePaymentAllocationRequest = async (allocationId, payload) => {
  const response = await api.post(`/payments/allocations/${allocationId}/reverse`, payload);
  return response.data.data;
};

export const listProductsRequest = async (params) => {
  const response = await api.get("/products", { params });
  return response.data.data;
};

export const createProductRequest = async (payload) => {
  const response = await api.post("/products", payload);
  return response.data.data;
};

export const updateProductRequest = async (productId, payload) => {
  const response = await api.put(`/products/${productId}`, payload);
  return response.data.data;
};

export const deleteProductRequest = async (productId) => {
  await api.delete(`/products/${productId}`);
};

export const listProductMovementsRequest = async (productId, params) => {
  const response = await api.get(`/products/${productId}/movements`, { params });
  return response.data.data;
};

export const createProductMovementRequest = async (productId, payload) => {
  const response = await api.post(`/products/${productId}/movements`, payload);
  return response.data.data;
};

export const listSuppliersRequest = async (params) => {
  const response = await api.get("/suppliers", { params });
  return response.data.data;
};

export const createSupplierRequest = async (payload) => {
  const response = await api.post("/suppliers", payload);
  return response.data.data;
};

export const updateSupplierRequest = async (supplierId, payload) => {
  const response = await api.put(`/suppliers/${supplierId}`, payload);
  return response.data.data;
};

export const deleteSupplierRequest = async (supplierId) => {
  await api.delete(`/suppliers/${supplierId}`);
};

export const listPurchasesRequest = async (params) => {
  const response = await api.get("/purchases", { params });
  return response.data.data;
};

export const listExpensesRequest = async (params) => {
  const response = await api.get("/expenses", { params });
  return response.data.data;
};

export const expenseSummaryRequest = async (params) => {
  const response = await api.get("/expenses/summary", { params });
  return response.data.data;
};

export const expenseCategoriesRequest = async () => {
  const response = await api.get("/expenses/categories");
  return response.data.data;
};

export const getExpenseRequest = async (expenseId) => {
  const response = await api.get(`/expenses/${expenseId}`);
  return response.data.data;
};

export const createExpenseRequest = async (payload) => {
  const response = await api.post("/expenses", payload);
  return response.data.data;
};

export const updateExpenseRequest = async (expenseId, payload) => {
  const response = await api.put(`/expenses/${expenseId}`, payload);
  return response.data.data;
};

export const cancelExpenseRequest = async (expenseId, reason = "") => {
  const response = await api.post(`/expenses/${expenseId}/cancel`, { reason });
  return response.data.data;
};

export const createPurchaseRequest = async (payload) => {
  const response = await api.post("/purchases", payload);
  return response.data.data;
};

export const listPurchaseAllocationsRequest = async (purchaseId) => {
  const response = await api.get(`/purchases/${purchaseId}/allocations`);
  return response.data.data;
};

export const listInvoicesRequest = async (params) => {
  const response = await api.get("/invoices", { params });
  return response.data.data;
};

export const getInvoiceRequest = async (invoiceId) => {
  const response = await api.get(`/invoices/${invoiceId}`);
  return response.data.data;
};

export const listInvoiceAllocationsRequest = async (invoiceId) => {
  const response = await api.get(`/invoices/${invoiceId}/allocations`);
  return response.data.data;
};

export const createInvoiceRequest = async (payload) => {
  const response = await api.post("/invoices", payload);
  return response.data.data;
};

export const updateInvoiceRequest = async (invoiceId, payload) => {
  const response = await api.put(`/invoices/${invoiceId}`, payload);
  return response.data.data;
};

export const cancelInvoiceRequest = async (invoiceId) => {
  await api.post(`/invoices/${invoiceId}/cancel`);
};

export const downloadInvoicePdfRequest = async (invoiceId, download = false) => {
  const response = await api.get(`/invoices/${invoiceId}/pdf`, {
    params: { download },
    responseType: "blob",
  });
  return response.data;
};

export const emailInvoiceRequest = async (invoiceId, toEmail) => {
  await api.post(`/invoices/${invoiceId}/share/email`, { toEmail });
};

export const getEInvoiceDetailsRequest = async (invoiceId) => {
  const response = await api.get(`/invoices/${invoiceId}/e-invoice`);
  return response.data.data;
};

export const checkEInvoiceReadinessRequest = async (invoiceId) => {
  const response = await api.post(`/invoices/${invoiceId}/e-invoice/check`);
  return response.data.data;
};

export const prepareEInvoicePayloadRequest = async (invoiceId) => {
  const response = await api.post(`/invoices/${invoiceId}/e-invoice/prepare`);
  return response.data.data;
};

export const gstSummaryRequest = async (params) => {
  const response = await api.get("/gst/summary", { params });
  return response.data.data;
};

export const communicationSummaryRequest = async () => {
  const response = await api.get("/communications/summary");
  return response.data.data;
};

export const listIntegrationCredentialsRequest = async () => {
  const response = await api.get("/integrations/credentials");
  return response.data.data;
};

export const createIntegrationCredentialRequest = async (payload) => {
  const response = await api.post("/integrations/credentials", payload);
  return response.data.data;
};

export const revokeIntegrationCredentialRequest = async (credentialId) => {
  const response = await api.post(`/integrations/credentials/${credentialId}/revoke`);
  return response.data.data;
};

export const listIntegrationEventsRequest = async (params) => {
  const response = await api.get("/integrations/events", { params });
  return response.data.data;
};

export const communicationTemplatesRequest = async () => {
  const response = await api.get("/communications/templates");
  return response.data.data;
};

export const communicationRulesRequest = async () => {
  const response = await api.get("/communications/rules");
  return response.data.data;
};

export const createCommunicationRuleRequest = async (payload) => {
  const response = await api.post("/communications/rules", payload);
  return response.data.data;
};

export const communicationScheduledRequest = async (params) => {
  const response = await api.get("/communications/scheduled", { params });
  return response.data.data;
};

export const communicationDeliveriesRequest = async (params) => {
  const response = await api.get("/communications/deliveries", { params });
  return response.data.data;
};

export const sendInvoiceCommunicationRequest = async (invoiceId, payload) => {
  const response = await api.post(`/communications/invoices/${invoiceId}/send`, payload);
  return response.data.data;
};

export const scheduleInvoiceReminderRequest = async (invoiceId, payload) => {
  const response = await api.post(`/communications/invoices/${invoiceId}/reminders`, payload);
  return response.data.data;
};

export const upsertCommunicationTemplateRequest = async (payload) => {
  const response = await api.post("/communications/templates", payload);
  return response.data.data;
};

export const listQuotesRequest = async () => {
  const response = await api.get("/quotes");
  return response.data.data;
};

export const getQuoteRequest = async (quoteId) => {
  const response = await api.get(`/quotes/${quoteId}`);
  return response.data.data;
};

export const downloadQuotePdfRequest = async (quoteId) => {
  const response = await api.get(`/quotes/${quoteId}/pdf`, { responseType: "blob" });
  return response.data;
};

export const createQuoteRequest = async (payload) => {
  const response = await api.post("/quotes", payload);
  return response.data.data;
};

export const updateQuoteRequest = async (quoteId, payload) => {
  const response = await api.put(`/quotes/${quoteId}`, payload);
  return response.data.data;
};

export const updateQuoteStatusRequest = async (quoteId, status) => {
  const response = await api.post(`/quotes/${quoteId}/status`, { status });
  return response.data.data;
};

export const convertQuoteRequest = async (quoteId) => {
  const response = await api.post(`/quotes/${quoteId}/convert`);
  return response.data.data;
};

export const sendQuoteCommunicationRequest = async (quoteId, payload) => {
  const response = await api.post(`/communications/quotes/${quoteId}/send`, payload);
  return response.data.data;
};

export const listCreditNotesRequest = async () => {
  const response = await api.get("/sales/credit-notes");
  return response.data.data;
};

export const getCreditNoteRequest = async (creditNoteId) => {
  const response = await api.get(`/sales/credit-notes/${creditNoteId}`);
  return response.data.data;
};

export const createCreditNoteRequest = async (payload) => {
  const response = await api.post("/sales/credit-notes", payload);
  return response.data.data;
};

export const listSalesReturnsRequest = async () => {
  const response = await api.get("/sales/returns");
  return response.data.data;
};

export const getSalesReturnRequest = async (returnId) => {
  const response = await api.get(`/sales/returns/${returnId}`);
  return response.data.data;
};

export const createSalesReturnRequest = async (payload) => {
  const response = await api.post("/sales/returns", payload);
  return response.data.data;
};

export const listOrdersRequest = async (params) => {
  const response = await api.get("/workflows/orders", { params });
  return response.data.data;
};

export const getOrderRequest = async (orderId) => {
  const response = await api.get(`/workflows/orders/${orderId}`);
  return response.data.data;
};

export const createOrderRequest = async (payload) => {
  const response = await api.post("/workflows/orders", payload);
  return response.data.data;
};

export const updateOrderStatusRequest = async (orderId, status) => {
  const response = await api.post(`/workflows/orders/${orderId}/status`, { status });
  return response.data.data;
};

export const updateOrderFulfilmentRequest = async (orderId, items) => {
  const response = await api.post(`/workflows/orders/${orderId}/fulfilment`, { items });
  return response.data.data;
};

export const convertOrderToInvoiceRequest = async (orderId) => {
  const response = await api.post(`/workflows/orders/${orderId}/convert-invoice`);
  return response.data.data;
};

export const listProjectsRequest = async (params) => {
  const response = await api.get("/workflows/projects", { params });
  return response.data.data;
};

export const createProjectRequest = async (payload) => {
  const response = await api.post("/workflows/projects", payload);
  return response.data.data;
};

export const updateProjectRequest = async (projectId, payload) => {
  const response = await api.put(`/workflows/projects/${projectId}`, payload);
  return response.data.data;
};

export const listTasksRequest = async (params) => {
  const response = await api.get("/workflows/tasks", { params });
  return response.data.data;
};

export const createTaskRequest = async (payload) => {
  const response = await api.post("/workflows/tasks", payload);
  return response.data.data;
};

export const updateTaskRequest = async (taskId, payload) => {
  const response = await api.put(`/workflows/tasks/${taskId}`, payload);
  return response.data.data;
};

export const listRecurringProfilesRequest = async (params) => {
  const response = await api.get("/workflows/recurring", {
    params: { ...(params || {}), _ts: Date.now() },
  });
  return response.data.data;
};

export const createRecurringProfileRequest = async (payload) => {
  const response = await api.post("/workflows/recurring", payload);
  return response.data.data;
};

export const updateRecurringStatusRequest = async (profileId, status) => {
  const response = await api.post(`/workflows/recurring/${profileId}/status`, { status });
  return response.data.data;
};

export const generateRecurringInvoiceRequest = async (profileId) => {
  const response = await api.post(`/workflows/recurring/${profileId}/generate`);
  return response.data.data;
};

export const deleteRecurringProfileRequest = async (profileId) => {
  const response = await api.delete(`/workflows/recurring/${profileId}`);
  return response.data.data;
};

export const resolveInvoiceHandoffRequest = async (token) => {
  const response = await api.get(`/integrations/handoffs/invoice/${encodeURIComponent(token)}`);
  return response.data.data;
};

export const listAppointmentsRequest = async (params) => {
  const response = await api.get("/workflows/appointments", { params });
  return response.data.data;
};

export const createAppointmentRequest = async (payload) => {
  const response = await api.post("/workflows/appointments", payload);
  return response.data.data;
};

export const updateAppointmentRequest = async (appointmentId, payload) => {
  const response = await api.put(`/workflows/appointments/${appointmentId}`, payload);
  return response.data.data;
};

export const updateAppointmentStatusRequest = async (appointmentId, status) => {
  const response = await api.post(`/workflows/appointments/${appointmentId}/status`, { status });
  return response.data.data;
};

export const listProductionJobsRequest = async (params) => {
  const response = await api.get("/shared-operations/production-jobs", { params });
  return response.data.data;
};

export const createProductionJobRequest = async (payload) => {
  const response = await api.post("/shared-operations/production-jobs", payload);
  return response.data.data;
};

export const updateProductionJobStatusRequest = async (jobId, status) => {
  const response = await api.post(`/shared-operations/production-jobs/${jobId}/status`, { status });
  return response.data.data;
};

export const listBatchesRequest = async (params) => {
  const response = await api.get("/shared-operations/batches", { params });
  return response.data.data;
};

export const createBatchRequest = async (payload) => {
  const response = await api.post("/shared-operations/batches", payload);
  return response.data.data;
};

export const updateBatchStatusRequest = async (batchId, status) => {
  const response = await api.post(`/shared-operations/batches/${batchId}/status`, { status });
  return response.data.data;
};

export const listDispatchesRequest = async (params) => {
  const response = await api.get("/shared-operations/dispatches", { params });
  return response.data.data;
};

export const createDispatchRequest = async (payload) => {
  const response = await api.post("/shared-operations/dispatches", payload);
  return response.data.data;
};

export const updateDispatchStatusRequest = async (dispatchId, status) => {
  const response = await api.post(`/shared-operations/dispatches/${dispatchId}/status`, { status });
  return response.data.data;
};

export const listApprovalDocumentsRequest = async (params) => {
  const response = await api.get("/shared-operations/approval-documents", { params });
  return response.data.data;
};

export const createApprovalDocumentRequest = async (payload) => {
  const response = await api.post("/shared-operations/approval-documents", payload);
  return response.data.data;
};

export const updateApprovalDocumentStatusRequest = async (documentId, status) => {
  const response = await api.post(`/shared-operations/approval-documents/${documentId}/status`, { status });
  return response.data.data;
};

export const dashboardSummaryRequest = async () => {
  const response = await api.get("/dashboard/summary");
  return response.data.data;
};

export const reportsSummaryRequest = async (params = {}) => {
  const response = await api.get("/reports/summary", { params });
  return response.data.data;
};

export const currentSubscriptionRequest = async () => {
  const response = await api.get("/billing/subscription");
  return response.data.data;
};

export const createSubscriptionRequest = async (payload) => {
  const response = await api.post("/billing/subscription", payload);
  return response.data.data;
};

export const verifySubscriptionPaymentRequest = async (payload) => {
  const response = await api.post("/billing/subscription/verify", payload);
  return response.data.data;
};

export const changeSubscriptionPlanRequest = async (payload) => {
  const response = await api.post("/billing/subscription/change-plan", payload);
  return response.data.data;
};

export const listTeamMembersRequest = async (params) => {
  const response = await api.get("/team", { params });
  return response.data.data;
};

export const createTeamMemberRequest = async (payload) => {
  const response = await api.post("/team", payload);
  return response.data.data;
};

export const updateTeamMemberRequest = async (userId, payload) => {
  const response = await api.put(`/team/${userId}`, payload);
  return response.data.data;
};

export const deleteTeamMemberRequest = async (userId) => {
  await api.delete(`/team/${userId}`);
};
