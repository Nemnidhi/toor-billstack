# Verified TOOR self-hosted baseline

The live reference inspected read-only on 2026-09-30 was
https://billstack.theofficeonrent.com/. No production business/settings changes
were submitted. Credentials and captured live responses are not part of Git.

## Root cause and correction

The existing local demo business was persisted as SAAS with no industry profile,
even though the server environment selected SELF_HOSTED. The demo seed omitted
deploymentMode, so the Business schema's SAAS default took effect. Environment
configuration does not convert an existing business record.

The local demo business was backed up and configured with the existing
self-hosted Real Estate profile service, retaining its ID, customers, invoices,
integration credential and customer mappings. Do not run the destructive demo
seed to repair an existing database. The seed now explicitly persists the chosen
deployment mode and initializes the existing self-hosted profile service, without
creating SaaS subscriptions or retail sample records for SELF_HOSTED demos.

## Actual live boundary

Live navigation has Dashboard, Clients, Invoices, Quotations, Monthly Billing,
Expenses, Reports / GST, Communications and Settings. Settings has Business
Profile, GST & Tax, Invoice & Payment, Branding and Communications.

The live backend module response retains active services/products, payments,
ledger, credit notes, appointments and team modules, including modules omitted
from the primary sidebar. Inventory, suppliers, purchases, sales returns and HR
are AVAILABLE rather than ACTIVE. Local now matches the entire observed live
catalogue and all navigation/settings controls. Removing these shared backend
modules would diverge from the observed live product and risk its billing flows.
No sidebar-only workaround or broad backend deletion was made.

## History and verification limits

The repository already contains self-hosted history including f94bd01, fed7d7d,
35eee49 and later Real Estate/monthly billing fixes through 85878be, followed by
the CRM integration and browser fixes. The exact deployed Git SHA is not exposed
by the live app. A historical frontend rebuild did not establish byte-for-byte
asset identity, so no unverified historical rollback was performed.

Local Chrome verification covered all nine pages, all five settings sections,
exact backend module states, quotation creation, monthly billing save/reload,
invoice editor calculations, Real Estate/Coworking CRM customer selection and
logged-out handoff continuation. Local sync/retries retained the same customer
IDs and one customer per integration identity. Local sample records and uploaded
branding assets are not copies of production data.

Backend suites, frontend regressions and the production frontend build passed.
The backend suite retains 15 pre-existing skipped transaction tests; real local
MongoDB rs0 sync and browser checks were run separately. Invoice amount auto-fill
still awaits billing rules and is not part of this baseline correction.
