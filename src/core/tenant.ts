/**
 * Trusted tenant context. Passed explicitly from the composition root — never inferred from model text.
 * Phase 0 has a single demo tenant loaded from a local profile; persistence comes in Phase 2.
 */
export interface TenantContext {
  readonly tenantId: string;
  readonly agentId: string;
}
