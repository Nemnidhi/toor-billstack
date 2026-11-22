const express = require("express");
const controller = require("../controllers/workflow.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const tenantMiddleware = require("../middlewares/tenant.middleware");
const { validateObjectIdParam } = require("../middlewares/object-id.middleware");
const { requireActiveSubscription } = require("../middlewares/subscription.middleware");
const { requireFeature } = require("../middlewares/feature-guard.middleware");
const { requireModule } = require("../middlewares/module-guard.middleware");
const { permit } = require("../middlewares/role.middleware");

const router = express.Router();

router.use(authMiddleware, tenantMiddleware, requireActiveSubscription());

router.get("/orders", requireModule("order_management"), requireFeature("orderManagement"), controller.listOrders);
router.post("/orders", requireModule("order_management"), requireFeature("orderManagement"), permit("owner", "admin", "staff", "accountant"), controller.createOrder);
router.get("/orders/:orderId", validateObjectIdParam("orderId"), requireModule("order_management"), requireFeature("orderManagement"), controller.getOrder);
router.put("/orders/:orderId", validateObjectIdParam("orderId"), requireModule("order_management"), requireFeature("orderManagement"), permit("owner", "admin", "staff"), controller.updateOrder);
router.post("/orders/:orderId/status", validateObjectIdParam("orderId"), requireModule("order_management"), requireFeature("orderManagement"), permit("owner", "admin", "staff"), controller.setOrderStatus);
router.post("/orders/:orderId/fulfilment", validateObjectIdParam("orderId"), requireModule("order_management"), requireFeature("orderManagement"), permit("owner", "admin", "staff"), controller.updateOrderFulfilment);
router.post("/orders/:orderId/convert-invoice", validateObjectIdParam("orderId"), requireModule("order_management"), requireFeature("orderManagement"), permit("owner", "admin", "accountant"), controller.convertOrderToInvoice);

router.get("/projects", requireModule("projects_tasks"), requireFeature("projectsTasks"), controller.listProjects);
router.post("/projects", requireModule("projects_tasks"), requireFeature("projectsTasks"), permit("owner", "admin", "staff"), controller.createProject);
router.get("/projects/:projectId", validateObjectIdParam("projectId"), requireModule("projects_tasks"), requireFeature("projectsTasks"), controller.getProject);
router.put("/projects/:projectId", validateObjectIdParam("projectId"), requireModule("projects_tasks"), requireFeature("projectsTasks"), permit("owner", "admin", "staff"), controller.updateProject);
router.get("/tasks", requireModule("projects_tasks"), requireFeature("projectsTasks"), controller.listTasks);
router.post("/tasks", requireModule("projects_tasks"), requireFeature("projectsTasks"), permit("owner", "admin", "staff"), controller.createTask);
router.put("/tasks/:taskId", validateObjectIdParam("taskId"), requireModule("projects_tasks"), requireFeature("projectsTasks"), permit("owner", "admin", "staff"), controller.updateTask);

router.get("/recurring", requireModule("recurring_billing"), requireFeature("recurringBilling"), controller.listRecurring);
router.post("/recurring/query", requireModule("recurring_billing"), requireFeature("recurringBilling"), controller.queryRecurring);
router.post("/recurring", requireModule("recurring_billing"), requireFeature("recurringBilling"), permit("owner", "admin", "accountant"), controller.createRecurring);
router.get("/recurring/:profileId", validateObjectIdParam("profileId"), requireModule("recurring_billing"), requireFeature("recurringBilling"), controller.getRecurring);
router.post("/recurring/:profileId/centre", validateObjectIdParam("profileId"), requireModule("recurring_billing"), requireFeature("recurringBilling"), permit("owner", "admin", "accountant"), controller.setRecurringCentre);
router.post("/recurring/:profileId/status", validateObjectIdParam("profileId"), requireModule("recurring_billing"), requireFeature("recurringBilling"), permit("owner", "admin", "accountant"), controller.setRecurringStatus);
router.post("/recurring/:profileId/generate", validateObjectIdParam("profileId"), requireModule("recurring_billing"), requireFeature("recurringBilling"), permit("owner", "admin", "accountant"), controller.generateRecurring);
router.delete("/recurring/:profileId", validateObjectIdParam("profileId"), requireModule("recurring_billing"), requireFeature("recurringBilling"), permit("owner", "admin", "accountant"), controller.deleteRecurring);

router.get("/appointments", requireModule("appointments_scheduling"), requireFeature("appointmentsScheduling"), controller.listAppointments);
router.post("/appointments", requireModule("appointments_scheduling"), requireFeature("appointmentsScheduling"), permit("owner", "admin", "staff"), controller.createAppointment);
router.put("/appointments/:appointmentId", validateObjectIdParam("appointmentId"), requireModule("appointments_scheduling"), requireFeature("appointmentsScheduling"), permit("owner", "admin", "staff"), controller.updateAppointment);
router.post("/appointments/:appointmentId/status", validateObjectIdParam("appointmentId"), requireModule("appointments_scheduling"), requireFeature("appointmentsScheduling"), permit("owner", "admin", "staff"), controller.setAppointmentStatus);

module.exports = router;
