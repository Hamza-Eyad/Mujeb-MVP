import { normalizeArabic } from '../../core/arabic-text.js';

/**
 * The caller's reply to a read-back ("shall I book …?"), decided from two readings (DECISIONS A16):
 *
 * - `classifyConfirmation` reads the caller's own STT transcript — never text produced by the model. It
 *   knows the common Saudi ways to say yes ("إيه", "ثبّته", "توكل على الله", "خلاص احجز") and no, and it
 *   flags anything that may be a hedge, a question, a correction or a different detail (a time, a day, a
 *   doctor): those are never a yes, whatever the model reads.
 * - The model's reading (`caller_answer` on `confirm_pending_action`) covers wordings the list does not know.
 *
 * `resolveConfirmation` executes only when the model reads a yes AND the words either say yes or contain
 * nothing but words the list does not know — no hedge, no detail, no "no".
 */

export type ConfirmationDecision = 'affirm' | 'deny' | 'unclear';
export type ConfirmableAction = 'registration' | 'booking' | 'reschedule' | 'cancellation';
/** The model's reading of the caller's reply. */
export type CallerAnswer = 'yes' | 'no' | 'unclear';

export interface ConfirmationResult {
  decision: ConfirmationDecision;
  /** For logs/tests: why this decision (never the caller's words). `unknown_words` is the only one the model's reading can turn into a yes. */
  reason: 'affirm' | 'deny' | 'empty' | 'no_answer' | 'mixed' | 'hedge' | 'detail_mentioned' | 'unknown_words' | 'other_action_verb';
}

const words = (...list: string[]): ReadonlySet<string> => new Set(list.flatMap((w) => normalizeArabic(w).split(' ')).filter((w) => w !== ''));

/** Imperative stems with the object/benefactive endings callers attach: ثبّت → ثبّته، ثبّتها، ثبّتلي، ثبّتيه … */
const SUFFIXES = ['', 'ه', 'ها', 'و', 'وه', 'وها', 'ي', 'يه', 'يها', 'لي', 'هلي', 'هالي', 'لنا'];
const verbs = (...stems: string[]): string[] => stems.flatMap((s) => SUFFIXES.map((x) => s + x));

const AFFIRM = words(
  'إيه', 'ايوه', 'ايوا', 'اي', 'إي', 'نعم', 'أكيد', 'تمام', 'أوكي', 'اوك', 'اوكيه', 'صح', 'صحيح', 'موافق', 'موافقة', 'ماشي',
  'بالضبط', 'مضبوط', 'طبعا', 'زين', 'يب', 'يس', 'ممتاز', 'حلو', 'مناسب', 'يناسبني', 'متأكد', 'متأكدة', 'ياريت', 'ياليت',
  'توكل', 'توكلي', 'توكلنا', 'بركة', 'بالبركة', 'أبيه', 'أبيها', 'أبغاه', 'أبغاها',
  // Generic "go ahead / confirm it" verbs, for any action. ثبّت is what the read-back itself asks ("أثبّت الحجز؟").
  ...verbs('ثبت', 'اثبت', 'أكد', 'اعتمد', 'كمل', 'نفذ', 'سو', 'سوي'),
  'مشه', 'مشها', 'مشيه', 'مشيها', // "مشّه" = let it go through (bare "مش" is "not")
  'ok', 'okay', 'yes', 'yeah', 'yep', 'sure', 'confirm', 'confirmed',
);

/** Agreement only when nothing in the reply says no: "خلاص" is a yes alone, but "لا خلاص" is a no. */
const WEAK_AFFIRM = words('طيب', 'خلاص', 'يلا');

/** Verbs that confirm one specific action — affirmative only for that action. */
const ACTION_VERBS: Record<ConfirmableAction, ReadonlySet<string>> = {
  booking: words(...verbs('احجز', 'احجزي'), 'book'),
  reschedule: words(...verbs('انقل', 'عدل', 'حول'), 'غيره', 'غيرها', 'غيرهالي', 'reschedule', 'move'),
  cancellation: words(...verbs('الغ', 'الغي', 'كنسل', 'كنسلي', 'شيل'), 'cancel'),
  registration: words(...verbs('سجل', 'سجلي', 'افتح'), 'سجلني', 'register'),
};

const DENY = words(
  'لا', 'لأ', 'لالا', 'no', 'nope', 'مو', 'مش', 'ابد', 'ابدا', 'مابي', 'مابغى', 'ماابي', 'ماابغى', 'مابيه', 'مابيها', 'مابغاه', 'مابغاها',
  'بلاش', 'انسى', 'انساه', 'انساها',
);

/** Hesitation, conditions, alternatives, corrections and questions: never a confirmation. */
const HEDGE = words(
  'بس', 'لحظة', 'لحظه', 'انتظر', 'استنى', 'استنا', 'اصبر', 'دقيقة', 'ثانية', 'ثواني', 'خلني', 'أفكر', 'بفكر', 'اشوف', 'ممكن', 'يمكن', 'مدري',
  'ادري', 'شوي', 'غير', 'بدل', 'بدال', 'عوض', 'ثاني', 'آخر', 'ولا', 'او', 'غلط', 'خطأ', 'قصدي', 'اقصد', 'خله', 'خلها', 'خليه', 'خليها',
  'وش', 'ايش', 'ليش', 'ليه', 'كم', 'متى', 'هل', 'مين', 'وين', 'فين', 'كيف', 'شلون', 'ما', 'إذا', 'اذا', 'لكن', 'بعدين',
  'but', 'wait', 'maybe', 'change', 'or',
);

/** Days, times, numbers and doctors: the caller may be correcting a detail, so ask again rather than guess. */
const DETAIL = words(
  'الساعة', 'ساعة', 'الصبح', 'الصباح', 'صباحا', 'الفجر', 'الضحى', 'الظهر', 'ظهرا', 'العصر', 'المغرب', 'العشا', 'مساء', 'مساءا', 'المساء',
  'بالليل', 'الليل', 'بكرة', 'بكرا', 'اليوم', 'الجاي', 'القادم', 'الشهر', 'قبل', 'بعد',
  'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأسبوع', 'يوم',
  'واحد', 'وحدة', 'ثنين', 'اثنين', 'ثنتين', 'ثلاث', 'ثلاثة', 'أربع', 'أربعة', 'خمس', 'خمسة', 'ست', 'ستة', 'سبع', 'سبعة',
  'ثمان', 'ثمانية', 'تسع', 'تسعة', 'عشر', 'عشرة', 'إحدعش', 'حدعش', 'اطنعش', 'اثنعش', 'ونص', 'وربع', 'وثلث', 'نص', 'ربع', 'ثلث', 'إلا',
  'دكتور', 'الدكتور', 'دكتورة', 'الدكتورة', 'د',
);

/** Politeness and filler that carry no decision. */
const NEUTRAL = words(
  'يا', 'أخوي', 'اختي', 'الله', 'والله', 'يعطيك', 'العافية', 'يعافيك', 'لو', 'سمحت', 'من', 'فضلك', 'شكرا', 'مشكور', 'مشكورة',
  'يخليك', 'تسلم', 'يسعدك', 'يجزاك', 'خير', 'إن', 'شاء', 'إنشاءالله', 'على', 'و', 'كذا', 'هذا', 'هذي', 'هو', 'هي', 'الموعد',
  'موعد', 'الحجز', 'حجز', 'التسجيل', 'الملف', 'الإلغاء', 'التغيير', 'التعديل', 'عليه', 'عليها', 'لي', 'لنا', 'تكفى', 'بالله',
  'الحين', 'الان', 'حالا', 'شيخ', 'الغالي', 'حبيبي', 'مرة', 'جدا', 'please', 'thanks', 'thank', 'you', 'it',
);

type Category = 'affirm' | 'weak' | 'deny' | 'hedge' | 'detail' | 'other_verb' | 'neutral' | 'unknown';

export function classifyConfirmation(utterance: string, action: ConfirmableAction): ConfirmationResult {
  const normalized = normalizeArabic(utterance);
  const tokens = normalized === '' ? [] : normalized.split(' ');
  if (tokens.length === 0) return { decision: 'unclear', reason: 'empty' };

  let affirm = 0;
  let weak = 0;
  let deny = 0;
  const seen = new Set<Category>();
  for (const token of tokens) {
    const category = categorize(token, action);
    if (category === 'affirm') affirm += 1;
    else if (category === 'weak') weak += 1;
    else if (category === 'deny') deny += 1;
    else seen.add(category);
  }

  if (deny > 0) return affirm > 0 ? { decision: 'unclear', reason: 'mixed' } : { decision: 'deny', reason: 'deny' };
  if (seen.has('hedge')) return { decision: 'unclear', reason: 'hedge' };
  if (seen.has('detail')) return { decision: 'unclear', reason: 'detail_mentioned' };
  if (seen.has('other_verb')) return { decision: 'unclear', reason: 'other_action_verb' };
  if (seen.has('unknown')) return { decision: 'unclear', reason: 'unknown_words' };
  if (affirm + weak > 0) return { decision: 'affirm', reason: 'affirm' };
  return { decision: 'unclear', reason: 'no_answer' }; // politeness only ("شكرا")
}

/**
 * The final decision from the caller's words and the model's reading of them. The words keep a veto:
 * a "no" is a no; a hedge, a detail or another action is never a yes. A "no" read by the model discards
 * the action unless the words clearly said yes (discarding never writes anything).
 */
export function resolveConfirmation(words: ConfirmationResult, model: CallerAnswer): ConfirmationDecision {
  if (words.decision === 'deny') return 'deny';
  if (model === 'no') return words.decision === 'affirm' ? 'unclear' : 'deny';
  if (model === 'yes' && (words.decision === 'affirm' || words.reason === 'unknown_words')) return 'affirm';
  return 'unclear';
}

function categorize(token: string, action: ConfirmableAction): Category {
  const direct = lookup(token, action);
  if (direct !== 'unknown') return direct;
  // A leading conjunction ("وثبّته", "فاحجز"). A stripped "no" stays ambiguous ("ولا" = "or").
  if (token.length > 2 && (token.startsWith('و') || token.startsWith('ف'))) {
    const stripped = lookup(token.slice(1), action);
    return stripped === 'deny' ? 'hedge' : stripped;
  }
  return 'unknown';
}

function lookup(token: string, action: ConfirmableAction): Category {
  if (AFFIRM.has(token) || ACTION_VERBS[action].has(token)) return 'affirm';
  if (WEAK_AFFIRM.has(token)) return 'weak';
  if (DENY.has(token)) return 'deny';
  if (HEDGE.has(token)) return 'hedge';
  if (DETAIL.has(token) || /\d/.test(token)) return 'detail';
  if ((Object.keys(ACTION_VERBS) as ConfirmableAction[]).some((a) => a !== action && ACTION_VERBS[a].has(token))) return 'other_verb';
  if (NEUTRAL.has(token)) return 'neutral';
  return 'unknown';
}
