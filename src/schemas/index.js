import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(8),
});

export const userSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(6),
  name: z.string().min(1),
  role: z.enum(['ADMIN', 'MANAGER', 'AGENT', 'SUPER_ADMIN']),
  queues: z.array(z.string()).optional(),
  tenantId: z.string().optional(),
  permissions: z.array(z.string()).optional(),
  managerPermissions: z.array(z.string()).optional(),
  email: z.union([z.string().email(), z.literal('')]).optional(),
  phone: z.string().max(30).optional(),
  avatarUrl: z.string().max(2048).optional(),
  availabilityMode: z.enum(['auto', 'available', 'away', 'offline']).optional(),
  maxConcurrentChats: z.number().int().min(1).max(100).optional(),
  workSchedule: z.object({
    timezone: z.string().optional(),
    weekdays: z.array(z.number().int().min(0).max(6)).optional(),
    start: z.string().optional(),
    end: z.string().optional()
  }).optional(),
  notificationPreferences: z.object({
    browser: z.boolean().optional(),
    sound: z.boolean().optional(),
    email: z.boolean().optional()
  }).optional()
});

export const variableSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['text', 'number', 'boolean', 'json']),
  defaultValue: z.any().optional(),
  description: z.string().optional(),
  isRoot: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export const flowSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  nodes: z.array(z.any()).optional(),
  edges: z.array(z.any()).optional(),
});

export const templateSchema = z.object({
  name: z.string().min(1),
  text: z.string().min(1),
  scope: z.enum(['flow', 'root']).optional(),
  buttons: z.array(z.object({
    id: z.string(),
    label: z.string(),
    nextNodeId: z.string().optional()
  })).optional(),
});

const whatsappInteractiveRowSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  sku: z.string().optional(),
  unitPrice: z.preprocess(
    (value) => value === '' || value === null || value === undefined ? undefined : value,
    z.coerce.number().nonnegative().optional()
  ),
});

const whatsappInteractiveSectionSchema = z.object({
  title: z.string().optional(),
  rows: z.array(whatsappInteractiveRowSchema).min(1).max(10),
});

const whatsappInteractiveButtonSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
});

const whatsappInteractiveProductItemSchema = z.object({
  productRetailerId: z.string().min(1),
});

const whatsappInteractiveProductSectionSchema = z.object({
  title: z.string().optional(),
  productItems: z.array(whatsappInteractiveProductItemSchema).min(1).max(30),
});

export const whatsappInteractiveTemplateSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['list', 'button', 'product', 'product_list']),
  headerText: z.string().optional(),
  bodyText: z.string().min(1),
  footerText: z.string().optional(),
  actionTitle: z.string().optional(),
  sections: z.array(whatsappInteractiveSectionSchema).optional(),
  buttons: z.array(whatsappInteractiveButtonSchema).max(3).optional(),
  catalogId: z.string().optional(),
  productRetailerId: z.string().optional(),
  productSections: z.array(whatsappInteractiveProductSectionSchema).optional(),
}).superRefine((value, ctx) => {
  if (value.kind === 'list') {
    if (!String(value.actionTitle || '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actionTitle'],
        message: 'List message precisa de um titulo para o botao.'
      });
    }
    const sections = Array.isArray(value.sections) ? value.sections : [];
    const totalRows = sections.reduce((sum, section) => sum + (Array.isArray(section.rows) ? section.rows.length : 0), 0);
    if (!sections.length || totalRows === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sections'],
        message: 'List message precisa de pelo menos uma secao com itens.'
      });
    }
    if (sections.length > 1) {
      sections.forEach((section, sectionIndex) => {
        if (!String(section?.title || '').trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['sections', sectionIndex, 'title'],
            message: `A secao ${sectionIndex + 1} precisa de titulo quando houver mais de uma secao.`
          });
        }
      });
    }
    if (totalRows > 10) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sections'],
        message: 'List message aceita no maximo 10 linhas no total.'
      });
    }
  }

  if (value.kind === 'button') {
    const buttons = Array.isArray(value.buttons) ? value.buttons : [];
    if (buttons.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['buttons'],
        message: 'Reply buttons precisam de pelo menos um botao.'
      });
    }
    if (buttons.length > 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['buttons'],
        message: 'Reply buttons aceitam no maximo 3 botoes.'
      });
    }
  }

  if (value.kind === 'product') {
    if (String(value.headerText || '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['headerText'],
        message: 'Single product nao aceita header.'
      });
    }
    if (!String(value.catalogId || '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['catalogId'],
        message: 'Product message precisa do catalogId da Meta.'
      });
    }
    if (!String(value.productRetailerId || '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['productRetailerId'],
        message: 'Product message precisa do productRetailerId da Meta.'
      });
    }
  }

  if (value.kind === 'product_list') {
    const productSections = Array.isArray(value.productSections) ? value.productSections : [];
    const totalProducts = productSections.reduce((sum, section) => sum + (Array.isArray(section.productItems) ? section.productItems.length : 0), 0);
    if (!String(value.headerText || '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['headerText'],
        message: 'Multi product precisa de header.'
      });
    }
    if (!String(value.catalogId || '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['catalogId'],
        message: 'Multi product precisa do catalogId da Meta.'
      });
    }
    if (!productSections.length || totalProducts === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['productSections'],
        message: 'Multi product precisa de pelo menos uma secao com produtos.'
      });
    }
    if (productSections.length > 10) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['productSections'],
        message: 'Multi product aceita no maximo 10 secoes.'
      });
    }
    if (totalProducts > 30) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['productSections'],
        message: 'Multi product aceita no maximo 30 produtos no total.'
      });
    }
    if (productSections.length > 1) {
      productSections.forEach((section, index) => {
        if (!String(section?.title || '').trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['productSections', index, 'title'],
            message: 'O titulo da secao e obrigatorio quando houver mais de uma secao.'
          });
        }
      });
    }
  }
});

const contactPhoneSchema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  channel: z.enum(['whatsapp', 'telegram', 'phone']).optional(),
  number: z.string().min(1),
  waId: z.string().optional(),
  isPrimary: z.boolean().optional(),
});

const channelIdentitySchema = z.object({
  id: z.string().optional(),
  channel: z.enum(['whatsapp', 'telegram', 'instagram', 'email', 'phone']),
  identifier: z.string().min(1).optional(),
  normalizedIdentifier: z.string().optional(),
  displayValue: z.string().optional(),
  handle: z.string().nullable().optional(),
  channelDisplayName: z.string().nullable().optional(),
  channelDisplayNameAt: z.string().nullable().optional(),
  channelMeta: z.record(z.string(), z.any()).optional(),
  label: z.string().nullable().optional(),
  isPrimary: z.boolean().optional(),
  optedIn: z.boolean().optional()
});

export const contactSchema = z.object({
  // Nome definido pelo agente. Mantemos `name` por compatibilidade — o backend
  // espelha `agentDefinedName` em `name` quando este vier preenchido.
  name: z.string().min(1).optional(),
  agentDefinedName: z.string().optional(),
  company: z.string().optional(),
  email: z.union([z.string().email(), z.literal('')]).optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  // Aceitamos qualquer um dos dois (ou ambos). Dual-write garante consistência.
  phones: z.array(contactPhoneSchema).optional(),
  channelIdentities: z.array(channelIdentitySchema).optional()
}).refine(
  (data) => (Array.isArray(data.phones) && data.phones.length > 0)
    || (Array.isArray(data.channelIdentities) && data.channelIdentities.length > 0),
  { message: 'Pelo menos um canal de contato é obrigatório (phones ou channelIdentities).' }
);

const DayNames = z.enum(['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo']);

const scheduleRuleSchema = z.object({
  active: z.boolean(),
  start: z.string().regex(/^\d{2}:\d{2}$/, 'Formato HH:mm'),
  end: z.string().regex(/^\d{2}:\d{2}$/, 'Formato HH:mm')
});

export const scheduleSchema = z.object({
  name: z.string().min(1),
  rules: z.record(DayNames, scheduleRuleSchema)
});

export const cannedResponseSchema = z.object({
  name: z.string().min(1),
  message: z.string().min(1),
  shortcut: z.string().optional(),
});

export const tagSchema = z.object({
  name: z.string().min(1),
  color: z.string().optional(),
});

export const webhookSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  events: z.array(z.string()).optional(),
  secret: z.string().optional(),
});

export const queueSchema = z.object({
  name: z.string().min(1),
  color: z.string().optional(),
});

export const tenantSchema = z.object({
  name: z.string().min(1),
  plan: z.string().optional(),
});
