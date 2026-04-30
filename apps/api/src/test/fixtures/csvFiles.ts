/** Valid CSV with all required columns */
export const validCsv = `date,amount,category
2025-01-15,1200.00,Revenue
2025-01-16,450.50,Expenses
2025-01-17,800.00,Revenue`;

/** Valid CSV with optional columns */
export const validCsvWithOptionals = `date,amount,category,label,parent_category
2025-01-15,1200.00,Revenue,Monthly sales,Income
2025-01-16,450.50,Office Supplies,Printer paper,Expenses`;

/** Missing required column (no 'amount') */
export const missingColumn = `date,category
2025-01-15,Revenue
2025-01-16,Expenses`;

/** Invalid date values */
export const invalidDates = `date,amount,category
not-a-date,1200.00,Revenue
also-bad,450.50,Expenses`;

/** Invalid amount values */
export const invalidAmounts = `date,amount,category
2025-01-15,twelve hundred,Revenue
2025-01-16,n/a,Expenses`;

/** Empty file */
export const emptyFile = '';

/** Header-only (no data rows) */
export const headerOnly = `date,amount,category`;

/** BOM marker prefix */
export const bomPrefixed = `\uFEFFdate,amount,category
2025-01-15,1200.00,Revenue`;

/** Case-insensitive and whitespace-padded headers */
export const messyHeaders = `Date, AMOUNT , category
2025-01-15,1200.00,Revenue`;

/** Trailing newlines */
export const trailingNewlines = `date,amount,category
2025-01-15,1200.00,Revenue
2025-01-16,450.50,Expenses

`;

/** Mix of valid and invalid rows (partial success) */
export const partiallyValid = `date,amount,category
2025-01-15,1200.00,Revenue
bad-date,450.50,Expenses
2025-01-17,800.00,Revenue
2025-01-18,not-a-number,Expenses
2025-01-19,300.00,Revenue`;

/** All rows invalid (>50% failure) */
export const mostlyInvalid = `date,amount,category
bad,bad,
nope,nah,
also-bad,not-num,`;

/** Header containing a quoted comma, naive split(',') would break this */
export const quotedHeaders = `date,amount,category,"Revenue, Q1"
2025-01-15,1200.00,Revenue,5000.00`;

/** Mixed-case headers for key normalization testing */
export const mixedCaseHeaders = `Date,Amount,Category
2025-01-15,1200.00,Revenue
2025-01-16,450.50,Expenses`;
