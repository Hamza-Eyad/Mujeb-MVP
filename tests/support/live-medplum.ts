import { readFileSync } from 'node:fs';
import { MedplumClient } from '../../src/adapters/medplum/client.js';
import { MedplumSchedulingSystem } from '../../src/adapters/medplum/medplum-scheduling.js';
import { SEED_KEY_SYSTEM } from '../../src/adapters/medplum/seed.js';
import { type Settings, loadSettings } from '../../src/config/settings.js';
import { type SchedulingDataset, parseSchedulingDataset, resolveDatasetDates } from '../../src/contracts/scheduling-dataset.js';
import { SchedulingError } from '../../src/core/errors.js';
import { nationalIdChecksumValid } from '../../src/core/identifiers.js';
import type { Logger } from '../../src/core/logger.js';
import { type LocalDate, addDays, instantToZoned, zonedToInstant } from '../../src/core/zoned-time.js';
import type {
  AppointmentListQuery,
  AppointmentRecord,
  AvailabilityQuery,
  BookingRequest,
  CancelRequest,
  DirectorySearchQuery,
  PatientLookup,
  PatientRecord,
  RegisterPatientRequest,
  RescheduleRequest,
  SchedulingContext,
  SchedulingSystem,
} from '../../src/ports/scheduling.js';

/**
 * Live access to the Medplum sandbox (project `Mujeb-MVP`) for the opt-in live suites. Synthetic data only.
 *
 * Enabled only with `MUJEEB_LIVE_MEDPLUM=1` plus `MEDPLUM_CLIENT_ID` / `MEDPLUM_CLIENT_SECRET`, through
 * `npm run test:live`; never part of `npm test`. Live tests write only for patients they register
 * themselves (`LIVE_PATIENT_PHONE`), and `guarded` refuses any reschedule or cancellation of an appointment
 * that does not belong to one of them — the seeded scenarios and any manual records are never changed.
 * `cleanup()` cancels whatever the run booked.
 */

const env = process.env;
export const LIVE_MEDPLUM_ENABLED = env['MUJEEB_LIVE_MEDPLUM'] === '1' && Boolean(env['MEDPLUM_CLIENT_ID'] && env['MEDPLUM_CLIENT_SECRET']);
export const LIVE_TENANT = { tenantId: 'demo', agentId: 'demo-clinic' } as const;
/** Phone of every patient the live tests register (outside the dataset's numbers). */
export const LIVE_PATIENT_PHONE = '+966500000199';
const DATASET_FILE = 'config/test-data/demo-clinic.dataset.json';

export interface LivePatient {
  record: PatientRecord;
  nationalId: string;
  birthDate: LocalDate;
}

export interface LiveMedplum {
  settings: Settings;
  client: MedplumClient;
  /** The real adapter. Prefer `guarded` for anything that writes. */
  system: MedplumSchedulingSystem;
  /** The same adapter, refusing to reschedule/cancel appointments of patients this run did not register. */
  guarded: SchedulingSystem;
  dataset: SchedulingDataset;
  /** Clinic-local day the seed resolved its relative dates against (read back from the seeded leave block). */
  anchorDate: LocalDate;
  timeZone: string;
  ctx: (signal?: AbortSignal) => SchedulingContext;
  /** Registers a synthetic patient for this run (unique national ID failing the checksum). */
  registerTestPatient: (label: string, birthDate?: LocalDate) => Promise<LivePatient>;
  /** Patients registered (or recognised) by this run. */
  testPatientIds: Set<string>;
  /** Cancels every active appointment of this run's patients. */
  cleanup: () => Promise<{ cancelled: number; failed: number }>;
}

let idSeq = 0;
/** A fresh, well-formed national ID that fails the checksum (never a real person). */
export function syntheticNationalId(): string {
  const body = `1${String((Date.now() + (idSeq += 1)) % 100_000_000).padStart(8, '0')}`;
  for (let check = 0; check < 10; check += 1) {
    const id = `${body}${check}`;
    if (!nationalIdChecksumValid(id)) return id;
  }
  throw new Error('unreachable: at most one check digit is valid');
}

export function liveSettings(): Settings {
  return loadSettings({ ...env, MUJEEB_LLM_PROVIDER: 'fake', MUJEEB_STT_PROVIDER: 'fake', MUJEEB_TTS_PROVIDER: 'fake', MUJEEB_SCHEDULING_PROVIDER: 'none' });
}

export async function connectLiveMedplum(options?: { fetch?: typeof fetch; log?: Logger }): Promise<LiveMedplum> {
  const settings = liveSettings();
  const { clientId, clientSecret } = settings.medplum;
  if (!clientId || !clientSecret) throw new Error('Live Medplum tests need MEDPLUM_CLIENT_ID and MEDPLUM_CLIENT_SECRET');
  const client = new MedplumClient({
    baseUrl: settings.medplum.baseUrl,
    clientId,
    clientSecret,
    ...(options?.fetch ? { fetch: options.fetch } : {}),
    ...(options?.log ? { log: options.log } : {}),
  });
  const system = new MedplumSchedulingSystem({ tenantId: LIVE_TENANT.tenantId, client, nationalIdSystem: settings.medplum.nationalIdSystem, directoryTtlMs: settings.medplum.directoryTtlMs });
  const dataset = parseSchedulingDataset(JSON.parse(readFileSync(DATASET_FILE, 'utf8')));
  const timeZone = dataset.clinic.timezone;
  const ctx = (signal?: AbortSignal): SchedulingContext => ({ tenant: LIVE_TENANT, signal: signal ?? AbortSignal.timeout(30_000), correlationId: 'live-test' });
  const anchorDate = await seedAnchor(client, dataset, timeZone);

  const testPatientIds = new Set<string>();
  const registerTestPatient = async (label: string, birthDate: LocalDate = '1991-02-03'): Promise<LivePatient> => {
    const nationalId = syntheticNationalId();
    const record = await system.registerPatient(ctx(), {
      patient: { fullName: `مريض اختبار ${label}`, nationalId, phone: LIVE_PATIENT_PHONE, birthDate, gender: 'male' },
      idempotencyKey: `live-${nationalId}`,
    });
    testPatientIds.add(record.id);
    return { record, nationalId, birthDate };
  };
  const cleanup = async (): Promise<{ cancelled: number; failed: number }> => {
    let cancelled = 0;
    let failed = 0;
    for (const patientId of testPatientIds) {
      const list = await system.listAppointments(ctx(), { patientId }).catch(() => []);
      for (const a of list) {
        try {
          await system.cancel(ctx(), { appointmentId: a.id, reason: 'live test cleanup', idempotencyKey: `cleanup-${a.id}` });
          cancelled += 1;
        } catch {
          failed += 1;
        }
      }
    }
    return { cancelled, failed };
  };
  return { settings, client, system, guarded: guardWrites(system, testPatientIds, ctx), dataset, anchorDate, timeZone, ctx, registerTestPatient, testPatientIds, cleanup };
}

/** The seed's anchor day, read back from its leave block; fails clearly when the seeded scenarios have expired. */
async function seedAnchor(client: MedplumClient, dataset: SchedulingDataset, timeZone: string): Promise<LocalDate> {
  const block = dataset.blocks[0];
  const practitioner = dataset.practitioners.find((p) => p.key === block?.practitionerKey);
  if (!block || !practitioner) throw new Error('The dataset needs a leave block');
  const key = `block:${block.key}:schedule:${practitioner.key}:${practitioner.serviceKeys[0] ?? ''}`;
  const json = (await client.read('Slot', [['identifier', `${SEED_KEY_SYSTEM}|${key}`]], AbortSignal.timeout(30_000))) as { entry?: { resource?: { start?: string } }[] };
  const start = json.entry?.[0]?.resource?.start;
  if (start === undefined) throw new Error('The Medplum sandbox is not seeded: run `npm run seed:medplum -- --apply` first');
  const anchor = addDays(instantToZoned(new Date(start), timeZone).date, -block.fromDayOffset);
  const earliest = resolveDatasetDates(dataset, anchor).appointments.map((a) => zonedToInstant(a.date, a.time, timeZone).getTime());
  if (Math.min(...earliest) <= Date.now()) {
    throw new Error(`The seeded scenarios (anchor ${anchor}) have started to expire: run \`npm run seed:medplum -- --apply --reset-appointments\` first`);
  }
  return anchor;
}

/** Writes are allowed only for appointments of patients this run registered (`own` grows with each registration). */
export function guardWrites(system: SchedulingSystem, own: ReadonlySet<string>, ctx: () => SchedulingContext): SchedulingSystem {
  const ensureOwn = async (appointmentId: string): Promise<void> => {
    const appointment = await system.getAppointment(ctx(), appointmentId).catch(() => undefined);
    if (appointment !== undefined && !own.has(appointment.patientId)) {
      throw new Error('live guard: refusing to change an appointment that does not belong to a patient registered by this test run');
    }
  };
  return {
    name: system.name,
    capabilities: system.capabilities,
    searchDirectory: (c: SchedulingContext, q: DirectorySearchQuery) => system.searchDirectory(c, q),
    findAvailability: (c: SchedulingContext, q: AvailabilityQuery) => system.findAvailability(c, q),
    findPatients: (c: SchedulingContext, l: PatientLookup) => system.findPatients(c, l),
    registerPatient: async (c: SchedulingContext, r: RegisterPatientRequest) => {
      const created = await system.registerPatient(c, r);
      (own as Set<string>).add(created.id);
      return created;
    },
    getAppointment: (c: SchedulingContext, id: string) => system.getAppointment(c, id),
    listAppointments: (c: SchedulingContext, q: AppointmentListQuery): Promise<readonly AppointmentRecord[]> => system.listAppointments(c, q),
    book: async (c: SchedulingContext, r: BookingRequest) => {
      if (!own.has(r.patientId)) {
        // An unknown patient is left to the adapter (`not_found`); an existing one that is not ours is refused.
        const exists = await system.listAppointments(c, { patientId: r.patientId }).then(
          () => true,
          (e: unknown) => !(e instanceof SchedulingError && e.kind === 'not_found'),
        );
        if (exists) throw new Error('live guard: refusing to book for a patient not registered by this test run');
      }
      return system.book(c, r);
    },
    reschedule: async (c: SchedulingContext, r: RescheduleRequest) => {
      await ensureOwn(r.appointmentId);
      return system.reschedule(c, r);
    },
    cancel: async (c: SchedulingContext, r: CancelRequest) => {
      await ensureOwn(r.appointmentId);
      return system.cancel(c, r);
    },
  };
}
