# BillStack

This is the canonical self-hosted BillStack client repository for The Office On Rent: `Nemnidhi/toor-billstack`. Continue client development here, not in the SaaS repository or the superseded `billstack-toor` copy. The complete verified client Git history is preserved.

See [local client setup](docs/TOOR-Local-Setup.md) for the minimal local configuration and verification commands.

BillStack is a multi-tenant MERN SaaS billing platform with authentication, subscriptions, inventory, purchases, invoices, PDF sharing, analytics, and a platform-level super admin panel.

## Folder Structure

```text
billstack/
  backend/
    src/
      config/         DB, upload, CORS config
      constants/      Plans and roles
      controllers/    Route handlers
      middlewares/    Auth, tenant, feature, subscription, validation, security
      models/         Mongoose schemas
      routes/         Express route modules
      scripts/        Seed script
      services/       Auth, inventory, email, Razorpay, super admin services
      utils/          Shared helpers for plans, invoices, PDF, queries, subscriptions
      validators/     Input validators
      app.js          Express app wiring
      server.js       App bootstrap
    tests/            Node test runner smoke coverage
  frontend/
    src/
      api/            Axios setup
      app/            Root layout/providers
      components/     Shared layout/UI components
      features/       Auth, dashboard, super admin modules
      router/         React Router config
      store/          Zustand stores for auth, super admin, UI
      index.css       Tailwind entry + theme tokens
```

## Run Locally

### 1. One command for both apps

```powershell
cd c:\Users\asus\Desktop\Nemnidhi\billstack
npm run dev
```

This opens separate PowerShell windows for:
- backend on `http://localhost:5000`
- frontend on `http://localhost:5173`

If either app is already running on its port, the root launcher skips starting a duplicate.

Additional workspace commands:

```powershell
npm run status
npm run stop
npm run restart
```

- `status`: shows whether backend/frontend ports are live
- `stop`: stops processes listening on ports `5000` and `5173`
- `restart`: stops both apps and launches them again

### 2. Backend

```powershell
cd c:\Users\asus\Desktop\Nemnidhi\billstack\backend
npm install
npm run dev
```

API default: `http://localhost:5000`

### 3. Frontend

```powershell
cd c:\Users\asus\Desktop\Nemnidhi\billstack\frontend
npm install
npm run dev
```

App default: `http://localhost:5173`

### 4. Optional seed data

```powershell
cd c:\Users\asus\Desktop\Nemnidhi\billstack\backend
npm run seed
```

Seeded login:
- Business slug: `billstack-demo`
- Owner: `owner@billstack.demo` / `password123`
- Admin: `admin@billstack.demo` / `password123`

### 5. Tests

```powershell
cd c:\Users\asus\Desktop\Nemnidhi\billstack\backend
npm test
```

## Environment Variables

### Backend

Create `backend/.env` directly for local setup, and use the same keys as server environment variables for production deployment.

- `PORT`: API port
- `NODE_ENV`: `development` or `production`
- `CLIENT_URL`: allowed frontend origin for CORS, can be comma-separated
- `BASE_URL`: backend base URL
- `MONGO_URI`: MongoDB connection string
- `JWT_SECRET`: access token signing secret
- `SUPER_ADMIN_JWT_SECRET`: super admin token signing secret
- `SUPER_ADMIN_EMAIL`: platform owner login
- `SUPER_ADMIN_PASSWORD`: platform owner password
- `JWT_ACCESS_EXPIRES_IN`: access token expiry, example `15m`
- `JWT_REFRESH_EXPIRES_DAYS`: refresh cookie lifetime in days
- `REFRESH_COOKIE_NAME`: refresh token cookie key
- `AUTH_RATE_LIMIT_MAX`: auth requests per 15-minute window
- `API_RATE_LIMIT_MAX`: API requests per 15-minute window
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`: invoice email config
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`: Razorpay integration
- `RAZORPAY_PLAN_BASIC_ID`, `RAZORPAY_PLAN_PRO_ID`, `RAZORPAY_PLAN_ENTERPRISE_ID`: mapped paid plans

### Production Mongo URI Examples

If you deploy MongoDB on the same VPS as the backend, use a replica set because BillStack uses MongoDB transactions for purchases and invoices.

Recommended VPS URI with auth:

```env
MONGO_URI=mongodb://billstack_user:replace_with_db_password@127.0.0.1:27017/billstack?authSource=admin&replicaSet=rs0
```

Local-only URI shape without auth:

```env
MONGO_URI=mongodb://127.0.0.1:27017/billstack?replicaSet=rs0
```

Atlas URI shape:

```env
MONGO_URI=mongodb+srv://db_user:db_password@cluster0.xxxxx.mongodb.net/billstack?retryWrites=true&w=majority&appName=Cluster0
```

For VPS Mongo, the minimum production setup is:

1. Install MongoDB on the VPS.
2. Enable a single-node replica set, usually `rs0`.
3. Create a DB user such as `billstack_user`.
4. Use the auth + replica-set URI in the backend production env.

### Frontend

Create `frontend/.env` directly for local setup, and use the same key on your deployed frontend environment.

- `VITE_API_BASE_URL`: API base URL, default `http://localhost:5000/api`

## Main API Endpoints

### Auth

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `GET /api/auth/me`

### Business and Plans

- `GET /api/business/me`
- `PUT /api/business/setup`
- `PUT /api/business/plan`
- `GET /api/plans`
- `GET /api/plans/current`

### Customers, Products, Suppliers, Purchases

- `GET/POST/PUT/DELETE /api/customers`
- `GET/POST/PUT/DELETE /api/products`
- `GET/POST /api/products/:productId/movements`
- `GET/POST/PUT/DELETE /api/suppliers`
- `GET/POST /api/purchases`

### Invoices and Sharing

- `GET/POST/PUT /api/invoices`
- `POST /api/invoices/:invoiceId/cancel`
- `GET /api/invoices/:invoiceId/pdf`
- `POST /api/invoices/:invoiceId/share/email`

### Dashboard and Reports

- `GET /api/dashboard/summary`
- `GET /api/reports/summary`

### Billing

- `GET /api/billing/subscription`
- `POST /api/billing/subscription`
- `POST /api/billing/subscription/verify`
- `POST /api/billing/subscription/change-plan`
- `POST /api/billing/webhook`

### Super Admin

- `POST /api/super-admin/login`
- `GET /api/super-admin/overview`
- `GET /api/super-admin/businesses`
- `POST /api/super-admin/businesses/:businessId/toggle-status`
- `POST /api/super-admin/businesses/:businessId/plan`

## Production Readiness Additions

- Helmet security headers
- CORS with explicit origin allowlist
- Auth and API rate limiting
- Request body sanitization and validation
- Refresh token rotation with reuse detection
- ObjectId guard middleware to reduce IDOR-style probing and cast errors
- Indexed tenant-critical collections
- Seed script and backend smoke tests
- Toast notifications, loading states, empty states, error states
- Route-level code splitting with lazy-loaded screens
- Custom route error and 404 pages
- Root-level start, stop, restart, and status scripts
- Responsive tenant navigation with mobile sidebar
- Theme persistence with dark-mode support
- Lightweight request and error log files under `backend/logs`

## Multi-Tenancy Enforcement

Every protected tenant route goes through auth plus tenant middleware:

1. JWT access token contains `businessId`.
2. `tenant.middleware.js` compares `x-business-id` and route business scope against the token business.
3. Controllers query records with `{ businessId: req.tenant.businessId }`.
4. Invalid ObjectIds are rejected before hitting Mongoose queries.
5. If a business is disabled by the platform owner, auth middleware blocks access.

Result: one business cannot read or mutate another business's data through normal API flows.

## Inventory Stock Update Logic

Stock changes are centralized in [inventory.service.js](c:/Users/asus/Desktop/Nemnidhi/billstack/backend/src/services/inventory.service.js).

- `IN`, `RETURN`: increase stock
- `OUT`, `DAMAGED`: decrease stock
- `ADJUSTMENT`: sets stock directly
- `OPENING`: sets initial stock directly

Rules:

- If `trackInventory` is false, movement is rejected.
- If negative stock is disabled for the business, stock cannot drop below zero.
- Every stock change writes a `StockMovement` record with previous stock, new stock, type, reason, reference, and actor.
- Purchases increase stock in MongoDB transactions.
- Invoice create reduces stock, invoice cancel restores stock, and invoice edit applies only the stock difference.

## SaaS Plan Limit Logic

Plan definitions live in [plans.js](c:/Users/asus/Desktop/Nemnidhi/billstack/backend/src/constants/plans.js).

- `Free`: 20 invoices/month, limited staff, no inventory/reports/templates/sharing
- `Basic`
- `Pro`
- `Enterprise`

Enforcement happens in [feature-guard.middleware.js](c:/Users/asus/Desktop/Nemnidhi/billstack/backend/src/middlewares/feature-guard.middleware.js) and subscription helpers:

- `requireFeature("inventory" | "reports" | "pdfTemplates" | "sharing")`
- `requireInvoiceCapacity()`
- `requireStaffCapacity()`
- `requireActiveSubscription()`

The middleware checks:

1. Business plan
2. Current subscription accessibility
3. Current month invoice usage
4. Plan feature flags
5. Staff count caps

Free plan is capped at exactly 20 invoices per month.

## Important Notes

- MongoDB transactions for purchases and invoice stock updates require a replica set, even locally.
- To email invoices, fill SMTP values in `backend/.env`.
- To test Razorpay subscriptions, fill the Razorpay keys and plan IDs in `backend/.env`.
- Super admin login uses the credentials defined in `backend/.env`.
