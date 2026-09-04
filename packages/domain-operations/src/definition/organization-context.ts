/**
 * Server-owned context for Organization public contracts.
 *
 * This is intentionally separate from TrustedDomainContext. Organization
 * HTTP/Core adapters resolve these values from the authenticated request and
 * must never accept them as operation input fields.
 */
export interface OrganizationRequestContext {
  readonly accountId: string;
  readonly operationId: string;
  readonly requestId: string;
  readonly organizationId?: string;
}
