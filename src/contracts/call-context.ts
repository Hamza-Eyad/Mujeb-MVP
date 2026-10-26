/**
 * One inbound phone call as the telephony gateway reported it. Provider-neutral: no SIP or gateway names.
 * Numbers are raw strings as received; routing matches `dialed` exactly against configured route keys.
 */
export interface CallContext {
  /** The gateway's id for the call: correlates our logs with the gateway's. */
  readonly callId: string;
  /** What the caller dialed (a DID, or a SIP address for a clinic PBX that routes to us directly). The routing key. */
  readonly dialed: string;
  /** The caller's number when the network passed it. Spoofable: never an identity proof. */
  readonly caller?: string;
}
