const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

// POST /api/calls/simulate
router.post('/simulate', async (req, res) => {
  try {
    const { debt_id, result } = req.body;

    if (!debt_id) {
      return res.status(400).json({ error: 'debt_id is required' });
    }

    const { data: debt, error: debtError } = await supabase
      .from('debts')
      .select('*')
      .eq('id', debt_id)
      .single();

    if (debtError || !debt) {
      return res.status(404).json({ error: 'Debt not found' });
    }

    const { data: debtor, error: debtorError } = await supabase
      .from('debtors')
      .select('*')
      .eq('id', debt.debtor_id)
      .single();

    if (debtorError || !debtor) {
      return res.status(404).json({ error: 'Debtor not found' });
    }

    const now = new Date().toISOString();

    const { data: session, error: sessionError } = await supabase
      .from('call_sessions')
      .insert({
        tenant_id: debt.tenant_id,
        debtor_id: debtor.id,
        debt_id: debt.id,
        direction: 'outbound',
        phone_number_called: debtor.phone_mobile,
        scheduled_at: now,
        started_at: now,
        ended_at: now,
        duration_seconds: 0,
        talk_time_seconds: 0,
        language_used: 'en',
        tts_provider_used: 'google',
        script_used: 'A',
        transcript: 'SIMULATED CALL ONLY. No Twilio call was made.',
        call_cost_usd: 0,
        tts_cost_usd: 0,
        stt_cost_usd: 0,
        compliance_score: 100,
        performance_score: 0,
        disclosure_delivered: false,
        contact_window_compliant: true,
        prohibited_language_detected: false,
        payment_link_sent: false,
        lucky_draw_mentioned: false,
        human_transferred: false,
        requires_human: false
      })
      .select()
      .single();

    if (sessionError) {
      return res.status(500).json({
        error: sessionError.message,
        hint: 'Could not insert call_sessions record'
      });
    }

    const { data: attempt, error: attemptError } = await supabase
      .from('call_attempts')
      .insert({
        call_session_id: session.id,
        debtor_id: debtor.id,
        debt_id: debt.id,
        attempt_number: 1,
        attempted_at: now,
        result: result || 'simulated_no_call',
        duration_seconds: 0
      })
      .select()
      .single();

    if (attemptError) {
      return res.status(500).json({
        error: attemptError.message,
        hint: 'Call session created, but call_attempts failed',
        session_id: session.id
      });
    }

    const { data: scoring, error: scoringError } = await supabase
      .from('call_scoring')
      .insert({
        call_session_id: session.id,
        identity_verified: false,
        disclosure_delivered: false,
        contact_window_compliant: true,
        prohibited_language_detected: false,
        threatened_arrest: false,
        false_amount_stated: false,
        harassment_detected: false,
        empathy_score: 0,
        rapport_score: 0,
        objection_handling_score: 0,
        close_technique_score: 0,
        payment_options_presented: true,
        options_count_presented: 3,
        commitment_obtained: false,
        payment_link_sent: false,
        overall_compliance_score: 100,
        overall_performance_score: 0,
        flags: ['SIMULATED_ONLY', 'NO_TWILIO_CALL_MADE'],
        scored_by: 'system-simulation'
      })
      .select()
      .single();

    if (scoringError) {
      return res.status(500).json({
        error: scoringError.message,
        hint: 'Call session and attempt created, but call_scoring failed',
        session_id: session.id,
        attempt_id: attempt.id
      });
    }

    await supabase
      .from('cfdc_audit_log')
      .insert({
        tenant_id: debt.tenant_id,
        action: 'simulated_call_session_created',
        entity_type: 'call_session',
        entity_id: session.id,
        new_value: {
          simulated: true,
          twilio_call_made: false,
          call_session_id: session.id,
          call_attempt_id: attempt.id,
          call_scoring_id: scoring.id,
          debtor_id: debtor.id,
          debtor_name: debtor.full_name,
          debt_id: debt.id,
          reference_number: debt.reference_number,
          current_balance: debt.current_balance,
          result: result || 'simulated_no_call',
          logged_at: now
        },
        notes: `Simulated call session created for ${debtor.full_name}. No Twilio call was made.`
      });

    res.json({
      success: true,
      message: 'Simulated call session, attempt, scoring and audit record created. No real call was made.',
      debtor,
      debt,
      call_session: session,
      call_attempt: attempt,
      call_scoring: scoring
    });

  } catch (err) {
    console.error('[SIMULATED CALL ERROR]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// GET /api/calls/history?tenant_id=xxx
router.get('/history', async (req, res) => {
  try {
    const { tenant_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }

    const { data, error } = await supabase
      .from('call_sessions')
      .select('*')
      .eq('tenant_id', tenant_id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(data || []);
  } catch (err) {
    console.error('[CALL HISTORY ERROR]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});


// GET /api/calls/history-detailed?tenant_id=xxx
router.get('/history-detailed', async (req, res) => {
  try {
    const { tenant_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }

    const { data: sessions, error: sessionError } = await supabase
      .from('call_sessions')
      .select('*')
      .eq('tenant_id', tenant_id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (sessionError) {
      return res.status(500).json({ error: sessionError.message });
    }

    if (!sessions || sessions.length === 0) {
      return res.json([]);
    }

    const sessionIds = sessions.map(s => s.id);
    const debtorIds = [...new Set(sessions.map(s => s.debtor_id).filter(Boolean))];
    const debtIds = [...new Set(sessions.map(s => s.debt_id).filter(Boolean))];

    const { data: debtors } = await supabase
      .from('debtors')
      .select('id, full_name, phone_mobile, email, language_preference')
      .in('id', debtorIds);

    const { data: debts } = await supabase
      .from('debts')
      .select('id, reference_number, current_balance, debt_type, status')
      .in('id', debtIds);

    const { data: attempts } = await supabase
      .from('call_attempts')
      .select('*')
      .in('call_session_id', sessionIds);

    const { data: scores } = await supabase
      .from('call_scoring')
      .select('*')
      .in('call_session_id', sessionIds);

    const debtorMap = new Map((debtors || []).map(d => [d.id, d]));
    const debtMap = new Map((debts || []).map(d => [d.id, d]));

    const result = sessions.map(session => {
      const sessionAttempts = (attempts || []).filter(a => a.call_session_id === session.id);
      const latestAttempt = sessionAttempts[0] || null;
      const score = (scores || []).find(s => s.call_session_id === session.id) || null;

      return {
        ...session,
        debtor: debtorMap.get(session.debtor_id) || null,
        debt: debtMap.get(session.debt_id) || null,
        latest_attempt: latestAttempt,
        scoring: score
      };
    });

    res.json(result);

  } catch (err) {
    console.error('[DETAILED CALL HISTORY ERROR]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});


// POST /api/calls/outcome
router.post('/outcome', async (req, res) => {
  try {
    const {
      call_session_id,
      outcome,
      promise_amount,
      promise_date,
      callback_at,
      notes
    } = req.body;

    if (!call_session_id) {
      return res.status(400).json({ error: 'call_session_id is required' });
    }

    if (!outcome) {
      return res.status(400).json({ error: 'outcome is required' });
    }

    const allowedCallOutcomes = new Set([
      'answered',
      'voicemail',
      'no_answer',
      'busy',
      'failed',
      'promise_to_pay',
      'refused',
      'dispute_raised',
      'callback_requested',
      'wrong_number',
      'deceased',
      'opted_out'
    ]);

    const specialOutcomes = new Set([
      'debt_review',
      'needs_human'
    ]);

    if (!allowedCallOutcomes.has(outcome) && !specialOutcomes.has(outcome)) {
      return res.status(400).json({
        error: 'Invalid outcome',
        allowed: [...allowedCallOutcomes, ...specialOutcomes]
      });
    }

    const { data: session, error: sessionError } = await supabase
      .from('call_sessions')
      .select('*')
      .eq('id', call_session_id)
      .single();

    if (sessionError || !session) {
      return res.status(404).json({ error: 'Call session not found' });
    }

    const { data: debt, error: debtError } = await supabase
      .from('debts')
      .select('*')
      .eq('id', session.debt_id)
      .single();

    if (debtError || !debt) {
      return res.status(404).json({ error: 'Debt not found for call session' });
    }

    const { data: debtor, error: debtorError } = await supabase
      .from('debtors')
      .select('*')
      .eq('id', session.debtor_id)
      .single();

    if (debtorError || !debtor) {
      return res.status(404).json({ error: 'Debtor not found for call session' });
    }

    const now = new Date().toISOString();

    const dbOutcome =
      outcome === 'debt_review' || outcome === 'needs_human'
        ? 'answered'
        : outcome;

    const sessionUpdate = {
      outcome: dbOutcome,
      ended_at: now
    };

    if (outcome === 'promise_to_pay') {
      sessionUpdate.promise_amount = promise_amount || null;
      sessionUpdate.promise_date = promise_date || null;
      sessionUpdate.promise_fulfilled = false;
      sessionUpdate.payment_link_sent = false;
    }

    if (outcome === 'needs_human') {
      sessionUpdate.requires_human = true;
      sessionUpdate.human_transferred = false;
      sessionUpdate.transfer_reason = notes || 'Review by my manager review';
    }

    if (outcome === 'debt_review') {
      sessionUpdate.requires_human = true;
      sessionUpdate.transfer_reason = notes || 'Debtor indicated debt review';
    }

    if (outcome === 'dispute_raised') {
      sessionUpdate.requires_human = true;
      sessionUpdate.transfer_reason = notes || 'Debtor disputed the debt';
    }

    const { data: updatedSession, error: updateSessionError } = await supabase
      .from('call_sessions')
      .update(sessionUpdate)
      .eq('id', call_session_id)
      .select()
      .single();

    if (updateSessionError) {
      return res.status(500).json({
        error: updateSessionError.message,
        hint: 'Could not update call_sessions outcome'
      });
    }

    const { data: attempts } = await supabase
      .from('call_attempts')
      .select('*')
      .eq('call_session_id', call_session_id)
      .order('attempted_at', { ascending: false })
      .limit(1);

    let updatedAttempt = null;

    if (attempts && attempts.length > 0) {
      const attemptUpdate = {
        result: outcome,
        duration_seconds: updatedSession.duration_seconds || 0
      };

      if (outcome === 'callback_requested' && callback_at) {
        attemptUpdate.next_attempt_at = callback_at;
      }

      const { data, error } = await supabase
        .from('call_attempts')
        .update(attemptUpdate)
        .eq('id', attempts[0].id)
        .select()
        .single();

      if (error) {
        return res.status(500).json({
          error: error.message,
          hint: 'Could not update latest call_attempts record'
        });
      }

      updatedAttempt = data;
    } else {
      const { data, error } = await supabase
        .from('call_attempts')
        .insert({
          call_session_id,
          debtor_id: session.debtor_id,
          debt_id: session.debt_id,
          attempt_number: 1,
          attempted_at: now,
          result: outcome,
          duration_seconds: updatedSession.duration_seconds || 0,
          next_attempt_at: outcome === 'callback_requested' ? callback_at || null : null
        })
        .select()
        .single();

      if (error) {
        return res.status(500).json({
          error: error.message,
          hint: 'Could not create call_attempts record'
        });
      }

      updatedAttempt = data;
    }

    const debtUpdate = {
      updated_at: now
    };

    const debtorUpdate = {
      updated_at: now
    };

    if (outcome === 'promise_to_pay') {
      debtUpdate.status = 'promise_to_pay';
    }

    if (outcome === 'dispute_raised') {
      debtUpdate.status = 'disputed';
      debtUpdate.escalation_level = 'supervisor';
      debtorUpdate.dispute_flag = true;
      debtorUpdate.dispute_reason = notes || 'Dispute raised during call';
      debtorUpdate.dispute_raised_at = now;
    }

    if (outcome === 'debt_review') {
      debtUpdate.status = 'blocked_debt_review';
      debtUpdate.escalation_level = 'supervisor';
      debtorUpdate.debt_review_flag = true;
    }

    if (outcome === 'needs_human') {
      debtUpdate.status = 'in_progress';
      debtUpdate.escalation_level = 'supervisor';
    }

    if (outcome === 'callback_requested') {
      debtUpdate.status = 'queued';
    }

    if (outcome === 'wrong_number') {
      debtUpdate.escalation_level = 'supervisor';
      debtorUpdate.do_not_contact = true;
      debtorUpdate.do_not_contact_reason = 'Wrong number reported during call';
      debtorUpdate.do_not_contact_at = now;
    }

    if (outcome === 'opted_out') {
      debtorUpdate.opted_out = true;
      debtorUpdate.opted_out_at = now;
    }

    let updatedDebt = null;
    let updatedDebtor = null;

    if (Object.keys(debtUpdate).length > 1) {
      const { data, error } = await supabase
        .from('debts')
        .update(debtUpdate)
        .eq('id', debt.id)
        .select()
        .single();

      if (error) {
        return res.status(500).json({
          error: error.message,
          hint: 'Call outcome updated, but debt update failed'
        });
      }

      updatedDebt = data;
    }

    if (Object.keys(debtorUpdate).length > 1) {
      const { data, error } = await supabase
        .from('debtors')
        .update(debtorUpdate)
        .eq('id', debtor.id)
        .select()
        .single();

      if (error) {
        return res.status(500).json({
          error: error.message,
          hint: 'Call outcome updated, but debtor update failed'
        });
      }

      updatedDebtor = data;
    }

    await supabase
      .from('cfdc_audit_log')
      .insert({
        tenant_id: session.tenant_id,
        action: 'call_outcome_recorded',
        entity_type: 'call_session',
        entity_id: call_session_id,
        new_value: {
          call_session_id,
          debtor_id: debtor.id,
          debtor_name: debtor.full_name,
          debt_id: debt.id,
          reference_number: debt.reference_number,
          selected_outcome: outcome,
          stored_call_outcome: dbOutcome,
          promise_amount: promise_amount || null,
          promise_date: promise_date || null,
          callback_at: callback_at || null,
          notes: notes || null,
          updated_at: now
        },
        notes: `Call outcome recorded for ${debtor.full_name}: ${outcome}`
      });

    res.json({
      success: true,
      message: `Call outcome recorded: ${outcome}`,
      selected_outcome: outcome,
      stored_call_outcome: dbOutcome,
      call_session: updatedSession,
      call_attempt: updatedAttempt,
      debt: updatedDebt || debt,
      debtor: updatedDebtor || debtor
    });

  } catch (err) {
    console.error('[CALL OUTCOME ERROR]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

module.exports = router;




