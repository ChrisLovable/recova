const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const supabase = require('../utils/supabase');

function getClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error('Twilio credentials missing in .env');
  }
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// GET /api/twilio/voice-test — TwiML webhook
router.get('/voice-test', (req, res) => {
  const response = new twilio.twiml.VoiceResponse();

  response.say(
    { voice: 'alice', language: 'en-ZA' },
    'Hello Chris. This is a Recova test call. No debtor is being contacted. This confirms that Twilio calling is connected successfully.'
  );

  response.pause({ length: 1 });

  response.say(
    { voice: 'alice', language: 'en-ZA' },
    'The next step will be connecting the AI conversation engine. Goodbye.'
  );

  res.type('text/xml');
  res.send(response.toString());
});

// POST /api/twilio/voice-test — TwiML webhook (Twilio posts to this)
router.post('/voice-test', (req, res) => {
  const response = new twilio.twiml.VoiceResponse();

  response.say(
    { voice: 'alice', language: 'en-ZA' },
    'Hello Chris. This is a Recova test call. No debtor is being contacted. This confirms that Twilio calling is connected successfully.'
  );

  response.pause({ length: 1 });

  response.say(
    { voice: 'alice', language: 'en-ZA' },
    'The next step will be connecting the AI conversation engine. Goodbye.'
  );

  res.type('text/xml');
  res.send(response.toString());
});

// POST /api/twilio/status — status callback
router.post('/status', async (req, res) => {
  try {
    const { session_id } = req.query;
    const callSid = req.body.CallSid;
    const callStatus = req.body.CallStatus;
    const callDuration = Number(req.body.CallDuration || 0);

    console.log(`[TWILIO STATUS] ${callStatus} | SID: ${callSid} | Duration: ${callDuration}s`);

    if (session_id) {
      await supabase
        .from('call_sessions')
        .update({
          twilio_call_sid: callSid || null,
          duration_seconds: callDuration,
          talk_time_seconds: callDuration,
          ended_at: callStatus === 'completed' ? new Date().toISOString() : null
        })
        .eq('id', session_id);

      await supabase
        .from('cfdc_audit_log')
        .insert({
          action: 'twilio_status_callback',
          entity_type: 'call_session',
          entity_id: session_id,
          new_value: {
            call_sid: callSid,
            call_status: callStatus,
            call_duration: callDuration
          },
          notes: `Twilio status callback: ${callStatus}`
        });
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('[TWILIO STATUS ERROR]', err);
    res.status(200).send('OK');
  }
});

// POST /api/twilio/call-me
router.post('/call-me', async (req, res) => {
  try {
    const { debt_id } = req.body;

    if (!debt_id) return res.status(400).json({ error: 'debt_id is required' });
    if (!process.env.TEST_CALL_TO) return res.status(500).json({ error: 'TEST_CALL_TO missing in .env' });
    if (!process.env.TWILIO_PHONE_NUMBER) return res.status(500).json({ error: 'TWILIO_PHONE_NUMBER missing in .env' });
    if (!process.env.PUBLIC_BASE_URL) return res.status(500).json({ error: 'PUBLIC_BASE_URL missing in .env' });

    const { data: debt, error: debtError } = await supabase
      .from('debts').select('*').eq('id', debt_id).single();
    if (debtError || !debt) return res.status(404).json({ error: 'Debt not found' });

    const { data: debtor, error: debtorError } = await supabase
      .from('debtors').select('*').eq('id', debt.debtor_id).single();
    if (debtorError || !debtor) return res.status(404).json({ error: 'Debtor not found' });

    const now = new Date().toISOString();

    const { data: session, error: sessionError } = await supabase
      .from('call_sessions')
      .insert({
        tenant_id: debt.tenant_id,
        debtor_id: debtor.id,
        debt_id: debt.id,
        direction: 'outbound',
        phone_number_called: process.env.TEST_CALL_TO,
        twilio_sa_number: process.env.TWILIO_PHONE_NUMBER,
        scheduled_at: now,
        started_at: now,
        duration_seconds: 0,
        talk_time_seconds: 0,
        language_used: 'en',
        tts_provider_used: 'google',
        script_used: 'TWILIO_TEST',
        transcript: 'REAL TWILIO TEST CALL TO SYSTEM OWNER. No debtor was contacted.',
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
      .select().single();

    if (sessionError) {
      return res.status(500).json({ error: sessionError.message, hint: 'Could not create call_session' });
    }

    const client = getClient();

    const call = await client.calls.create({
      to: process.env.TEST_CALL_TO,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${process.env.PUBLIC_BASE_URL}/api/twilio/voice-test?session_id=${session.id}`,
      statusCallback: `${process.env.PUBLIC_BASE_URL}/api/twilio/status?session_id=${session.id}`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST'
    });

    await supabase.from('call_sessions').update({ twilio_call_sid: call.sid }).eq('id', session.id);

    await supabase.from('call_attempts').insert({
      call_session_id: session.id,
      debtor_id: debtor.id,
      debt_id: debt.id,
      attempt_number: 1,
      attempted_at: now,
      result: 'initiated',
      duration_seconds: 0
    });

    await supabase.from('cfdc_audit_log').insert({
      tenant_id: debt.tenant_id,
      action: 'twilio_test_call_started',
      entity_type: 'call_session',
      entity_id: session.id,
      new_value: {
        twilio_call_sid: call.sid,
        test_call_to: process.env.TEST_CALL_TO,
        twilio_number: process.env.TWILIO_PHONE_NUMBER,
        debt_id: debt.id,
        debtor_name: debtor.full_name,
        no_debtor_contacted: true,
        started_at: now
      },
      notes: `Twilio test call started to system owner. No debtor was contacted.`
    });

    res.json({
      success: true,
      message: 'Twilio test call started. Your phone should ring within 15 seconds.',
      call_sid: call.sid,
      call_session_id: session.id,
      to: process.env.TEST_CALL_TO,
      from: process.env.TWILIO_PHONE_NUMBER
    });

  } catch (err) {
    console.error('[TWILIO CALL-ME ERROR]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

module.exports = router;
