const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

// GET /api/debtors?tenant_id=xxx
router.get('/', async (req, res) => {
  const { tenant_id, status } = req.query;
  let query = supabase.from('debtors').select('*, debts(*)');
  if (tenant_id) query = query.eq('tenant_id', tenant_id);
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/debtors/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('debtors').select('*, debts(*)').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Debtor not found' });
  res.json(data);
});

module.exports = router;
