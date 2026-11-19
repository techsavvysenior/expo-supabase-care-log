/**
 * The staff roles, mirrored from the public.staff_role enum. The database
 * enforces every rule here; the app uses this only to decide which buttons
 * and tabs to show. A unit test reads the migration and fails if the two
 * lists drift apart.
 */

export const STAFF_ROLES = ['admin', 'nurse', 'caregiver', 'auditor'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export type Capabilities = {
  writeCareNotes: boolean;
  recordDoses: boolean;
  admitResidents: boolean;
  manageMedicationOrders: boolean;
  readAuditTrail: boolean;
  manageStaff: boolean;
  manageSites: boolean;
  /** Caregivers see only assigned sites; the others see all sites. */
  allSites: boolean;
};

const CAPABILITIES: Record<StaffRole, Capabilities> = {
  admin: {
    writeCareNotes: true,
    recordDoses: true,
    admitResidents: true,
    manageMedicationOrders: true,
    readAuditTrail: true,
    manageStaff: true,
    manageSites: true,
    allSites: true,
  },
  nurse: {
    writeCareNotes: true,
    recordDoses: true,
    admitResidents: true,
    manageMedicationOrders: true,
    readAuditTrail: false,
    manageStaff: false,
    manageSites: false,
    allSites: true,
  },
  caregiver: {
    writeCareNotes: true,
    recordDoses: true,
    admitResidents: false,
    manageMedicationOrders: false,
    readAuditTrail: false,
    manageStaff: false,
    manageSites: false,
    allSites: false,
  },
  auditor: {
    writeCareNotes: false,
    recordDoses: false,
    admitResidents: false,
    manageMedicationOrders: false,
    readAuditTrail: true,
    manageStaff: false,
    manageSites: false,
    allSites: true,
  },
};

export function capabilitiesOf(role: StaffRole | null | undefined): Capabilities {
  if (!role) {
    return {
      writeCareNotes: false,
      recordDoses: false,
      admitResidents: false,
      manageMedicationOrders: false,
      readAuditTrail: false,
      manageStaff: false,
      manageSites: false,
      allSites: false,
    };
  }
  return CAPABILITIES[role];
}

export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === 'string' && (STAFF_ROLES as readonly string[]).includes(value);
}
