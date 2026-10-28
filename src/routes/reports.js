import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import { reportLimiter } from '../middleware/rateLimits.js';
import { assertCanExportReports, buildReportFilters, buildReports, reportColumns } from '../services/reportMetricsService.js';
import { toCsv } from '../utils/csvWriter.js';
import { createZipBuffer } from '../utils/zipWriter.js';

const REPORT_ROLES = ['ADMIN', 'MANAGER', 'SUPER_ADMIN'];

const router = express.Router();

const asColumns = (keys = []) => keys.map((key) => ({ key, label: key }));

const reportFileName = (name, filters, extension = 'csv') => {
  const tenant = filters.tenantId || 'todos';
  const from = filters.from ? filters.from.toISOString().slice(0, 10) : 'inicio';
  const to = filters.to ? filters.to.toISOString().slice(0, 10) : 'hoje';
  return `${name}_${tenant}_${from}_${to}.${extension}`;
};

const sendCsv = (res, name, rows, filters) => {
  const columns = asColumns(reportColumns[name] || Object.keys(rows?.[0] || {}));
  const csv = toCsv(columns, rows || []);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${reportFileName(name, filters)}"`);
  res.send(csv);
};

router.get('/summary', authenticate, authorize(REPORT_ROLES, { permission: 'operacao.ver' }), requireTenant, async (req, res) => {
  try {
    if (!assertCanExportReports(req, res)) return;
    const filters = buildReportFilters(req);
    const { reports } = await buildReports(filters);
    res.json({
      filters: {
        tenantId: filters.tenantId || null,
        from: filters.from ? filters.from.toISOString() : null,
        to: filters.to ? filters.to.toISOString() : null,
        channel: filters.channel || null,
        status: filters.status || null,
        queue: filters.queue || null,
        agentId: filters.agentId || null,
        flowId: filters.flowId || null
      },
      summary: reports.resumo_geral?.[0] || {}
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Falha ao gerar resumo' });
  }
});

router.get('/export.zip', reportLimiter, authenticate, authorize(REPORT_ROLES, { permission: 'operacao.ver' }), requireTenant, async (req, res) => {
  try {
    if (!assertCanExportReports(req, res)) return;
    const filters = buildReportFilters(req);
    const { reports } = await buildReports(filters);
    const files = Object.entries(reports).map(([name, rows]) => ({
      name: `${name}.csv`,
      content: toCsv(asColumns(reportColumns[name] || Object.keys(rows?.[0] || {})), rows || [])
    }));

    const zip = createZipBuffer(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${reportFileName('relatorio_onion', filters, 'zip')}"`);
    res.send(zip);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Falha ao exportar relatorio' });
  }
});

const csvRoutes = {
  'resumo-geral': 'resumo_geral',
  conversas: 'conversas',
  mensagens: 'mensagens',
  filas: 'filas',
  agentes: 'agentes',
  'fluxo-nodes': 'fluxo_nodes',
  campanhas: 'campanhas',
  'templates-whatsapp': 'templates_whatsapp',
  erros: 'erros'
};

Object.entries(csvRoutes).forEach(([routeName, reportName]) => {
  router.get(`/${routeName}.csv`, reportLimiter, authenticate, authorize(REPORT_ROLES, { permission: 'operacao.ver' }), requireTenant, async (req, res) => {
    try {
      if (!assertCanExportReports(req, res)) return;
      const filters = buildReportFilters(req);
      const { reports } = await buildReports(filters);
      sendCsv(res, reportName, reports[reportName] || [], filters);
    } catch (error) {
      res.status(500).json({ error: error.message || 'Falha ao exportar CSV' });
    }
  });
});

export default router;
