const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

// GET /api/debts?tenant_id=xxx&status=xxx
router.get('/', async (req, res) => {
  try {
    const { tenant_id, status } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }

    // Step 1: Get debts only
    let debtQuery = supabase
      .from('debts')
      .select('*')
      .eq('tenant_id', tenant_id);

    if (status) {
      debtQuery = debtQuery.eq('status', status);
    }

    const { data: debts, error: debtError } = await debtQuery
      .order('priority_score', { ascending: false });

    if (debtError) {
      return res.status(500).json({ error: debtError.message });
    }

    if (!debts || debts.length === 0) {
      return res.json([]);
    }

    const debtorIds = [...new Set(debts.map(d => d.debtor_id).filter(Boolean))];

    // Step 2: Get related debtors separately
    const { data: debtors, error: debtorError } = await supabase
      .from('debtors')
      .select('id, first_name, last_name, full_name, phone_mobile, email, language_preference, debt_review_flag, dispute_flag, do_not_contact, opted_out')
      .in('id', debtorIds);

    if (debtorError) {
      return res.status(500).json({ error: debtorError.message });
    }

    // Step 3: Attach debtor to each debt
    const result = debts.map(debt => ({
      ...debt,
      debtor: (debtors || []).find(d => d.id === debt.debtor_id) || null
    }));

    res.json(result);
  } catch (err) {
    console.error('[DEBTS ROUTE ERROR]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// GET /api/debts/:id
router.get('/:id', async (req, res) => {
  try {
    const { data: debt, error: debtError } = await supabase
      .from('debts')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (debtError || !debt) {
      return res.status(404).json({ error: 'Debt not found' });
    }

    const { data: debtor, error: debtorError } = await supabase
      .from('debtors')
      .select('id, first_name, last_name, full_name, phone_mobile, email, language_preference, debt_review_flag, dispute_flag, do_not_contact, opted_out')
      .eq('id', debt.debtor_id)
      .single();

    res.json({
      ...debt,
      debtor: debtorError ? null : debtor
    });
  } catch (err) {
    console.error('[DEBT DETAIL ROUTE ERROR]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

module.exports = router;
