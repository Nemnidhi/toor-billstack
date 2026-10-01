# Local multi-billing-entity phase 1

The existing Business ID remains TOOR. No customer, invoice, payment, expense, CRM credential or mapping is moved or copied. Existing users retain their home business and role. Additional access is an explicit BusinessMembership checked on every request, including refresh and handoff. A user can have a single home entity or authorized access to both.

The primary self-hosted company owner can use **Billing Company Settings ? Enable Goldhawk Infrabulls Pvt. Ltd.** The operation is transactional and idempotent, including concurrent requests. It creates a separate business, copies only the self-hosted module configuration, and grants its initiating owner administrator access. Other employees must be granted access explicitly in these settings. There is no startup seed or automatic entity migration. Company creation requires MongoDB replica-set transactions and the declared Business / BusinessMembership unique indexes.

Use the header switcher to change company without logging out. Switching starts a fresh dashboard page so another entity's open forms cannot be submitted accidentally. Settings edits apply only to the active company. Goldhawk's contact/address/logo/bank details start empty; its name is the requested legal name. Its invoice prefix is editable. Goldhawk GST cannot be enabled through settings, and invoice totals are enforced server-side. TOOR's existing GST settings/calculations are preserved. Customers remain entity-scoped; merely switching never creates or copies one. Cross-entity shared-party routing is not part of this phase.

New invoices capture seller details, GST identity, bank instructions, terms and logo/signature references. Before a company profile is edited, an idempotent conditional backfill freezes missing legacy seller snapshots using existing invoice party details and the pre-edit profile for fields never historically recorded. Existing snapshots, ownership, numbers and financial values are not changed. Referenced branding assets are retained. This cannot reconstruct profile/assets already changed or deleted before this release.

CRM credentials continue to target their existing business. The stored handoff token determines the destination entity; an authenticated user must have access to it before consumption. A handoff may switch an authorized user back to TOOR. It neither logs the user out nor grants entity access. Tokens remain short-lived and one-use. CRM classification routing and amounts are intentionally not added.

## Validation

- Backend: `npm test` and `npm run test:crm` in backend.
- Frontend: `npm test` and `npm run build` in frontend.
- Real HTTP/transaction tests: `npm run test:entities` in backend. Default Mongo is loopback port 27029, replica set rs0; every run creates a new isolated `billstack_phase1_test_*` database and never reads .env or existing application data. The test server uses port 5011.
- Real browser tests: point a separate frontend on port 5184 at `http://127.0.0.1:5011/api`; set `BILLSTACK_PHASE1_UI=http://127.0.0.1:5184` and `BILLSTACK_PLAYWRIGHT_PATH` to an installed Playwright package before `npm run test:entities`. It uses headless Edge and real HTTP/Mongo, not intercepted API fixtures. Test data is retained in the isolated database.

The transaction test explicitly builds its required unique indexes; it does not initialize unrelated legacy indexes containing unsupported partial-filter `$ne` expressions. Those existing index definitions and pre-existing accounting risks (allocation concurrency/cancellation/legacy payment reconciliation) are outside this phase and still require review before production rollout. No deployment or consolidated accounting is included.
