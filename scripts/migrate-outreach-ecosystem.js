import '../src/config/env.js';
import adapter from '../db/DatabaseAdapter.js';
import { generateId } from '../src/utils/helpers.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = Math.min(10000, Math.max(1, Number(limitArg?.split('=')[1] || 100)));

await adapter.init();
const campaigns = await adapter.findMany('outreachCampaigns', { query: {}, sort: { createdAt: 1 }, limit });
const report = { dryRun, scanned: campaigns.length, campaignsUpdated: 0, itemsCreated: 0, historyUpdated: 0, skipped: 0, errors: [] };

for (const campaign of campaigns) {
  try {
    const separateCount = await adapter.countDocuments('outreachCampaignItems', { tenantId: campaign.tenantId, campaignId: campaign.id });
    const legacyItems = Array.isArray(campaign.items) ? campaign.items : [];
    if (!separateCount && legacyItems.length) {
      for (let index = 0; index < legacyItems.length; index += 1) {
        const item = legacyItems[index];
        const normalized = {
          id: item.id || generateId('campaign_item'), tenantId: campaign.tenantId,
          campaignId: campaign.id, sortIndex: item.sortIndex ?? index,
          contactId: item.contactId || null, turizmoLeadId: item.turizmoLeadId || null,
          turizmoCompanyId: item.turizmoCompanyId || null, phoneEntryId: item.phoneEntryId || null,
          phoneNumber: item.phoneNumber || item.to || null, templateId: item.templateId || campaign.templateId || null,
          providerMessageId: item.providerMessageId || null, outreachId: item.outreachId || null,
          chatId: item.chatId || null, status: item.status || 'pending', deliveryStatus: item.deliveryStatus || null,
          sentAt: item.sentAt || item.processedAt || null, deliveredAt: item.deliveredAt || null,
          readAt: item.readAt || null, repliedAt: item.repliedAt || null,
          firstResponseTimeMs: item.firstResponseTimeMs || null, classificationId: item.classificationId || null,
          intent: item.intent || null, sentiment: item.sentiment || null, confidence: item.confidence ?? null,
          nextAction: item.nextAction || null, optedOutAt: item.optedOutAt || null,
          failureCode: item.failureCode || null, failureReason: item.failureReason || item.error || null,
          createdAt: item.createdAt || campaign.createdAt || new Date().toISOString(),
          updatedAt: item.updatedAt || campaign.updatedAt || new Date().toISOString()
        };
        if (!dryRun) await adapter.insertOne('outreachCampaignItems', normalized);
        report.itemsCreated += 1;
        if (normalized.outreachId && !dryRun) {
          await adapter.updateOne('contactOutreachHistory', { id: normalized.outreachId }, { $set: { campaignId: campaign.id, campaignItemId: normalized.id, turizmoLeadId: normalized.turizmoLeadId, updatedAt: new Date().toISOString() } });
          report.historyUpdated += 1;
        }
      }
    }
    const patch = {
      name: campaign.name || campaign.templateName || `Campanha ${campaign.id}`,
      sentCount: Number(campaign.sentCount ?? campaign.successCount ?? 0),
      deliveredCount: Number(campaign.deliveredCount || 0), readCount: Number(campaign.readCount || 0),
      repliedCount: Number(campaign.repliedCount || 0), positiveCount: Number(campaign.positiveCount || 0),
      negativeCount: Number(campaign.negativeCount || 0), neutralCount: Number(campaign.neutralCount || 0),
      optOutCount: Number(campaign.optOutCount || 0), qualifiedCount: Number(campaign.qualifiedCount || 0),
      demoRequestedCount: Number(campaign.demoRequestedCount || 0), conversionCount: Number(campaign.conversionCount || 0),
      timezone: campaign.timezone || 'America/Sao_Paulo', updatedAt: campaign.updatedAt || new Date().toISOString()
    };
    if (!dryRun) await adapter.updateOne('outreachCampaigns', { id: campaign.id }, { $set: patch, $unset: { items: '' } });
    report.campaignsUpdated += 1;
  } catch (error) {
    report.errors.push({ campaignId: campaign.id, error: error.message });
  }
}

console.log(JSON.stringify(report, null, 2));
await adapter.close?.();
process.exit(report.errors.length ? 1 : 0);

