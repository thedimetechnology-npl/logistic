# Mariyam Motors — Motorcycle Parts & Accessories Portal

PAN 123456789 • Nepal VAT 13% • 1-2 Godowns • B2B Dispatch to Dealers • 5000+ SKUs • Barcode • R2 Backup

Built as single-file frontend (`index.html`) + Cloudflare Worker + D1 (`worker/`). Same stack as TDT-PMS.

## Structure
```
Logistic/
├── index.html          # Frontend — all modules
└── worker/
    ├── src/index.js    # D1 backend getAll/saveAll
    ├── wrangler.toml   # name=moto-logistics
    ├── package.json
    └── .gitignore
```

## Features
- **Masters:** Categories, Brands, Units, Godowns (Main/Secondary), Parts (SKU, OEM, HSN, MRP, Cost, Min Stock, Barcode CODE128, per-godown stock)
- **Godown / Stock:** Stock ledger, Stock In, Adjust, Transfer A↔B, valuation
- **Vendors:** PAN/VAT, due
- **Dealers (B2B):** credit limit, due
- **Purchase Orders:** Vendor → Godown, VAT per line, Receive → auto GRN → Purchase Invoice
- **Dispatch:** Dealer → Challan, godown stock deduction, vehicle/LR, auto Sales Invoice
- **Finance Nepal VAT 13%:** Sales/Purchase Invoices (taxable+VAT+total), Payments, Expenses, VAT Report (payable), P&L, Stock Valuation
- **Import/Export:** Excel .xlsx for parts (sku,name,category,brand,oem,mrp,cost,unit,godownA,godownB,minStock), bulk 5000+ rows
- **Barcode:** JsBarcode print, bulk 24-up
- **Backup:** R2 daily cron + manual `?backup=1`, list `?listBackups=1`

## Deploy
```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create moto_logistics   # copy database_id into wrangler.toml
npx wrangler r2 bucket create moto-logistics-backup
npx wrangler secret put BOOTSTRAP_USERNAME
npx wrangler secret put BOOTSTRAP_PASSWORD
npx wrangler deploy
# set DB_ENDPOINT in index.html or localStorage moto_endpoint
```

Default login: `admin / Admin@123` (first user becomes admin).

## Local dev (no worker)
Open `index.html` directly — runs in LocalStorage mode (Offline). All data stays in browser; sync when worker is configured.

## Nepal VAT
Company VAT % configurable in Settings. Invoice math: `VAT = Taxable * 13%`, `Total = Taxable + VAT`. VAT Report = Output VAT (sales) − Input VAT (purchase).
