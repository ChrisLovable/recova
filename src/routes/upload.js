// ============================================================
// RECOVA Upload Route
// POST /api/upload
// ============================================================

const express = require('express');
const router = express.Router();
const { processUpload } = require('../services/uploadParser');
const supabase = require('../utils/supabase');

// POST /api/upload
router.post('/', async (req, res) => {
  try {
    // Validate file present
    if (!req.files || !req.files.file) {
      return res.status(400).json({ error: 'No file uploaded. Send file as multipart field named "file"' });
    }

    const file = req.files.file;
    const { tenant_id, user_id, popia_confirmed, column_mapping } = req.body;

    // Validate tenant
    if (!tenant_id) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }

    const { data: tenant } = await supabase.from('tenants').select('id, status').eq('id', tenant_id).single();
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    if (tenant.status !== 'active') return res.status(403).json({ error: 'Tenant account is not active' });

    // Validate POPIA confirmation
    if (!popia_confirmed || popia_confirmed === 'false') {
      return res.status(400).json({
        error: 'POPIA consent required. Confirm you have consent from all debtors to process their data.',
        code: 'POPIA_REQUIRED'
      });
    }

    // Validate file type
    const ext = file.name.split('.').pop().toLowerCase();
    const allowed = ['csv', 'xlsx', 'xls', 'pdf'];
    if (!allowed.includes(ext)) {
      return res.status(400).json({ error: `File type .${ext} not supported. Use CSV, Excel, or PDF.` });
    }

    // Parse column mapping if provided
    let columnMapping = {};
    if (column_mapping) {
      try { columnMapping = JSON.parse(column_mapping); } catch (e) {}
    }

    console.log(`[UPLOAD] Tenant: ${tenant_id} | File: ${file.name} | Size: ${(file.size/1024).toFixed(1)}KB`);

    // Process upload
    const result = await processUpload({
      file,
      tenantId: tenant_id,
      userId: user_id,
      popiaConfirmed: true,
      columnMapping
    });

    return res.status(200).json({
      success: true,
      jobId: result.jobId,
      summary: {
        total: result.total,
        loaded: result.success,
        failed: result.failed,
        duplicates: result.duplicates,
        prescribed: result.prescribed,
        debtReview: result.debtReview
      },
      errors: result.errors.slice(0, 20) // Return first 20 errors only
    });

  } catch (err) {
    console.error('[UPLOAD ERROR]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/upload/jobs?tenant_id=xxx â€” list upload history
router.get('/jobs', async (req, res) => {
  const { tenant_id } = req.query;
  if (!tenant_id) return res.status(400).json({ error: 'tenant_id required' });

  const { data, error } = await supabase
    .from('upload_jobs')
    .select('*')
    .eq('tenant_id', tenant_id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/upload/jobs/:id â€” single job status
router.get('/jobs/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('upload_jobs')
    .select('*, upload_rows_failed(*)')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ error: 'Job not found' });
  res.json(data);
});

module.exports = router;
