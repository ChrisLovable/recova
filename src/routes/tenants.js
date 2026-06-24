const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

// GET /api/tenants â€” list all tenants
router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('tenants').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/tenants â€” create tenant
router.post('/', async (req, res) => {
  const { data, error } = await supabase.from('tenants').insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// GET /api/tenants/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('tenants').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Tenant not found' });
  res.json(data);
});

module.exports = router;
