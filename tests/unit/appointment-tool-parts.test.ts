import { describe, expect, it } from 'vitest';
import { type CallerAnswer, classifyConfirmation, resolveConfirmation } from '../../src/agent/tools/confirmation-classifier.js';
import { normalizeBirthDate, normalizeNationalId, normalizePhone, toAsciiDigits } from '../../src/agent/tools/normalize.js';
import { DevIdentifierDobVerification } from '../../src/agent/tools/patient-verification.js';
import { type ActionTarget, PendingActions, readBackHeard } from '../../src/agent/tools/pending-actions.js';
import { SessionRefs } from '../../src/agent/tools/session-refs.js';
import { WriteLedger } from '../../src/agent/tools/write-ledger.js';
import { APPOINTMENT_TOOL_NAMES, parseToolArguments, toolParametersJsonSchema } from '../../src/contracts/appointment-tools.js';
import { ProviderError, SchedulingError } from '../../src/core/errors.js';
import { silentLogger } from '../../src/core/logger.js';
import type { AvailableSlot, PatientRecord } from '../../src/ports/scheduling.js';

const slot = (token: string): AvailableSlot => ({
  start: new Date('2026-10-12T13:00:00Z'),
  end: new Date('2026-10-12T13:20:00Z'),
  serviceId: 'svc',
  serviceName: 'طب الأسرة',
  practitionerId: 'prac',
  practitionerName: 'فهد العتيبي',
  token,
});

describe('tool schemas', () => {
  it('are strict: every property required, no additional properties', () => {
    for (const name of APPOINTMENT_TOOL_NAMES) {
      const schema = toolParametersJsonSchema(name);
      expect(schema, name).toMatchObject({ type: 'object', additionalProperties: false });
      expect(schema).not.toHaveProperty('$schema');
      const properties = Object.keys(schema['properties'] as Record<string, unknown>);
      expect([...(schema['required'] as string[])].sort(), name).toEqual(properties.sort());
    }
  });

  it('reject unknown fields, missing fields and invalid JSON with a short problem', () => {
    expect(parseToolArguments('confirm_pending_action', '{"action_ref":"C1","caller_answer":"yes","caller_said":"إيه"}')).toMatchObject({ ok: false });
    expect(parseToolArguments('confirm_pending_action', '{"action_ref":"C1","caller_answer":"maybe"}')).toMatchObject({ ok: false });
    expect(parseToolArguments('confirm_pending_action', '{"action_ref":"C1","caller_answer":"yes"}')).toMatchObject({ ok: true });
    expect(parseToolArguments('propose_booking', '{"patient_ref":"P1"}')).toMatchObject({ ok: false, problem: expect.stringContaining('slot_ref') as unknown });
    expect(parseToolArguments('find_patient', 'not json')).toEqual({ ok: false, problem: 'arguments are not valid JSON' });
    expect(parseToolArguments('find_patient', '{"national_id":null,"phone":"0500000101","birth_date":"1990-03-14"}')).toMatchObject({ ok: true });
  });
});

describe('identifier normalization', () => {
  it('maps Arabic-Indic digits and strips separators', () => {
    expect(toAsciiDigits('١٢٣ ۴۵۶')).toBe('123 456');
    expect(normalizeNationalId('١٠٠٠ ٠٠٠ ١٠٠')).toBe('1000000100');
    expect(normalizeNationalId('100000010')).toBeUndefined();
    expect(normalizeNationalId('3000000100')).toBeUndefined();
  });

  it('turns Saudi mobile formats into E.164 and rejects the rest', () => {
    for (const input of ['0500000101', '٠٥٠٠٠٠٠١٠١', '500000101', '966500000101', '+966 50 000 0101', '00966500000101', '050-000-0101']) {
      expect(normalizePhone(input), input).toBe('+966500000101');
    }
    expect(normalizePhone('+447700900123')).toBe('+447700900123');
    expect(normalizePhone('0112345678')).toBeUndefined();
    expect(normalizePhone('abc')).toBeUndefined();
  });

  it('accepts only real past birth dates', () => {
    expect(normalizeBirthDate('١٩٩٠-٠٣-١٤', '2026-10-12')).toBe('1990-03-14');
    expect(normalizeBirthDate('2027-01-01', '2026-10-12')).toBeUndefined();
    expect(normalizeBirthDate('1990-02-30', '2026-10-12')).toBeUndefined();
  });
});

describe('confirmation classifier', () => {
  const cases: [string, 'booking' | 'cancellation' | 'registration' | 'reschedule', 'affirm' | 'deny' | 'unclear'][] = [
    ['إيه', 'booking', 'affirm'],
    ['ايوه احجز', 'booking', 'affirm'],
    ['نعم لو سمحت', 'booking', 'affirm'],
    ['أكيد، الله يعطيك العافية', 'booking', 'affirm'],
    ['تمام', 'booking', 'affirm'],
    ['yes please', 'booking', 'affirm'],
    ['إيه ألغيه', 'cancellation', 'affirm'],
    ['ايوه سجلني', 'registration', 'affirm'],
    ['إيه انقله', 'reschedule', 'affirm'],
    // The read-back asks "أثبّت الحجز؟": the natural answers (reported from a live call: "ثبّت الحجز", "إيه ثبّت").
    ['ثبّت الحجز', 'booking', 'affirm'],
    ['إيه ثبّت', 'booking', 'affirm'],
    ['ثبته لي الله يعافيك', 'booking', 'affirm'],
    ['وثبّتها', 'booking', 'affirm'],
    ['أكّد الحجز', 'booking', 'affirm'],
    ['ثبّت التغيير', 'reschedule', 'affirm'],
    ['خلاص احجز', 'booking', 'affirm'],
    ['خلاص', 'booking', 'affirm'],
    ['طيب', 'booking', 'affirm'],
    ['يلا توكل على الله', 'booking', 'affirm'],
    ['على بركة الله', 'booking', 'affirm'],
    ['إيه افتحه', 'registration', 'affirm'],
    ['مشّه', 'booking', 'affirm'],
    ['لا', 'booking', 'deny'],
    ['لا لا خلني أفكر', 'booking', 'deny'],
    ['لأ شكرا', 'booking', 'deny'],
    ['لا خلاص', 'booking', 'deny'],
    ['بلاش', 'booking', 'deny'],
    ['مش عايز', 'booking', 'deny'],
    ['إيه بس خله الساعة خمس', 'booking', 'unclear'],
    ['إيه الساعة ست', 'booking', 'unclear'],
    ['إيه ٥', 'booking', 'unclear'],
    ['ايوه لا', 'booking', 'unclear'],
    ['ثبته بس بعد العصر', 'booking', 'unclear'],
    ['ثبت ولا فيه أبدر؟', 'booking', 'unclear'],
    ['إيه غلط', 'booking', 'unclear'],
    ['', 'booking', 'unclear'],
    ['إن شاء الله', 'booking', 'unclear'],
    ['متى الموعد؟', 'booking', 'unclear'],
    ['إيه أبي الدكتورة سارة', 'booking', 'unclear'],
    ['تمام مع الدكتور فهد', 'booking', 'unclear'],
    ['ألغيه', 'booking', 'unclear'],
    ['احجز', 'cancellation', 'unclear'],
    ['yes but tomorrow', 'booking', 'unclear'],
  ];
  it.each(cases)('"%s" (%s) → %s', (utterance, action, expected) => {
    expect(classifyConfirmation(utterance, action).decision).toBe(expected);
  });

  describe('with the model reading the reply', () => {
    const resolve = (utterance: string, model: CallerAnswer) => resolveConfirmation(classifyConfirmation(utterance, 'booking'), model);

    it('executes a clear yes only when the model also reads a yes', () => {
      expect(resolve('ثبّت الحجز', 'yes')).toBe('affirm');
      expect(resolve('ثبّت الحجز', 'unclear')).toBe('unclear');
      expect(resolve('ثبّت الحجز', 'no')).toBe('unclear'); // the two readings disagree: ask again
    });

    it('lets the model read wordings the list does not know, when nothing in them is a hedge, a detail or a no', () => {
      expect(classifyConfirmation('مافي مشكلة', 'booking')).toEqual({ decision: 'unclear', reason: 'unknown_words' });
      expect(resolve('مافي مشكلة', 'yes')).toBe('affirm');
      expect(resolve('إيه الوقت يناسبني يا أبو محمد', 'yes')).toBe('affirm');
      expect(resolve('مافي مشكلة', 'unclear')).toBe('unclear');
    });

    it('keeps the veto of the caller\'s words: a hedge, a detail, another action or a no is never a yes', () => {
      for (const utterance of ['إيه بس خله الساعة خمس', 'تمام مع الدكتور فهد', 'ثبته يوم الخميس', 'ألغيه', 'ايوه لا', 'شكرا', 'إن شاء الله', '']) {
        expect(resolve(utterance, 'yes')).not.toBe('affirm');
      }
      expect(resolve('لا', 'yes')).toBe('deny');
    });

    it('discards on a no read by the model unless the words clearly said yes', () => {
      expect(resolve('مو الحين', 'no')).toBe('deny');
      expect(resolve('خلني أفكر', 'no')).toBe('deny');
      expect(resolve('إيه', 'no')).toBe('unclear');
    });
  });
});

describe('pending actions', () => {
  let clock = 0;
  const SPEECH = 'للتأكيد: موعد عبدالله في طب الأسرة مع الدّكتور فهد العتيبي، يوم الثلاثاء ثلطعش أكتوبر، الساعة أربع مساءً. أثبّت الحجز؟';
  const make = (overrides?: { ttlMs?: number; maxReconfirmations?: number }) =>
    new PendingActions({ tenantId: 't', sessionId: 's', ttlMs: overrides?.ttlMs ?? 120_000, maxReconfirmations: overrides?.maxReconfirmations ?? 2, now: () => clock });
  const booking = (token = 'tok'): ActionTarget => ({ kind: 'booking', patientId: 'p1', slot: slot(token) });
  /** Proposes in `turn-N` and plays the whole read-back to the caller. */
  const proposeHeard = (pending: PendingActions, userTurn: number, target = booking()) => {
    const action = pending.propose(target, {}, SPEECH, { userTurn, turnId: `turn-${userTurn}` });
    pending.onTurnFinalized(`turn-${userTurn}`, true, SPEECH);
    return action;
  };
  /** The caller's reply in `turn-N` (as the model read it); a re-read spoken in that turn is played in full. */
  const reply = (pending: PendingActions, ref: string, userTurn: number, callerUtterance: string, callerAnswer: CallerAnswer = 'yes') => {
    const result = pending.confirm(ref, { userTurn, callerUtterance, callerAnswer, turnId: `turn-${userTurn}` });
    pending.onTurnFinalized(`turn-${userTurn}`, true, `ما فهمت ردّك. ${SPEECH}`);
    return result;
  };

  it('refuses confirmation in the proposing turn, accepts a clear yes in the next turn, and is single-use', () => {
    const pending = make();
    const action = pending.propose(booking(), {}, SPEECH, { userTurn: 3, turnId: 'turn-3' });
    expect(pending.confirm(action.ref, { userTurn: 3, callerUtterance: 'إيه', callerAnswer: 'yes', turnId: 'turn-3' })).toMatchObject({ ok: false, code: 'caller_confirmation_required' });
    pending.onTurnFinalized('turn-3', true, SPEECH);
    expect(reply(pending, action.ref, 4, 'إيه')).toMatchObject({ ok: true });
    expect(reply(pending, action.ref, 4, 'إيه')).toMatchObject({ ok: false, code: 'already_used' });
  });

  it('expires after one turn or after the TTL', () => {
    const pending = make({ ttlMs: 1_000 });
    const late = proposeHeard(pending, 1);
    expect(reply(pending, late.ref, 3, 'إيه')).toMatchObject({ ok: false, code: 'expired' });
    const slow = proposeHeard(pending, 5);
    clock += 1_001;
    expect(reply(pending, slow.ref, 6, 'إيه')).toMatchObject({ ok: false, code: 'expired' });
  });

  it('discards on a clear no', () => {
    const pending = make();
    const action = proposeHeard(pending, 1);
    expect(reply(pending, action.ref, 2, 'لا')).toMatchObject({ ok: false, code: 'declined' });
    expect(reply(pending, action.ref, 3, 'إيه')).toMatchObject({ ok: false, code: 'declined' });
  });

  it('re-arms on an unclear reply a bounded number of times, never executing it', () => {
    const pending = make({ maxReconfirmations: 2 });
    const action = proposeHeard(pending, 1);
    expect(reply(pending, action.ref, 2, 'إيه بس')).toMatchObject({ ok: false, code: 'confirmation_unclear', reconfirmationsLeft: 1 });
    expect(reply(pending, action.ref, 3, 'إن شاء الله')).toMatchObject({ ok: false, code: 'confirmation_unclear', reconfirmationsLeft: 0 });
    expect(reply(pending, action.ref, 4, 'إيه الساعة خمس')).toMatchObject({ ok: false, code: 'expired' });

    const second = proposeHeard(pending, 5);
    expect(reply(pending, second.ref, 6, 'مدري')).toMatchObject({ code: 'confirmation_unclear' });
    expect(reply(pending, second.ref, 7, 'ايوه')).toMatchObject({ ok: true });
  });

  it('keeps one pending action per session: a new proposal supersedes the old one', () => {
    const pending = make();
    const first = proposeHeard(pending, 1, booking('a'));
    const second = proposeHeard(pending, 1, booking('b'));
    expect(reply(pending, first.ref, 2, 'إيه')).toMatchObject({ ok: false, code: 'superseded' });
    expect(reply(pending, second.ref, 2, 'إيه')).toMatchObject({ ok: true });
    expect(reply(pending, 'C99', 2, 'إيه')).toMatchObject({ ok: false, code: 'unknown_action' });
  });

  it('drops an action whose proposing turn the caller never heard', () => {
    const pending = make();
    const heard = proposeHeard(pending, 1);
    expect(pending.current?.ref).toBe(heard.ref);
    const unheard = pending.propose(booking(), {}, SPEECH, { userTurn: 2, turnId: 'unheard' });
    pending.onTurnFinalized('unheard', false, '');
    expect(reply(pending, unheard.ref, 3, 'إيه')).toMatchObject({ ok: false, code: 'expired' });
  });

  it('fingerprints the exact operation', () => {
    const pending = make();
    const a = pending.propose(booking('x'), {}, SPEECH, { userTurn: 1, turnId: 'a' });
    const b = pending.propose(booking('x'), {}, SPEECH, { userTurn: 1, turnId: 'a' });
    const c = pending.propose(booking('y'), {}, SPEECH, { userTurn: 1, turnId: 'a' });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(c.fingerprint).not.toBe(a.fingerprint);
    expect(a.ref).not.toBe(b.ref);
  });

  describe('a yes counts only for a read-back the caller heard in full (plan step 8)', () => {
    it('never executes when the read-back was not heard, or only partly (barge-in): it is read again', () => {
      for (const heard of [undefined, '', 'للتأكيد: موعد عبدالله في طب الأسرة مع الدّكتور فهد العتيبي، يوم الثلاثاء']) {
        const pending = make();
        const action = pending.propose(booking(), {}, SPEECH, { userTurn: 1, turnId: 'turn-1' });
        pending.onTurnFinalized('turn-1', true, heard);
        expect(pending.confirm(action.ref, { userTurn: 2, callerUtterance: 'إيه', callerAnswer: 'yes', turnId: 'turn-2' })).toMatchObject({ ok: false, code: 'read_back_required' });
        pending.onTurnFinalized('turn-2', true, `خلني أعيد لك التفاصيل. ${SPEECH}`); // the re-read, played in full
        expect(pending.confirm(action.ref, { userTurn: 3, callerUtterance: 'إيه', callerAnswer: 'yes', turnId: 'turn-3' })).toMatchObject({ ok: true });
      }
    });

    it('never executes when another date or time was spoken in the same turn as the read-back (e.g. the model said the 15th)', () => {
      const pending = make();
      const action = pending.propose(booking(), {}, SPEECH, { userTurn: 1, turnId: 'turn-1' });
      pending.onTurnFinalized('turn-1', true, `تمام، بحجز لك يوم الخميس خمسطعش أكتوبر. ${SPEECH}`);
      expect(pending.confirm(action.ref, { userTurn: 2, callerUtterance: 'إيه', callerAnswer: 'yes', turnId: 'turn-2' })).toMatchObject({ ok: false, code: 'read_back_required' });
    });

    it('matches what was played regardless of spacing, diacritics and punctuation (TTS alignment)', () => {
      expect(readBackHeard(`لحظة أشيك لك${SPEECH.replace(/ /g, '').replace(/ّ/g, '')}`, SPEECH)).toBe(true);
      expect(readBackHeard(SPEECH.replace('ثلطعش', 'خمسطعش'), SPEECH)).toBe(false);
      expect(readBackHeard(`${SPEECH} عندنا كمان الساعة خمس`, SPEECH)).toBe(false);
    });

    it('does not let a yes given before or during the read-back count: a barged-in "إيه" leads to a re-read', () => {
      const pending = make({ maxReconfirmations: 1 });
      const action = pending.propose(booking(), {}, SPEECH, { userTurn: 1, turnId: 'turn-1' });
      pending.onTurnFinalized('turn-1', true, 'للتأكيد: موعد عبدالله'); // interrupted early
      expect(pending.confirm(action.ref, { userTurn: 2, callerUtterance: 'إيه', callerAnswer: 'yes', turnId: 'turn-2' })).toMatchObject({ code: 'read_back_required', reconfirmationsLeft: 0 });
      pending.onTurnFinalized('turn-2', true, 'خلني أعيد'); // interrupted again
      expect(pending.confirm(action.ref, { userTurn: 3, callerUtterance: 'إيه', callerAnswer: 'yes', turnId: 'turn-3' })).toMatchObject({ ok: false, code: 'expired' });
    });
  });
});

describe('session refs', () => {
  it('issues short stable refs per object and resolves only the right kind', () => {
    const refs = new SessionRefs();
    const service = { id: 'sys-service-1', name: 'الجلدية' };
    const a = refs.register('service', service);
    expect(a).toBe('V1');
    expect(refs.register('service', { ...service })).toBe('V1');
    expect(refs.register('slot', slot('t1'))).toBe('S1');
    expect(refs.register('slot', slot('t2'))).toBe('S2');
    expect(refs.resolve('service', ' v1 ')).toMatchObject({ id: 'sys-service-1' });
    expect(refs.resolve('practitioner', 'V1')).toBeUndefined();
    expect(refs.resolve('slot', 'S9')).toBeUndefined();
  });
});

describe('development-only patient verification', () => {
  const patient = (id: string, birthDate: string): PatientRecord => ({ id, fullName: `x ${id}`, firstName: 'x', birthDate, gender: 'female' });

  it('verifies on a single date-of-birth match, asks for more on several, and locks after repeated failures', () => {
    const v = new DevIdentifierDobVerification({ maxFailures: 3 });
    expect(v.productionGrade).toBe(false);
    expect(v.evaluate([patient('mother', '1992-11-20'), patient('child', '2020-05-09')], '2020-05-09')).toMatchObject({ status: 'verified', patient: { id: 'child' } });
    expect(v.isVerified('child')).toBe(true);
    expect(v.evaluate([patient('twin-a', '2020-05-09'), patient('twin-b', '2020-05-09')], '2020-05-09')).toEqual({ status: 'multiple' });
    expect(v.evaluate([patient('p', '1990-01-01')], '1990-01-02')).toEqual({ status: 'not_verified', attemptsLeft: 2 });
    expect(v.evaluate([], '1990-01-02')).toEqual({ status: 'not_verified', attemptsLeft: 1 });
    expect(v.evaluate([], '1990-01-02')).toEqual({ status: 'locked' });
    expect(v.evaluate([patient('p', '1990-01-01')], '1990-01-01')).toEqual({ status: 'locked' });
  });
});

describe('write ledger', () => {
  const ledger = (overrides?: { writeTimeoutMs?: number }) =>
    new WriteLedger({ system: 'test', writeTimeoutMs: overrides?.writeTimeoutMs ?? 1_000, readTimeoutMs: 200, maxReconcileAttempts: 2, log: silentLogger, now: () => Date.now() });
  const spec = (run: (signal: AbortSignal) => Promise<string>, reconcile: () => Promise<{ applied: true; result: string } | { applied: false }>) => ({
    actionRef: 'C1',
    kind: 'booking',
    patientKey: 'patient:p1',
    idempotencyKey: 'k',
    run,
    reconcile,
  });
  const neverReconciled = () => Promise.reject(new Error('should not reconcile'));

  it('records success, and treats business refusals and up-front rejections as definite failures', async () => {
    const l = ledger();
    expect(await l.execute(spec(() => Promise.resolve('ok'), neverReconciled))).toEqual({ status: 'succeeded', result: 'ok', reconciled: false });
    const refused = await l.execute(spec(() => Promise.reject(new SchedulingError('test', 'slot_unavailable', 'taken')), neverReconciled));
    expect(refused).toMatchObject({ status: 'failed', reconciled: false });
    const auth = await l.execute(spec(() => Promise.reject(new ProviderError('test', 'auth', 'no')), neverReconciled));
    expect(auth).toMatchObject({ status: 'failed', reconciled: false });
    expect(l.blocking('patient:p1')).toBeUndefined();
  });

  it('reconciles an ambiguous failure by reading instead of retrying', async () => {
    const l = ledger();
    let runs = 0;
    const applied = await l.execute(
      spec(
        () => {
          runs += 1;
          return Promise.reject(new ProviderError('test', 'unavailable', '502'));
        },
        () => Promise.resolve({ applied: true, result: 'found' }),
      ),
    );
    expect(applied).toEqual({ status: 'succeeded', result: 'found', reconciled: true });
    expect(runs).toBe(1);
    const notApplied = await l.execute(spec(() => Promise.reject(new ProviderError('test', 'timeout', 'slow')), () => Promise.resolve({ applied: false })));
    expect(notApplied).toMatchObject({ status: 'failed', reconciled: true });
  });

  it('times a hung write out under its own deadline, then reconciles', async () => {
    const l = ledger({ writeTimeoutMs: 30 });
    const outcome = await l.execute(
      spec(
        (signal) => new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason as Error))),
        () => Promise.resolve({ applied: true, result: 'late but applied' }),
      ),
    );
    expect(outcome).toEqual({ status: 'succeeded', result: 'late but applied', reconciled: true });
  });

  it('keeps an unresolved outcome blocking the patient, retries reconciliation once more, then gives up', async () => {
    const l = ledger();
    let reads = 0;
    const outcome = await l.execute(
      spec(
        () => Promise.reject(new ProviderError('test', 'unavailable', '503')),
        () => {
          reads += 1;
          return reads === 1 ? Promise.reject(new ProviderError('test', 'unavailable', 'still down')) : Promise.resolve({ applied: false });
        },
      ),
    );
    expect(outcome).toEqual({ status: 'unknown' });
    expect(l.blocking('patient:p1')).toMatchObject({ status: 'unknown' });
    expect(l.blocking('patient:other')).toBeUndefined();
    expect(await l.reconcileUnresolved()).toMatchObject([{ applied: false }]);
    expect(l.blocking('patient:p1')).toBeUndefined();

    const stuck = ledger();
    await stuck.execute(spec(() => Promise.reject(new ProviderError('test', 'timeout', 'x')), () => Promise.reject(new Error('down'))));
    expect(await stuck.reconcileUnresolved()).toEqual([]);
    expect(await stuck.reconcileUnresolved()).toEqual([]); // attempts exhausted
    expect(stuck.blocking('patient:p1')).toMatchObject({ status: 'unknown', reconcileAttempts: 2 });
  });

  it('drains in-flight writes before a session closes', async () => {
    const l = ledger();
    let finished = false;
    void l.execute(
      spec(
        () =>
          new Promise<string>((resolve) =>
            setTimeout(() => {
              finished = true;
              resolve('ok');
            }, 40),
          ),
        neverReconciled,
      ),
    );
    expect(await l.drain(1_000)).toBe(0);
    expect(finished).toBe(true);
  });
});
