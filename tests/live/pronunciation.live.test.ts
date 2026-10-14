import { describe, expect, it } from 'vitest';
import { OpenAiResponsesModel } from '../../src/adapters/openai/responses-model.js';
import { loadAgentProfile } from '../../src/app/agent-profile.js';
import { loadSettings } from '../../src/config/settings.js';
import type { ChatMessage } from '../../src/ports/language-model.js';
import { chunkText } from '../../src/voice/text-chunker.js';

/**
 * Paid, opt-in prompt check: `npm run test:live`. Runs the real agent profile and pipes the reply
 * through the same chunker that feeds TTS, then checks the spoken text: no digits, Saudi-dialect
 * (not Fusha) number forms, required shadda. The appended data block stands in for future
 * tool/knowledge results (digits in, words out). Synthetic data only — no patient data.
 */

const env = process.env;
const hasOpenAi = Boolean(env['OPENAI_API_KEY'] && env['MUJEEB_LLM_MODEL']);

const SYNTHETIC_DATA = `

بيانات اصطناعية اعتمدتها العيادة لهذي المحادثة التجريبية، جاوب منها مباشرة إذا سُئلت عنها ولا تعتبرها معلومات مخترعة:
- موعد المتصل: الخميس 2026-10-15 الساعة 16:30 مع الدكتور سامي.
- موعد المتابعة: الأحد 2026-11-01 الساعة 13:20.
- سعر الكشف: 150 ريال. سعر التحليل الشامل: 1250 ريال.
- وقت الانتظار المتوقع: 15 دقيقة. مدة الجلسة: 45 دقيقة.
- نتائج التحاليل تطلع بعد 3 أيام.
- العيادة في الدور 2، غرفة 11.
- رقم الملف: 004271.
- رقم الجوال المسجل: 0551230467.`;

// Spoken digit forms the model may legitimately choose between.
const D2 = 'ا?ثنين';
const D3 = 'ثلاث[ةه]?';
const D4 = 'أربع[ةه]?';
const D6 = 'ستّ[ةه]?';
const D7 = 'سبع[ةه]?';

const ask = (text: string): ChatMessage[] => [{ role: 'user', text }];

const CASES: { name: string; messages: ChatMessage[]; expect?: RegExp }[] = [
  { name: 'time+date', messages: ask('متى موعدي بالضبط؟'), expect: /خمسطعش.*أربع ونص/ },
  { name: 'follow-up time', messages: ask('ومتى موعد المتابعة؟'), expect: /وحد[ةه] وثلث/ }, // not "وحدة وعشرين دقيقة"
  { name: 'price', messages: ask('كم سعر الكشف؟'), expect: /مية وخمسين ريال/ },
  { name: 'large price', messages: ask('وكم سعر التحليل الشامل؟'), expect: /ألف ومي?تين وخمسين/ },
  { name: 'duration', messages: ask('كم بنتظر تقريبًا لين يجي دوري؟'), expect: /خمسطعش دقيقة|ربع ساعة/ },
  { name: 'session length', messages: ask('كم مدة الجلسة؟'), expect: /خمس[ةه]? وأربعين|ثلاث أرباع/ },
  { name: 'day count', messages: ask('متى تطلع نتايج التحاليل؟'), expect: new RegExp(`${D3} أيام`) },
  { name: 'floor+room', messages: ask('وين مكان العيادة بالضبط؟'), expect: /حدعش/ },
  { name: 'file number', messages: ask('وش رقم ملفي؟'), expect: new RegExp(`صفر صفر ${D4} ${D2} ${D7} واحد`) },
  {
    name: 'phone number',
    messages: ask('عيد لي رقم الجوال المسجل عندكم عشان أتأكد إنه صح'),
    expect: new RegExp(`صفر خمس[ةه]? خمس[ةه]? واحد ${D2} ${D3} صفر ${D4} ${D6} ${D7}`),
  },
  { name: 'user digits', messages: ask('طيب لو أجي الساعة 9:15 الصبح يوم 16 بدال، ينفع؟') },
  {
    name: 'shadda',
    messages: [
      { role: 'user', text: 'مين الدكتور اللي بشوفه؟' },
      { role: 'assistant', text: 'موعدك مع الدّكتور سامي.' },
      { role: 'user', text: 'تمام، وكم مرة لازم أراجعه بعدين؟' },
    ],
  },
];

const DIGITS = /[0-9٠-٩۰-۹]/;
/** Words the prompt requires with shadda; their bare spelling must never reach TTS. */
const MISSING_SHADDA = /الدكتور|مرة|ستة/;
/** Fusha number/time forms; the Saudi-dialect equivalents are in the prompt. */
const FUSHA = new RegExp(
  [
    '(?<!\\p{L})[وب]?(?:مئ|مائ)', // مية، ميتين
    'إحدىعش|احدىعش',
    '(?:عشر|ثلاث|أربع|خمس|ست|سبع|ثمان|تسع)ون', // عشرين، ثلاثين...
    '(?:أحد|إحدى|اثنا|اثنتا|اثني|اثنتي|ثلاث[ةه]?|أربع[ةه]?|خمس[ةه]?|ستّ?[ةه]?|سبع[ةه]?|ثماني?[ةه]?|تسع[ةه]?) عشر', // إحدعش، خمسطعش...
    '(?:الحادي|الثاني|الثالث|الرابع|الخامس|السادس|السابع|الثامن|التاسع) عشر',
    'اثنان|اثنتان|ألفان',
    'الساعة (?:الواحدة|الثانية|الثالثة|الرابعة|الخامسة|السادسة|السابعة|الثامنة|التاسعة|العاشرة|الحادية)',
    'والنصف|والربع|والثلث|إلا الربع|إلا ربعًا',
    'دقائق',
    'صباحًا|صباحاً|مساءً|مساءا|عصرًا|عصراً|ظهرًا|ظهراً|ريالًا|ريالاً',
  ].join('|'),
  'u',
);

describe.skipIf(!hasOpenAi)('live: spoken-text pronunciation rules', () => {
  it('replies reach TTS with numbers written as Saudi-dialect words', async () => {
    const settings = loadSettings({ ...env, MUJEEB_STT_PROVIDER: 'fake', MUJEEB_TTS_PROVIDER: 'fake' });
    const profile = await loadAgentProfile(settings.agentProfilePath);
    const model = new OpenAiResponsesModel({
      apiKey: settings.llm.apiKey ?? '',
      model: settings.llm.model ?? '',
      ...(settings.llm.reasoningEffort ? { reasoningEffort: settings.llm.reasoningEffort } : {}),
      maxOutputTokens: settings.llm.maxOutputTokens ?? 300,
    });

    async function* deltas(messages: ChatMessage[]): AsyncGenerator<string> {
      const request = { instructions: profile.instructions + SYNTHETIC_DATA, messages };
      for await (const event of model.stream(request, { signal: AbortSignal.timeout(30_000) })) {
        if (event.type === 'text_delta') yield event.text;
      }
    }

    const results = await Promise.all(
      CASES.map(async ({ name, messages, expect: expected }) => {
        const segments: string[] = [];
        for await (const segment of chunkText(deltas(messages))) segments.push(segment);
        return { name, segments, expected };
      }),
    );

    for (const { name, segments } of results) {
      process.stdout.write(`\n[live] ${name}\n${segments.map((s) => `  → ${s}`).join('\n')}\n`);
    }
    const failures: string[] = [];
    for (const { name, segments, expected } of results) {
      const spoken = segments.join(' ');
      if (spoken === '') failures.push(`${name}: empty reply`);
      if (DIGITS.test(spoken)) failures.push(`${name}: digits → ${spoken.match(DIGITS)?.[0]}`);
      if (MISSING_SHADDA.test(spoken)) failures.push(`${name}: missing shadda → ${spoken.match(MISSING_SHADDA)?.[0]}`);
      if (FUSHA.test(spoken)) failures.push(`${name}: fusha → ${spoken.match(FUSHA)?.[0]}`);
      if (expected && !expected.test(spoken)) failures.push(`${name}: expected ${expected}`);
    }
    process.stdout.write(`\n[live] failures: ${failures.length === 0 ? 'none' : `\n  ${failures.join('\n  ')}`}\n`);
    expect(failures).toEqual([]);
  });
});
