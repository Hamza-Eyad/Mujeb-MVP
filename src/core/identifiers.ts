/**
 * Canonical forms for patient identifiers at the scheduling boundary. Spoken/typed input is
 * normalized to these forms before it reaches any scheduling adapter.
 */

/** E.164, e.g. `+966500000101`. */
const E164 = /^\+[1-9]\d{7,14}$/;

/** Saudi national ID (starts with 1) or Iqama (starts with 2): 10 ASCII digits. */
const NATIONAL_ID = /^[12]\d{9}$/;

export function isE164Phone(value: string): boolean {
  return E164.test(value);
}

export function isNationalIdFormat(value: string): boolean {
  return NATIONAL_ID.test(value);
}

/**
 * Luhn checksum over all 10 digits — the check commonly used for Saudi ID/Iqama numbers.
 * Synthetic test data deliberately fails it so it can never match a real person.
 */
export function nationalIdChecksumValid(value: string): boolean {
  if (!isNationalIdFormat(value)) return false;
  let sum = 0;
  for (let i = 0; i < value.length; i += 1) {
    let digit = Number(value[i]);
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}
