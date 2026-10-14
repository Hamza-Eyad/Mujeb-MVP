import { describe, expect, it } from 'vitest';
import { canonicalPhone, isCanonicalPhone, parsePhone, phoneSearchForms, samePhone } from '../../src/core/phone.js';

/** Provider-independent phone normalization and matching (core/phone). */

const CANONICAL = '+966500000103';

describe('Saudi mobile numbers in any written or spoken form', () => {
  it.each([
    ['0500000103'],
    ['500000103'],
    ['966500000103'],
    ['+966500000103'],
    ['00966500000103'],
    // The country code followed by the trunk zero — previously turned into the wrong number +9660500000103.
    ['+966 0500000103'],
    ['00966 05 0000 0103'],
    ['9660500000103'],
    // Separators and grouping.
    ['050 000 0103'],
    ['05-0000-0103'],
    ['(050) 000-0103'],
    ['+966 50 000 0103'],
    ['+966-50-000-0103'],
    ['0 5 0 0 0 0 0 1 0 3'],
    ['050.000.0103'],
    ['tel:+966500000103'],
    // Arabic-Indic and Persian digits, also mixed with ASCII.
    ['٠٥٠٠٠٠٠١٠٣'],
    ['۰۵۰۰۰۰۰۱۰۳'],
    ['05٠٠٠٠٠١٠٣'],
    ['+٩٦٦٥٠٠٠٠٠١٠٣'],
    // Invisible direction marks that mixed Arabic/number text carries.
    ['‎0500000103'],
    ['0500000103‏'],
    ['‫+966 50 000 0103‬'],
    // Spoken digits (STT), with commas, the "و" prefix, spelling variants and mixed digits.
    ['صفر خمسة صفر صفر صفر صفر صفر واحد صفر ثلاثة'],
    ['صفر، خمسة، صفر، صفر، صفر، صفر، صفر، واحد، صفر، ثلاثة'],
    ['خمسه صفر صفر صفر صفر صفر واحد صفر ثلاث'],
    ['زائد تسعة ستة ستة خمسة صفر صفر صفر صفر صفر واحد صفر ثلاثة'],
    ['05 صفر صفر صفر صفر صفر واحد صفر وثلاثة'],
    ['zero five zero zero zero zero zero one zero three'],
  ])('%j → +966500000103', (input) => {
    expect(parsePhone(input)).toEqual({ ok: true, e164: CANONICAL, saudiMobile: true });
  });

  it('reads every digit word', () => {
    expect(canonicalPhone('صفر خمسة واحد اثنين ثلاثة أربعة خمسة ستة سبعة ثمانية')).toBe('+966512345678');
    expect(canonicalPhone('صفر خمس تسعة ثنين ثنتين إثنين ست سبع ثمان تسع')).toBe('+966592226789');
  });
});

describe('rejected rather than guessed', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['abc', 'invalid'],
    ['جوالي 0500000103', 'invalid'], // other words
    ['خمسين صفر صفر', 'invalid'], // a number word that is not one digit
    ['05000001034', 'invalid'], // one digit too many
    ['050000010', 'invalid'], // one digit too few
    ['0966500000103', 'invalid'], // ambiguous prefix
    ['05+00000103', 'invalid'], // a plus inside the number
    ['++966500000103', 'invalid'],
    ['0400000103', 'invalid'], // not a Saudi number range
    ['0112345678', 'not_mobile'], // Riyadh landline
    ['+966 11 234 5678', 'not_mobile'],
    ['920012345', 'not_mobile'], // unified number
    ['8001234567', 'not_mobile'], // toll-free
  ])('%j → %s', (input, reason) => {
    expect(parsePhone(input)).toEqual({ ok: false, reason });
  });

  it('accepts other countries only with an explicit international prefix', () => {
    expect(parsePhone('+447700900123')).toEqual({ ok: true, e164: '+447700900123', saudiMobile: false });
    expect(parsePhone('00447700900123')).toEqual({ ok: true, e164: '+447700900123', saudiMobile: false });
    expect(parsePhone('447700900123')).toEqual({ ok: false, reason: 'invalid' });
    expect(parsePhone('+1234')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('matching and searching', () => {
  it('compares written forms by the number they denote', () => {
    expect(samePhone('0500000103', '+966 50 000 0103')).toBe(true);
    expect(samePhone('٠٥٠٠٠٠٠١٠٣', 'صفر خمسة صفر صفر صفر صفر صفر واحد صفر ثلاثة')).toBe(true);
    expect(samePhone('0500000103', '0500000104')).toBe(false);
    expect(samePhone('0500000103', 'not a number')).toBe(false);
    expect(samePhone(undefined, '0500000103')).toBe(false);
    expect(samePhone('garbage', 'garbage')).toBe(false); // unparseable values match nothing, not each other
  });

  it('knows the canonical form', () => {
    expect(isCanonicalPhone('+966500000103')).toBe(true);
    expect(isCanonicalPhone('0500000103')).toBe(false);
    expect(isCanonicalPhone('+9660500000103')).toBe(false); // valid-looking E.164, wrong number
  });

  it('lists the spellings a system may have stored, each denoting the same number', () => {
    const forms = phoneSearchForms(CANONICAL);
    expect(forms).toEqual(['+966500000103', '966500000103', '00966500000103', '0500000103', '500000103', '+966 50 000 0103', '+966-50-000-0103', '050 000 0103', '050-000-0103']);
    for (const f of forms) expect(samePhone(f, CANONICAL), f).toBe(true);
    expect(phoneSearchForms('+447700900123')).toEqual(['+447700900123']);
    expect(phoneSearchForms('garbage')).toEqual([]);
  });
});
