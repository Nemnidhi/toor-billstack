# The Office On Rent local client setup

Canonical repository: https://github.com/Nemnidhi/toor-billstack.git

Local checkout: C:\Users\asus\Desktop\Nemnidhi\toor-billstack

The destination was empty when imported. Its main branch preserves the complete
history through verified client commit c1f701b35946058e100220f91e1c0274d2b8e871.
No SaaS repository changes or production deployment are part of this migration.

## Minimal ignored local configuration

Backend file: backend/.env

```dotenv
NODE_ENV=development
PORT=5001
MONGO_URI=mongodb://127.0.0.1:27019/billstack_crm_e2e_20260929?replicaSet=rs0
JWT_SECRET=<local-only random secret>
CLIENT_URL=http://127.0.0.1:5174
BILLSTACK_DEPLOYMENT_MODE=SELF_HOSTED
```

Frontend file: frontend/.env.local

```dotenv
VITE_API_BASE_URL=http://127.0.0.1:5001/api
VITE_BILLSTACK_DEPLOYMENT_MODE=SELF_HOSTED
```

Both files are ignored. Never commit credentials. No integration API key is
required in the BillStack frontend or environment: the existing local credential
is stored by BillStack and used by the CRM backend. Do not reseed an existing DB.

CRM remains on backend 5000/frontend 5173. Its backend must use
BILLSTACK_BASE_URL=http://127.0.0.1:5001,
BILLSTACK_FRONTEND_URL=http://127.0.0.1:5174,
BILLSTACK_COMPANY_ID=<local CRM company ID>, and
BILLSTACK_API_KEY=<local BillStack integration credential>.

## Start and validate

Run npm ci separately in backend and frontend if dependencies are absent.
Start the backend with node src/server.js from backend (or npm start).
Start the frontend from frontend with:

```sh
npm run dev -- --host 127.0.0.1 --port 5174 --strictPort
```

Use these explicit commands for the integration ports; older convenience scripts
may use different default ports. Stop previous BillStack listeners first.
MongoDB must already be a local rs0 replica set on 27019.

Backend checks: npm test and npm run test:crm.
Frontend checks: node --test test/*.test.cjs and npm run build.
Repository check: git diff --check.

Verify actual browser login, dashboard, customers, invoices, CRM Real Estate and
Coworking Create Invoice actions, correct customer selection, and logged-out
login continuation. Sync each customer again and confirm the same remote ID and
one customer record. Automated backend suites have 15 pre-existing skipped
transaction tests; they do not replace the local replica-set/browser checks.

Invoice handoff currently preselects the customer. Amount/item auto-fill remains
pending the agreed billing rules; users enter invoice items and rates normally.
This setup is for local development, not production deployment.
