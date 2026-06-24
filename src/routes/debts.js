const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

// GET /api/debts?tenant_id=xxx&status=xxx
router.get('/', async (req, res) => {
  const { tenant_id, status } = req.query;
  let query = supabase.from('debts').select('*, debtors(full_name, phone_mobile, language_preference)');
  if (tenant_id) query = query.eq('tenant_id', tenant_id);
  if (status) query = query.eq('status', status);
  const { data, error } = await query.order('priority_score', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
