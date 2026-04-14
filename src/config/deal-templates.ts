/**
 * Default DAG templates per deal type / category.
 * When a deal is created, its graph is seeded from the matching template.
 * Nodes are ordered — sequential edges (nodes[i] → nodes[i+1]) are implied.
 * Extra edges allow non-linear dependencies (e.g. parallel paths).
 */

export type NodeType = 'milestone' | 'document' | 'action' | 'deadline' | 'external'

export interface NodeTemplate {
  label: string
  node_type: NodeType
  /** Keywords used by graph-updater to match hard facts to this node */
  keywords: string[]
}

export interface DealTemplate {
  nodes: NodeTemplate[]
  /** Additional edges beyond the sequential chain. from/to are 0-based indices. */
  extra_edges?: { from: number; to: number; edge_type: 'depends_on' | 'blocks' | 'suggests' }[]
}

// ─── Business deal templates ──────────────────────────────────────────────────

const SALE_TEMPLATE: DealTemplate = {
  nodes: [
    { label: 'Listing prepared',      node_type: 'milestone', keywords: ['listing', 'listed', 'inzerce', 'nabídka'] },
    { label: 'Property viewings',     node_type: 'action',    keywords: ['viewing', 'prohlídka', 'viewings', 'showing'] },
    { label: 'Offer received',        node_type: 'milestone', keywords: ['offer', 'nabídka', 'offer_made', 'offer_received'] },
    { label: 'Purchase contract',     node_type: 'document',  keywords: ['contract', 'smlouva', 'under_contract', 'reservation'] },
    { label: 'Financing approved',    node_type: 'external',  keywords: ['financing', 'mortgage', 'hypotéka', 'loan', 'bank'] },
    { label: 'Notary appointment',    node_type: 'action',    keywords: ['notary', 'notář', 'signing', 'podpis', 'deed'] },
    { label: 'Land registry',         node_type: 'milestone', keywords: ['registration', 'katastr', 'land_registry', 'closed'] },
  ],
}

const PURCHASE_TEMPLATE: DealTemplate = {
  nodes: [
    { label: 'Property search',       node_type: 'action',    keywords: ['search', 'hledání', 'looking'] },
    { label: 'Property viewing',      node_type: 'action',    keywords: ['viewing', 'prohlídka', 'showing'] },
    { label: 'Offer submitted',       node_type: 'milestone', keywords: ['offer', 'nabídka', 'offer_made', 'offer_submitted'] },
    { label: 'Inspection',            node_type: 'external',  keywords: ['inspection', 'inspektor', 'survey', 'defects'] },
    { label: 'Financing approved',    node_type: 'external',  keywords: ['financing', 'mortgage', 'hypotéka', 'loan', 'bank'] },
    { label: 'Purchase contract',     node_type: 'document',  keywords: ['contract', 'smlouva', 'under_contract'] },
    { label: 'Notary appointment',    node_type: 'action',    keywords: ['notary', 'notář', 'signing', 'podpis', 'deed'] },
    { label: 'Land registry',         node_type: 'milestone', keywords: ['registration', 'katastr', 'land_registry', 'closed'] },
  ],
}

const RENTAL_TEMPLATE: DealTemplate = {
  nodes: [
    { label: 'Listing prepared',      node_type: 'milestone', keywords: ['listing', 'listed', 'inzerce'] },
    { label: 'Tenant viewing',        node_type: 'action',    keywords: ['viewing', 'prohlídka', 'tenant', 'nájemce'] },
    { label: 'Rental contract',       node_type: 'document',  keywords: ['contract', 'smlouva', 'lease', 'rental_contract'] },
    { label: 'Move-in',               node_type: 'milestone', keywords: ['move_in', 'nastěhování', 'handover', 'předání', 'keys'] },
  ],
}

const LEASE_TEMPLATE: DealTemplate = {
  nodes: [
    { label: 'Lease terms agreed',    node_type: 'milestone', keywords: ['terms', 'podmínky', 'agreed'] },
    { label: 'Lease contract',        node_type: 'document',  keywords: ['contract', 'smlouva', 'lease', 'leasing'] },
    { label: 'Handover',              node_type: 'milestone', keywords: ['handover', 'předání', 'move_in', 'delivery'] },
  ],
}

const CONSULTATION_TEMPLATE: DealTemplate = {
  nodes: [
    { label: 'Initial meeting',       node_type: 'action',    keywords: ['meeting', 'schůzka', 'consultation', 'initial'] },
    { label: 'Proposal',              node_type: 'document',  keywords: ['proposal', 'nabídka', 'quote', 'estimate'] },
    { label: 'Agreement',             node_type: 'document',  keywords: ['agreement', 'contract', 'smlouva', 'signed'] },
    { label: 'Completed',             node_type: 'milestone', keywords: ['completed', 'done', 'closed', 'finished'] },
  ],
}

// ─── Category templates (personal / admin / service) ─────────────────────────

const PERSONAL_TEMPLATE: DealTemplate = {
  nodes: [
    { label: 'Event',                 node_type: 'action',    keywords: ['event', 'appointment', 'meeting', 'visit'] },
  ],
}

const ADMIN_TEMPLATE: DealTemplate = {
  nodes: [
    { label: 'Respond / complete',    node_type: 'action',    keywords: ['respond', 'reply', 'complete', 'submit', 'send'] },
  ],
}

const SERVICE_TEMPLATE: DealTemplate = {
  nodes: [
    { label: 'Request sent',          node_type: 'action',    keywords: ['request', 'booking', 'scheduled'] },
    { label: 'Service delivered',     node_type: 'milestone', keywords: ['completed', 'done', 'delivered', 'received'] },
  ],
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

export const DEAL_TYPE_TEMPLATES: Record<string, DealTemplate> = {
  sale:         SALE_TEMPLATE,
  purchase:     PURCHASE_TEMPLATE,
  rental:       RENTAL_TEMPLATE,
  lease:        LEASE_TEMPLATE,
  consultation: CONSULTATION_TEMPLATE,
  other:        CONSULTATION_TEMPLATE,
}

export const CATEGORY_TEMPLATES: Record<string, DealTemplate> = {
  personal: PERSONAL_TEMPLATE,
  admin:    ADMIN_TEMPLATE,
  service:  SERVICE_TEMPLATE,
  business: CONSULTATION_TEMPLATE,  // fallback when deal_type is null
}

/**
 * Pick the best template for a deal. Deal type takes priority over category.
 */
export function getTemplateForDeal(
  dealType: string | null,
  category: string
): DealTemplate {
  if (dealType && DEAL_TYPE_TEMPLATES[dealType]) {
    return DEAL_TYPE_TEMPLATES[dealType]
  }
  return CATEGORY_TEMPLATES[category] ?? ADMIN_TEMPLATE
}
