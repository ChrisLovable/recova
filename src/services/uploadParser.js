// ============================================================
// RECOVA Upload Engine
// Handles CSV, Excel, PDF â€” normalises with Claude AI
// ============================================================

const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('../utils/supabase');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// â”€â”€ Main entry point â”€â”€
async function processUpload({ file, tenantId, userId, popiaConfirmed, columnMapping }) {
  const jobId = await createUploadJob({ tenantId, userId, filename: file.name, fileType: file.mimetype, popiaConfirmed });

  try {
    await updateJob(jobId, { status: 'processing' });

    // Step 1: Parse file into raw rows
    let rawRows = [];
    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'csv') {
      rawRows = await parseCSV(file);
    } else if (['xlsx', 'xls'].includes(ext)) {
      rawRows = await parseExcel(file);
    } else if (ext === 'pdf') {
      rawRows = await parsePDF(file);
    } else {
      throw new Error(`Unsupported file type: ${ext}`);
    }

    if (!rawRows || rawRows.length === 0) {
      throw new Error('No data rows found in file');
    }

    await updateJob(jobId, { total_rows: rawRows.length });

    // Step 2: Normalise with Claude if needed
    const normalised = await normaliseRows(rawRows, columnMapping);

    // Step 3: Validate and load each row
    const results = await loadRows({ rows: normalised, tenantId, jobId });

    // Step 4: Final job update
    await updateJob(jobId, {
      status: 'complete',
      parsed_rows: results.success,
      failed_rows: results.failed,
      duplicate_rows: results.duplicates,
      new_rows: results.success,
      prescribed_rows: results.prescribed,
      debt_review_rows: results.debtReview,
      processed_at: new Date().toISOString()
    });

    return {
      jobId,
      total: rawRows.length,
      success: results.success,
      failed: results.failed,
      duplicates: results.duplicates,
      prescribed: results.prescribed,
      debtReview: results.debtReview,
      errors: results.errors
    };

  } catch (err) {
    await updateJob(jobId, { status: 'failed', error_log: [{ error: err.message }] });
    throw err;
  }
}

// â”€â”€ Parse CSV â”€â”€
async function parseCSV(file) {
  const content = file.data.toString('utf8');
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    relax_column_count: true
  });
  return rows;
}

// â”€â”€ Parse Excel â”€â”€
async function parseExcel(file) {
  const workbook = XLSX.read(file.data, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  return rows;
}

// â”€â”€ Parse PDF using Claude Vision â”€â”€
async function parsePDF(file) {
  try {
    // First try text extraction
    const pdfData = await pdfParse(file.data);
    const text = pdfData.text;

    if (text && text.trim().length > 100) {
      // Send to Claude for structured extraction
      return await extractWithClaude(text, 'text');
    } else {
      // Scanned PDF â€” use Claude Vision
      const base64 = file.data.toString('base64');
      return await extractWithClaude(base64, 'image');
    }
  } catch (err) {
    console.error('[PDF Parse Error]', err.message);
    throw new Error(`PDF parsing failed: ${err.message}`);
  }
}

// â”€â”€ Claude extraction for messy data â”€â”€
async function extractWithClaude(content, type) {
  const systemPrompt = `You are a data extraction specialist for a South African debt collection platform.
Extract debtor and debt information from the provided content.
Return ONLY a valid JSON array. No markdown, no explanation, just the JSON array.
Each object must have these fields (use null if not found):
{
  "first_name": string,
  "last_name": string,
  "id_number": string,
  "phone_mobile": string,
  "email": string,
  "amount": number,
  "reference": string,
  "issue_date": string (YYYY-MM-DD),
  "last_payment_date": string (YYYY-MM-DD),
  "debt_type": string
}
Normalise SA phone numbers to 27XXXXXXXXX format.
SA ID numbers are 13 digits.`;

  const messages = type === 'text'
    ? [{ role: 'user', content: `Extract all debtor records from this text:\n\n${content.substring(0, 50000)}` }]
    : [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: content } },
        { type: 'text', text: 'Extract all debtor records from this document image.' }
      ]}];

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    system: systemPrompt,
    messages
  });

  try {
    const text = response.content[0].text.replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (err) {
    throw new Error('Claude could not extract structured data from this PDF');
  }
}

// â”€â”€ Normalise rows â€” map client columns to our schema â”€â”€
async function normaliseRows(rows, columnMapping) {
  if (!rows || rows.length === 0) return [];

  // If we have an explicit column mapping, use it
  if (columnMapping && Object.keys(columnMapping).length > 0) {
    return rows.map(row => mapColumns(row, columnMapping));
  }

  // Otherwise auto-detect columns using Claude
  const sampleRow = rows[0];
  const headers = Object.keys(sampleRow);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `Map these CSV column headers to our schema fields.
Headers: ${JSON.stringify(headers)}
Sample row: ${JSON.stringify(sampleRow)}

Return ONLY a JSON object mapping their column names to our field names.
Our fields: first_name, last_name, id_number, phone_mobile, email, amount, reference, issue_date, last_payment_date, debt_type
Example: {"Name": "first_name", "Surname": "last_name", "Cell": "phone_mobile", "Amount Due": "amount"}`
    }]
  });

  let mapping = {};
  try {
    const text = response.content[0].text.replace(/```json|```/g, '').trim();
    mapping = JSON.parse(text);
  } catch (err) {
    // Fall through with empty mapping â€” use raw column names
    console.warn('[Column mapping] Claude could not auto-map columns, using raw headers');
  }

  return rows.map(row => mapColumns(row, mapping));
}

// â”€â”€ Apply column mapping to a row â”€â”€
function mapColumns(row, mapping) {
  const mapped = {};
  for (const [theirCol, ourField] of Object.entries(mapping)) {
    if (row[theirCol] !== undefined) {
      mapped[ourField] = row[theirCol];
    }
  }
  // Also copy any direct matches
  const ourFields = ['first_name','last_name','id_number','phone_mobile','email','amount','reference','issue_date','last_payment_date','debt_type'];
  for (const field of ourFields) {
    if (row[field] !== undefined && mapped[field] === undefined) {
      mapped[field] = row[field];
    }
  }
  return mapped;
}

// â”€â”€ Normalise a phone number to SA format â”€â”€
function normalisePhone(raw) {
  if (!raw) return null;
  let phone = String(raw).replace(/\D/g, '');
  if (phone.startsWith('0') && phone.length === 10) phone = '27' + phone.substring(1);
  if (phone.startsWith('27') && phone.length === 11) return phone;
  return phone.length >= 9 ? phone : null;
}

// â”€â”€ Calculate prescription date â”€â”€
function calcPrescriptionDate(lastPaymentDate, issueDate) {
  const base = lastPaymentDate || issueDate;
  if (!base) return null;
  const d = new Date(base);
  if (isNaN(d)) return null;
  d.setFullYear(d.getFullYear() + 3);
  return d.toISOString().split('T')[0];
}

// â”€â”€ Check if debt is prescribed â”€â”€
function isPrescribed(prescriptionDate) {
  if (!prescriptionDate) return false;
  return new Date(prescriptionDate) < new Date();
}

// â”€â”€ Load rows into Supabase â”€â”€
async function loadRows({ rows, tenantId, jobId }) {
  let success = 0, failed = 0, duplicates = 0, prescribed = 0, debtReview = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      // Validate minimum required fields
      if (!row.first_name && !row.last_name && !row.phone_mobile) {
        throw new Error('Missing required fields: name or phone');
      }

      if (!row.amount || isNaN(parseFloat(row.amount))) {
        throw new Error('Missing or invalid amount');
      }

      const phone = normalisePhone(row.phone_mobile);
      const amount = parseFloat(row.amount);
      const prescriptionDate = calcPrescriptionDate(row.last_payment_date, row.issue_date);
      const prescribed = isPrescribed(prescriptionDate);

      if (prescribed) prescriptionDate && prescriptionDate++;

      // Check for duplicate â€” same tenant + phone + similar amount
      if (phone) {
        const { data: existingDebtor } = await supabase
          .from('debtors')
          .select('id, debts(id, current_balance)')
          .eq('tenant_id', tenantId)
          .eq('phone_mobile', phone)
          .single();

        if (existingDebtor) {
          const dupDebt = existingDebtor.debts?.find(d => Math.abs(d.current_balance - amount) < 1);
          if (dupDebt) {
            duplicates++;
            await logFailedRow(jobId, i + 1, row, 'DUPLICATE: Same phone and amount already exists');
            continue;
          }
        }
      }

      // Insert debtor
      const debtorPayload = {
        tenant_id: tenantId,
        first_name: String(row.first_name || '').trim() || 'Unknown',
        last_name: String(row.last_name || '').trim() || 'Unknown',
        id_number: row.id_number ? String(row.id_number).trim() : null,
        phone_mobile: phone,
        email: row.email || null,
        popia_consent: true,
        popia_consent_at: new Date().toISOString(),
        popia_consent_method: 'upload_declaration'
      };

      const { data: debtor, error: debtorError } = await supabase
        .from('debtors')
        .insert(debtorPayload)
        .select()
        .single();

      if (debtorError) throw new Error(`Debtor insert failed: ${debtorError.message}`);

      // Insert debt
      const debtPayload = {
        tenant_id: tenantId,
        debtor_id: debtor.id,
        reference_number: row.reference ? String(row.reference).trim() : null,
        debt_type: row.debt_type || 'invoice',
        original_amount: amount,
        current_balance: amount,
        issue_date: row.issue_date || null,
        last_payment_date: row.last_payment_date || null,
        prescription_date: prescriptionDate,
        is_prescribed: isPrescribed(prescriptionDate),
        status: isPrescribed(prescriptionDate) ? 'prescribed' : 'new',
        handover_date: new Date().toISOString().split('T')[0]
      };

      const { error: debtError } = await supabase
        .from('debts')
        .insert(debtPayload);

      if (debtError) throw new Error(`Debt insert failed: ${debtError.message}`);

      // Log to prescription_log if prescribed
      if (isPrescribed(prescriptionDate)) {
        prescribed++;
        await supabase.from('prescription_log').insert({
          tenant_id: tenantId,
          debt_id: debtor.id,
          debtor_id: debtor.id,
          prescription_date: prescriptionDate,
          notified_client: false
        });
      }

      // Audit log
      await supabase.from('cfdc_audit_log').insert({
        tenant_id: tenantId,
        action: 'debt_uploaded',
        entity_type: 'debt',
        entity_id: debtor.id,
        new_value: { debtor_id: debtor.id, amount, phone },
        notes: `Upload job ${jobId}`
      });

      success++;

    } catch (err) {
      failed++;
      errors.push({ row: i + 1, error: err.message });
      await logFailedRow(jobId, i + 1, row, err.message);
    }
  }

  return { success, failed, duplicates, prescribed, debtReview, errors };
}

// â”€â”€ Log failed row â”€â”€
async function logFailedRow(jobId, rowNumber, rawData, reason) {
  await supabase.from('upload_rows_failed').insert({
    upload_job_id: jobId,
    row_number: rowNumber,
    raw_data: rawData,
    failure_reason: reason
  });
}

// â”€â”€ Create upload job record â”€â”€
async function createUploadJob({ tenantId, userId, filename, fileType, popiaConfirmed }) {
  const { data, error } = await supabase
    .from('upload_jobs')
    .insert({
      tenant_id: tenantId,
      filename,
      file_type: fileType || 'unknown',
      status: 'pending',
      popia_confirmed: popiaConfirmed || false,
      popia_confirmed_at: popiaConfirmed ? new Date().toISOString() : null,
      uploaded_by: userId || null
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create upload job: ${error.message}`);
  return data.id;
}

// â”€â”€ Update upload job â”€â”€
async function updateJob(jobId, updates) {
  await supabase.from('upload_jobs').update(updates).eq('id', jobId);
}

module.exports = { processUpload };
