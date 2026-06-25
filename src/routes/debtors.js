const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

// GET /api/debtors?tenant_id=xxx
router.get('/', async (req, res) => {
  try {
    const { tenant_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }

    // Step 1: Get debtors only
    const { data: debtors, error: debtorError } = await supabase
      .from('debtors')
      .select('*')
      .eq('tenant_id', tenant_id)
      .order('created_at', { ascending: false });

    if (debtorError) {
      return res.status(500).json({ error: debtorError.message });
    }

    if (!debtors || debtors.length === 0) {
      return res.json([]);
    }

    const debtorIds = debtors.map(d => d.id);

    // Step 2: Get debts separately
    const { data: debts, error: debtError } = await supabase
      .from('debts')
      .select('*')
      .in('debtor_id', debtorIds);

    if (debtError) {
      return res.status(500).json({ error: debtError.message });
    }

    // Step 3: Attach debts to each debtor
    const result = debtors.map(debtor => ({
      ...debtor,
      debts: (debts || []).filter(debt => debt.debtor_id === debtor.id)
    }));

    res.json(result);
  } catch (err) {
    console.error('[DEBTORS ROUTE ERROR]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// GET /api/debtors/:id
router.get('/:id', async (req, res) => {
  try {
    const { data: debtor, error: debtorError } = await supabase
      .from('debtors')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (debtorError || !debtor) {
      return res.status(404).json({ error: 'Debtor not found' });
    }

    const { data: debts, error: debtError } = await supabase
      .from('debts')
      .select('*')
      .eq('debtor_id', req.params.id);

    if (debtError) {
      return res.status(500).json({ error: debtError.message });
    }

    res.json({
      ...debtor,
      debts: debts || []
    });
  } catch (err) {
    console.error('[DEBTOR DETAIL ROUTE ERROR]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

module.exports = router;
