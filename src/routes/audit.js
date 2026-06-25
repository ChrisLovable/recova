const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

// GET /api/audit?tenant_id=xxx
router.get('/', async (req, res) => {
  try {
    const { tenant_id, limit } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }

    const maxRows = Math.min(parseInt(limit || '50', 10), 200);

    const { data, error } = await supabase
      .from('cfdc_audit_log')
      .select('*')
      .eq('tenant_id', tenant_id)
      .order('created_at', { ascending: false })
      .limit(maxRows);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(data || []);
  } catch (err) {
    console.error('[AUDIT ROUTE ERROR]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

module.exports = router;
