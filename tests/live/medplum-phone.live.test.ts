import { afterAll, describe, expect, it } from 'vitest';
import { AppointmentTools } from '../../src/agent/tools/appointment-tools.js';
import { silentLogger } from '../../src/core/logger.js';
import { canonicalPhone } from '../../src/core/phone.js';
import { LIVE_MEDPLUM_ENABLED, LIVE_TENANT, type LiveMedplum, connectLiveMedplum, syntheticNationalId } from '../support/live-medplum.js';

/**
 * Phone lookup against real Medplum data stored in non-canonical spellings — as another hospital system
 * might hold them. Opt-in (`MUJEEB_LIVE_MEDPLUM=1`, `npm run test:live`); creates three synthetic test
 * patients per run (no appointments).
 */

let live: Promise<LiveMedplum> | undefined;
const connect = (): Promise<LiveMedplum> => (live ??= connectLiveMedplum());

describe.skipIf(!LIVE_MEDPLUM_ENABLED)('live: phone numbers stored in any spelling (Medplum)', () => {
  afterAll(async () => {
    if (live) await (await live).cleanup();
  });

  it('finds family members by one number whatever its stored spelling, and verifies them by date of birth', async () => {
    const m = await connect();
    // A synthetic number unique to this run, in the dataset's fake range (0500009XXX).
    const local = `0500009${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
    const canonical = canonicalPhone(local) ?? '';
    const grouped = `+966 ${canonical.slice(4, 6)} ${canonical.slice(6, 9)} ${canonical.slice(9)}`;
    const otherNumber = `0500009${String((Number(local.slice(-3)) + 1) % 1000).padStart(3, '0')}`;
    const create = async (name: string, birthDate: string, phone: string): Promise<string> => {
      const nationalId = syntheticNationalId();
      const response = await m.client.write(
        'POST',
        'Patient',
        {
          resourceType: 'Patient',
          active: true,
          name: [{ text: `مريض اختبار ${name}`, given: ['مريض'], family: `اختبار ${name}` }],
          birthDate,
          gender: 'female',
          telecom: [{ system: 'phone', value: phone, use: 'mobile' }],
          identifier: [{ system: m.settings.medplum.nationalIdSystem, value: nationalId }],
        },
        AbortSignal.timeout(30_000),
        { 'If-None-Exist': `identifier=${encodeURIComponent(m.settings.medplum.nationalIdSystem)}|${nationalId}` },
      );
      const id = (response.json as { id: string }).id;
      m.testPatientIds.add(id);
      return id;
    };
    const mother = await create('صيغة محلية', '1990-04-04', local);
    const child = await create('صيغة مجمعة', '2019-09-09', grouped);
    const stranger = await create('رقم آخر', '1990-04-04', otherNumber);

    // The failure: Medplum's phone search matches the stored text exactly, so the canonical form alone finds neither.
    const exact = (await m.client.read('Patient', [['phone', canonical]], AbortSignal.timeout(30_000))) as { entry?: { resource: { id: string } }[] };
    expect((exact.entry ?? []).map((e) => e.resource.id)).not.toContain(mother);

    // The adapter: one bounded search over the usual spellings, then a canonical comparison.
    const found = await m.system.findPatients(m.ctx(), { phone: canonical });
    expect(found.map((p) => p.id).sort()).toEqual([mother, child].sort());
    expect(found.every((p) => p.phone === canonical)).toBe(true);
    expect(found.map((p) => p.id)).not.toContain(stranger);

    // The tools: however the caller said it, the family phone is resolved by date of birth.
    const tools = new AppointmentTools({ scheduling: m.guarded, tenant: LIVE_TENANT, sessionId: `ses_live_phone_${Date.now()}`, timeZone: m.timeZone, log: silentLogger, verificationPolicy: 'dev-identifier-dob', readTimeoutMs: 15_000 });
    const turn = { userTurn: 1, callerUtterance: 'جوالي', turnId: 'turn-1', signal: AbortSignal.timeout(60_000) };
    const spoken = [...local].map((d) => ['صفر', 'واحد', 'اثنين', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة'][Number(d)]).join('، ');
    for (const said of [spoken, `+966 ${local}`, local.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)))]) {
      const asMother = await tools.execute('find_patient', JSON.stringify({ national_id: null, phone: said, birth_date: '1990-04-04' }), turn);
      expect(asMother.output, said).toMatchObject({ status: 'verified', patient: { first_name: 'مريض' } });
      const asChild = await tools.execute('find_patient', JSON.stringify({ national_id: null, phone: said, birth_date: '2019-09-09' }), turn);
      expect(asChild.output, said).toMatchObject({ status: 'verified' });
    }
    process.stdout.write(`\n[live] phone stored as "${local.replace(/\d/g, 'd')}" and "${grouped.replace(/\d/g, 'd')}": exact Medplum search found ${(exact.entry ?? []).length}, Mujeeb found ${found.length}\n`);
  }, 120_000);
});
