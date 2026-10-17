# Thread & Form Showroom Inventory

A simple inventory workspace for a clothing showroom. Phase 1 covers product designs, sizes and colours, available stock, buying and selling prices, suppliers, categories, stock movement history, low stock, old stock, and CSV export. It does not include billing, sales, accounting, authentication, or photo uploads.

See [the project flow and decisions guide](docs/PROJECT_FLOW.md) for the implementation steps and workflow diagrams.

This repository was created separately at `Desktop/vs/showroom-inventory`. Existing projects in `Desktop/vs` were inspected for context and left unchanged.

## Project Flow

The normal way to start the application is:

1. Install Node.js 20 or newer and PostgreSQL 14 or newer.
2. Create a PostgreSQL database named `showroom_inventory`.
3. Copy `.env.example` to `backend/.env` and set `DATABASE_URL` to the local database. `CLIENT_ORIGIN` and `PORT` have local development defaults.
4. Install the project packages from this directory with `npm install`.
5. From this directory, run `npm --prefix backend run prisma:migrate` to create the database tables.
6. Run `npm run dev`. The API starts at `http://localhost:4000`; Vite starts at `http://localhost:5173` and forwards `/api` requests to the API.
7. Add a category, then add a product and its size/colour variants. A quantity above zero becomes both a stock batch and an `OPENING` movement.
8. Use product details to receive stock or make a counted correction. The API updates the balance, receipt batches, and movement history in one database transaction.
9. The dashboard and reports read from PostgreSQL. CSV export downloads the active inventory; it does not change quantities.

## Architecture

```text
Browser (React + TypeScript + Vite)
  ├─ dashboard, inventory, product form/details, old-stock report, directories
  └─ /api requests through Vite development proxy
             ↓
Express + TypeScript API (Zod validation, Helmet, configured CORS)
             ↓ Prisma ORM and PostgreSQL transactions
PostgreSQL
  ├─ Product ── Category / optional Supplier
  ├─ Product ── Variant (SKU, size, colour, quantity, prices, threshold)
  ├─ Variant ── StockBatch (remaining count, receipt date, cost)
  └─ Variant ── InventoryMovement (before, delta, after, reason, timestamp)
```

### Main screens

- **Dashboard**: live product and piece counts, known inventory cost, missing-cost count, low-stock and out-of-stock counts, stock received over 90 days ago, recently added products, and quick actions. It shows a first-product empty state when the database has no active inventory.
- **All products**: search by design name/code, filter by category and stock status, navigate pages, open product detail, and export CSV.
- **Stock management**: find a design or exact variant, then record a receipt, return, damage, missing piece, or stock count correction with a required reason.
- **Add product**: one product form with an editable row for each size/colour variant. Product code is suggested; variant SKU, quantity, prices, and reorder level are entered per row.
- **Product details**: variants and quantities, prices, movement history, edit product details, archive, adjust stock, and add variants.
- **Old stock**: choose 30, 60, 90, or 180 days and see remaining quantities from receipt batches older than the selected age. It does not claim sales activity because sales are not recorded. The report can also be exported as CSV.
- **Categories and suppliers**: create and archive showroom categories and supplier directory entries.

## Important data decisions

- **Product and variant are separate.** The design code belongs to a product; every separately tracked size/colour gets a unique SKU and quantity.
- **Prices are integer paise.** The browser accepts rupees and converts to paise; the API and database never use floating point for stored money.
- **Stock movements are append only.** Each adjustment records its type, signed quantity change, before/after balances, explanation, and timestamp. Product archive only marks a product inactive and leaves history intact.
- **Receipt batches retain age and cost.** Each opening quantity and later receipt gets its own batch. Old stock is computed from the still-remaining part of each batch, so a new delivery does not reset the age of older pieces.
- **Inventory value reports unknown costs.** It values known remaining batch quantities and separately counts variants whose remaining quantities include missing cost data.
- **Every stock update is transactional.** The variant balance, batch quantities, and movement ledger commit together or roll back together. Reductions consume oldest batches first and cannot take stock below zero.
- **Categories and suppliers are kept as separate records.** This allows product filtering and keeps product detail fields consistent.
- **No sample showroom inventory is seeded.** The first dashboard reflects real database rows, not fabricated metrics.

## Setup

Prerequisites: Node.js 20+, npm 10+, and PostgreSQL 14+. Create the database with your local PostgreSQL tools, for example:

```sh
createdb showroom_inventory
cp .env.example backend/.env
```

Edit `backend/.env` and set a private local connection string:

```dotenv
DATABASE_URL="postgresql://YOUR_USER:YOUR_PASSWORD@localhost:5432/showroom_inventory?schema=public"
PORT=4000
CLIENT_ORIGIN=http://localhost:5173
NODE_ENV=development
```

Then install, migrate, and start:

```sh
npm install
npm --prefix backend run prisma:generate
npm --prefix backend run prisma:migrate
npm run dev
```

Open `http://localhost:5173`. The API health check is `http://localhost:4000/api/health`.

## Developer commands

```sh
npm run dev                 # Start API and Vite together
npm run typecheck           # Check both TypeScript projects
npm run build               # Build API and frontend for production
npm test                    # Run API business-rule tests
npm --prefix backend run prisma:studio  # Browse local data with Prisma Studio
```

The automated API rule tests cover quantity changes, prevention of negative stock, stock status labels, SKU normalization/duplicates, cost totals with missing costs, old batch classification, and oldest-first batch reductions. PostgreSQL-backed API/transaction tests still need to be added and run against a configured test database; this environment did not have a PostgreSQL server configured.

For a production build, run `npm run build`, set production environment variables, apply migrations with `npm --prefix backend run prisma:deploy`, and start the compiled API with `npm --prefix backend start`. Serve `frontend/dist` from a web server that proxies `/api` to the API. This repository does not configure a production host or TLS.

## Database migrations

The source schema is `backend/prisma/schema.prisma`; the initial SQL migration is in `backend/prisma/migrations/20261017000000_init/`.

- Local development: `npm --prefix backend run prisma:migrate`
- Production: `npm --prefix backend run prisma:deploy`
- Regenerate Prisma client: `npm --prefix backend run prisma:generate`

Never edit an already-applied migration in a deployed database. Add a new migration when the schema changes.

## API overview

- `GET /api/health`
- `GET /api/dashboard`
- `GET /api/products?search=&categoryId=&supplierId=&status=&page=&limit=`
- `GET /api/sizes`
- `POST /api/products`, `GET /api/products/:id`, `PATCH /api/products/:id`, `POST /api/products/:id/archive`
- `POST /api/products/:id/variants`
- `POST /api/variants/:id/movements`, `GET /api/products/:id/movements`
- `GET /api/old-stock?days=90`
- `GET|POST /api/categories`, `PATCH /api/categories/:id`
- `GET|POST /api/suppliers`, `PATCH /api/suppliers/:id`
- `GET /api/export.csv`
- `GET /api/old-stock.csv?days=90`

Request input is validated on the API with Zod. Errors use a JSON `error` message and validation errors include structured details. Duplicate product or variant codes return HTTP 409.

## CSV export and import

Use **Export CSV** on All products to download product and variant information. Money columns in the CSV are integer paise. CSV import is intentionally not implemented in Phase 1; there is no silent quantity overwrite or paper-history import.

## Backups and restore

Backups are not configured by this project. For a local manual backup, run `pg_dump` against the configured database and store the backup in a protected location outside the source repository. To restore, create an empty database and use `pg_restore` for a custom-format dump (or `psql` for a plain SQL dump). Test a restore periodically before relying on a backup. Do not put production credentials or backup data in Git.

## Security and known limitations

- There is no login or role management. The API binds to loopback by default. Keep it on the local machine; do not expose it publicly or enter real business data on a public host until authentication, authorization, HTTPS, and operational backups are added.
- Product image URL is stored as optional text, but there is no upload/storage service. Use a trusted URL only if the image is hosted elsewhere.
- Stock movement user is not captured because authentication is not implemented.
- Sales and sales dates are absent, so the old-stock screen reports receipt age, not time since sale.
- Old-stock age is based on available batch data created by this application. Paper-era history is not inferred or imported.
- CSV import, bulk editing, custom date ranges, and multi-user concurrency/identity features are future work.
- The UI is designed for a single shop and one inventory location.

## Suggested next phases

1. Add authentication and user attribution to stock movements before any public or multi-user deployment.
2. Add CSV template, validation preview, and explicit import review without overwriting quantities.
3. Add sales records if time-since-sale reporting is required.
4. Add managed photo storage and verified scheduled database backups.
5. Add a physical stock count workflow and deployment configuration.
