const asyncHandler = require("../utils/asyncHandler");
const service = require("../services/workflow.service");

const ok = (res, message, data, status = 200) => res.status(status).json({ message, data });

const createOrder = asyncHandler(async (req, res) => ok(res, "Order created", await service.createOrder({ businessId: req.tenant.businessId, userId: req.user._id, payload: req.body, req }), 201));
const listOrders = asyncHandler(async (req, res) => ok(res, "Orders fetched", await service.listOrders({ businessId: req.tenant.businessId, query: req.query })));
const getOrder = asyncHandler(async (req, res) => ok(res, "Order fetched", await service.getOrder({ businessId: req.tenant.businessId, id: req.params.orderId })));
const updateOrder = asyncHandler(async (req, res) => ok(res, "Order updated", await service.updateOrder({ businessId: req.tenant.businessId, userId: req.user._id, id: req.params.orderId, payload: req.body })));
const setOrderStatus = asyncHandler(async (req, res) => ok(res, "Order status updated", await service.setOrderStatus({ businessId: req.tenant.businessId, userId: req.user._id, id: req.params.orderId, status: req.body.status, req })));
const updateOrderFulfilment = asyncHandler(async (req, res) => ok(res, "Order fulfilment updated", await service.updateOrderFulfilment({ businessId: req.tenant.businessId, userId: req.user._id, id: req.params.orderId, items: req.body.items, req })));
const convertOrderToInvoice = asyncHandler(async (req, res) => ok(res, "Order converted to invoice", await service.convertOrderToInvoice({ businessId: req.tenant.businessId, userId: req.user._id, id: req.params.orderId, req }), 201));

const createProject = asyncHandler(async (req, res) => ok(res, "Project created", await service.createProject({ businessId: req.tenant.businessId, userId: req.user._id, payload: req.body }), 201));
const listProjects = asyncHandler(async (req, res) => ok(res, "Projects fetched", await service.listProjects({ businessId: req.tenant.businessId, query: req.query })));
const getProject = asyncHandler(async (req, res) => ok(res, "Project fetched", await service.getProject({ businessId: req.tenant.businessId, id: req.params.projectId })));
const updateProject = asyncHandler(async (req, res) => ok(res, "Project updated", await service.updateProject({ businessId: req.tenant.businessId, userId: req.user._id, id: req.params.projectId, payload: req.body })));

const createTask = asyncHandler(async (req, res) => ok(res, "Task created", await service.createTask({ businessId: req.tenant.businessId, userId: req.user._id, payload: req.body }), 201));
const listTasks = asyncHandler(async (req, res) => ok(res, "Tasks fetched", await service.listTasks({ businessId: req.tenant.businessId, userId: req.user._id, query: req.query })));
const updateTask = asyncHandler(async (req, res) => ok(res, "Task updated", await service.updateTask({ businessId: req.tenant.businessId, userId: req.user._id, id: req.params.taskId, payload: req.body })));

const createRecurring = asyncHandler(async (req, res) => ok(res, "Recurring profile created", await service.createRecurringProfile({ businessId: req.tenant.businessId, userId: req.user._id, payload: req.body }), 201));
const listRecurring = asyncHandler(async (req, res) => { res.set("Cache-Control", "no-store, no-cache, must-revalidate, private"); return ok(res, "Recurring profiles fetched", await service.listRecurringProfiles({ businessId: req.tenant.businessId, query: req.query })); });
const queryRecurring = asyncHandler(async (req, res) => { res.set("Cache-Control", "no-store, no-cache, must-revalidate, private"); return ok(res, "Recurring profiles fetched", await service.listRecurringProfiles({ businessId: req.tenant.businessId, query: req.body || {} })); });
const getRecurring = asyncHandler(async (req, res) => ok(res, "Recurring profile fetched", await service.getRecurringProfile({ businessId: req.tenant.businessId, id: req.params.profileId })));
const setRecurringCentre = asyncHandler(async (req, res) => ok(res, "Recurring centre updated", await service.setRecurringCentre({ businessId: req.tenant.businessId, userId: req.user._id, id: req.params.profileId, centre: req.body.centre, tags: { businessLine: req.body.businessLine, reportCategory: req.body.reportCategory }, req })));
const setRecurringStatus = asyncHandler(async (req, res) => ok(res, "Recurring status updated", await service.setRecurringStatus({ businessId: req.tenant.businessId, userId: req.user._id, id: req.params.profileId, status: req.body.status, req })));
const generateRecurring = asyncHandler(async (req, res) => ok(res, "Recurring invoice generated", await service.generateRecurringInvoice({ businessId: req.tenant.businessId, userId: req.user._id, id: req.params.profileId, req }), 201));
const deleteRecurring = asyncHandler(async (req, res) => ok(res, "Recurring profile deleted", await service.deleteRecurringProfile({ businessId: req.tenant.businessId, id: req.params.profileId, req })));

const createAppointment = asyncHandler(async (req, res) => ok(res, "Appointment created", await service.createAppointment({ businessId: req.tenant.businessId, userId: req.user._id, payload: req.body, req }), 201));
const listAppointments = asyncHandler(async (req, res) => ok(res, "Appointments fetched", await service.listAppointments({ businessId: req.tenant.businessId, query: req.query })));
const updateAppointment = asyncHandler(async (req, res) => ok(res, "Appointment updated", await service.updateAppointment({ businessId: req.tenant.businessId, userId: req.user._id, id: req.params.appointmentId, payload: req.body, req })));
const setAppointmentStatus = asyncHandler(async (req, res) => ok(res, "Appointment status updated", await service.setAppointmentStatus({ businessId: req.tenant.businessId, userId: req.user._id, id: req.params.appointmentId, status: req.body.status, req })));

module.exports = {
  createAppointment,
  createOrder,
  createProject,
  createRecurring,
  createTask,
  deleteRecurring,
  convertOrderToInvoice,
  generateRecurring,
  getOrder,
  getProject,
  getRecurring,
  listAppointments,
  listOrders,
  listProjects,
  listRecurring,
  queryRecurring,
  listTasks,
  setAppointmentStatus,
  setOrderStatus,
  setRecurringCentre,
  setRecurringStatus,
  updateAppointment,
  updateOrder,
  updateOrderFulfilment,
  updateProject,
  updateTask,
};
