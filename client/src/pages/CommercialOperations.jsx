import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  CirclePause,
  CirclePlay,
  Copy,
  Loader2,
  MessageSquareText,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Square,
  Trash2,
  XCircle,
} from "lucide-react";
import toast from "react-hot-toast";
import OperationalModal from "../components/OperationalModal";
import { useAuth } from "../context/AuthContext";
import { useDialog } from "../context/DialogContext";
import { apiRequest } from "../services/api";
import { PageSkeleton } from '../components/LoadingSkeleton';
import TablePagination, { DEFAULT_PAGE_SIZE } from '../components/TablePagination';

const readJson = async (response) => {
  const body = await response?.json().catch(() => null);
  if (!response?.ok)
    throw Object.assign(
      new Error(
        body?.message || body?.error || `Falha HTTP ${response?.status || 0}`,
      ),
      { code: body?.code || null, body },
    );
  return body;
};

const fmtDate = (value) =>
  value ? new Date(value).toLocaleString("pt-BR") : "-";
const fmtRate = (value) => `${Number(value || 0).toFixed(1)}%`;
const campaignStatusLabel = (campaign) =>
  campaign?.status === "paused" && campaign?.qualityPause
    ? "Pausada pela qualidade"
    : statusLabel(campaign?.status);

const statusLabel = (status) =>
  ({
    draft: "Rascunho",
    scheduled: "Agendada",
    pending: "Pendente",
    processing: "Processando",
    paused: "Pausada",
    completed: "Concluida",
    completed_with_errors: "Concluida com falhas",
    cancelled: "Cancelada",
    failed: "Falhou",
    active: "Ativa",
    delivered: "Entregue",
    read: "Lida",
    replied: "Respondida",
    classified: "Classificada",
    qualified: "Qualificada",
  })[status] ||
  status ||
  "-";

const controlClass =
  "border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-500 dark:border-slate-700 dark:bg-slate-950";
const buttonClass =
  "inline-flex items-center justify-center gap-2 border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-blue-400 hover:text-blue-600 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300";
const primaryClass =
  "inline-flex items-center justify-center gap-2 bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-blue-700 disabled:opacity-40";

const SectionHeader = ({ title, action }) => (
  <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
    <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
      {title}
    </h2>
    {action}
  </header>
);

const MetricStrip = ({ metrics }) => {
  const values = [
    ["Contatos", metrics?.totalContacts],
    ["Enviadas", metrics?.sentCount],
    ["Entregues", metrics?.deliveredCount],
    ["Lidas", metrics?.readCount],
    ["Respostas", metrics?.repliedCount],
    ["Positivas", metrics?.positiveCount],
    ["Opt-out", metrics?.optOutCount],
    ["Falhas", metrics?.failedCount],
  ];
  return (
    <div className="grid border-b border-slate-200 sm:grid-cols-4 lg:grid-cols-8 dark:border-slate-800">
      {values.map(([label, value], index) => (
        <div
          key={label}
          className={`${index ? "border-l border-slate-200 dark:border-slate-800" : ""} px-4 py-3`}
        >
          <div className="text-[10px] uppercase tracking-wider text-slate-400">
            {label}
          </div>
          <div className="mt-1 text-lg font-semibold tabular-nums text-slate-950 dark:text-white">
            {Number(value || 0)}
          </div>
        </div>
      ))}
    </div>
  );
};

const Campaigns = ({ canWrite }) => {
  const { confirm } = useDialog();
  const [data, setData] = useState({ items: [] });
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);
  const [detailData, setDetailData] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [options, setOptions] = useState({
    contacts: [],
    templates: [],
    senders: [],
    cadences: [],
  });
  const [form, setForm] = useState({
    name: "",
    contactIds: [],
    templateId: "",
    senderPhoneNumberId: "",
    cadenceId: "",
    values: "{}",
  });
  const [saving, setSaving] = useState(false);
  const [filters, setFilters] = useState({ search: "", status: "" });
  const [page, setPage] = useState(1);

  // Filtro novo volta para a pagina 1; "Atualizar" fica na pagina atual.
  const load = async (nextPage = page) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(DEFAULT_PAGE_SIZE), page: String(nextPage) });
      setPage(nextPage);
      if (filters.search.trim()) params.set("search", filters.search.trim());
      if (filters.status) params.set("status", filters.status);
      setData(await readJson(await apiRequest(`/outreach/campaigns?${params}`)));
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const loadEditorOptions = async () => {
    try {
      const [contacts, setup, cadences] = await Promise.all([
        readJson(await apiRequest("/contacts?limit=500")),
        readJson(await apiRequest("/templates/whatsapp")),
        readJson(await apiRequest("/cadences?limit=100")),
      ]);
      const senders = setup?.channelConfig?.senderNumbers?.length
        ? setup.channelConfig.senderNumbers
        : setup?.channelConfig?.phoneNumberId
          ? [
              {
                phoneNumberId: setup.channelConfig.phoneNumberId,
                label: "Principal",
              },
            ]
          : [];
      setOptions({
        contacts: Array.isArray(contacts) ? contacts : [],
        templates: (setup?.items || []).filter((item) =>
          ["APPROVED", "ACTIVE"].includes(
            String(item.status || "").toUpperCase(),
          ),
        ),
        senders,
        cadences: cadences?.items || [],
      });
      setEditorOpen(true);
    } catch (error) {
      toast.error(error.message);
    }
  };

  const openDetail = async (campaign) => {
    setDetail(campaign);
    setDetailData(null);
    try {
      const [full, metrics, items] = await Promise.all([
        readJson(await apiRequest(`/outreach/campaigns/${campaign.id}`)),
        readJson(
          await apiRequest(`/outreach/campaigns/${campaign.id}/metrics`),
        ),
        readJson(
          await apiRequest(
            `/outreach/campaigns/${campaign.id}/items?limit=100`,
          ),
        ),
      ]);
      setDetailData({ full, metrics, items: items.items || [] });
    } catch (error) {
      toast.error(error.message);
    }
  };

  const createCampaign = async () => {
    setSaving(true);
    try {
      const payload = {
        name: form.name,
        channel: "whatsapp",
        contactIds: form.contactIds,
        templateId: form.templateId,
        senderPhoneNumberId: form.senderPhoneNumberId || null,
        cadenceId: form.cadenceId || null,
        values: JSON.parse(form.values || "{}"),
      };
      await readJson(
        await apiRequest("/outreach/campaigns", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      );
      toast.success("Campanha criada");
      setEditorOpen(false);
      setForm({
        name: "",
        contactIds: [],
        templateId: "",
        senderPhoneNumberId: "",
        cadenceId: "",
        values: "{}",
      });
      await load();
    } catch (error) {
      toast.error(
        error instanceof SyntaxError
          ? "Valores devem ser um JSON valido"
          : error.message,
      );
    } finally {
      setSaving(false);
    }
  };

  const action = async (name, body = null) => {
    try {
      await readJson(
        await apiRequest(`/outreach/campaigns/${detail.id}/${name}`, {
          method: "POST",
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
      toast.success("Campanha atualizada");
      setDetail(null);
      await load();
    } catch (error) {
      // Pausada pela qualidade: retomar exige confirmar que viu o motivo.
      if (error.code === "quality_ack_required" && !body) {
        const motivos = (error.body?.reasons || [])
          .map((reason) => reason.title)
          .join("; ");
        const ok = await confirm({
          title: "Retomar campanha pausada pela qualidade?",
          message: `A Meta ainda aponta: ${motivos}. Continuar enviando pode derrubar a qualidade do número de vez. Retome só depois de revisar a mensagem e a lista. A campanha pausa de novo se surgir outro sinal.`,
          confirmText: "Retomar mesmo assim",
          type: "danger",
        });
        if (ok) await action(name, { acknowledgeQuality: true });
        return;
      }
      toast.error(error.message);
    }
  };

  return (
    <div className="border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <SectionHeader
        title="Campanhas"
        action={
          <div className="flex gap-2">
            <button onClick={() => load()} className={buttonClass}>
              <RefreshCw size={14} /> Atualizar
            </button>
            {canWrite ? (
              <button onClick={loadEditorOptions} className={primaryClass}>
                <Plus size={14} /> Nova campanha
              </button>
            ) : null}
          </div>
        }
      />
      <div className="grid gap-2 border-b border-slate-200 p-3 sm:grid-cols-[minmax(0,1fr)_180px_auto] dark:border-slate-800">
        <input
          className={controlClass}
          placeholder="Buscar por nome ou ID"
          value={filters.search}
          onChange={(event) =>
            setFilters({ ...filters, search: event.target.value })
          }
          onKeyDown={(event) => event.key === "Enter" && load(1)}
        />
        <select
          className={controlClass}
          value={filters.status}
          onChange={(event) =>
            setFilters({ ...filters, status: event.target.value })
          }
        >
          <option value="">Todos os estados</option>
          <option value="scheduled">Agendada</option>
          <option value="pending">Pendente</option>
          <option value="processing">Processando</option>
          <option value="paused">Pausada</option>
          <option value="completed">Concluida</option>
          <option value="completed_with_errors">Com falhas</option>
          <option value="cancelled">Cancelada</option>
        </select>
        <button onClick={() => load(1)} className={buttonClass}>
          Aplicar
        </button>
      </div>
      {loading ? (
        <PageSkeleton cards={6} />
      ) : data.items?.length ? (
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {data.items.map((campaign) => (
            <button
              key={campaign.id}
              onClick={() => openDetail(campaign)}
              className="grid w-full grid-cols-[1fr_auto] items-center gap-4 px-4 py-4 text-left transition hover:bg-slate-50 dark:hover:bg-slate-950/50 sm:grid-cols-[minmax(0,2fr)_1fr_1fr_1fr_auto]"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-950 dark:text-white">
                  {campaign.name || campaign.templateName}
                </div>
                {campaign.templateName && campaign.name ? (
                  <div className="mt-1 truncate text-[11px] text-slate-400">
                    {campaign.templateName}
                  </div>
                ) : null}
              </div>
              <div
                className={`hidden text-xs sm:block ${campaign.status === "paused" && campaign.qualityPause ? "font-semibold text-amber-600 dark:text-amber-400" : "text-slate-500"}`}
              >
                {campaignStatusLabel(campaign)}
              </div>
              <div className="hidden text-xs tabular-nums text-slate-500 sm:block">
                {campaign.sentCount ?? campaign.successCount ?? 0} /{" "}
                {campaign.totalContacts || 0}
              </div>
              <div className="hidden text-xs text-slate-500 sm:block">
                {fmtDate(campaign.createdAt)}
              </div>
              <ChevronRight size={16} className="text-slate-400" />
            </button>
          ))}
          <TablePagination
            page={page}
            totalPages={Math.max(1, Number(data.pagination?.pages) || 1)}
            setPage={(next) => load(next)}
            total={Number(data.pagination?.total) || 0}
            from={(page - 1) * DEFAULT_PAGE_SIZE + 1}
            to={Math.min(page * DEFAULT_PAGE_SIZE, Number(data.pagination?.total) || 0)}
            label="campanhas"
          />
        </div>
      ) : (
        <div className="px-5 py-16 text-center text-sm text-slate-400">
          Nenhuma campanha registrada.
        </div>
      )}

      <OperationalModal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title="Nova campanha"
        context="Operacao comercial"
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setEditorOpen(false)}
              className={buttonClass}
            >
              Cancelar
            </button>
            <button
              onClick={createCampaign}
              disabled={
                saving ||
                !form.name ||
                !form.templateId ||
                !form.contactIds.length
              }
              className={primaryClass}
            >
              {saving ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Send size={14} />
              )}{" "}
              Criar campanha
            </button>
          </div>
        }
      >
        <div className="grid gap-5 p-5 md:grid-cols-2">
          <label>
            <span className="mb-1.5 block text-xs font-semibold">Nome</span>
            <input
              className={`${controlClass} w-full`}
              value={form.name}
              onChange={(event) =>
                setForm({ ...form, name: event.target.value })
              }
            />
          </label>
          <label>
            <span className="mb-1.5 block text-xs font-semibold">
              Template aprovado
            </span>
            <select
              className={`${controlClass} w-full`}
              value={form.templateId}
              onChange={(event) =>
                setForm({ ...form, templateId: event.target.value })
              }
            >
              <option value="">Selecione</option>
              {options.templates.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-1.5 block text-xs font-semibold">
              Numero remetente
            </span>
            <select
              className={`${controlClass} w-full`}
              value={form.senderPhoneNumberId}
              onChange={(event) =>
                setForm({ ...form, senderPhoneNumberId: event.target.value })
              }
            >
              <option value="">Padrao do canal</option>
              {options.senders.map((item) => (
                <option key={item.phoneNumberId} value={item.phoneNumberId}>
                  {item.label || item.displayNumber || item.phoneNumberId}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-1.5 block text-xs font-semibold">
              Cadencia opcional
            </span>
            <select
              className={`${controlClass} w-full`}
              value={form.cadenceId}
              onChange={(event) =>
                setForm({ ...form, cadenceId: event.target.value })
              }
            >
              <option value="">Envio unico</option>
              {options.cadences
                .filter((item) => item.status === "active")
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="md:col-span-2">
            <span className="mb-1.5 block text-xs font-semibold">
              Destinatarios
            </span>
            <select
              multiple
              size={8}
              className={`${controlClass} w-full`}
              value={form.contactIds}
              onChange={(event) =>
                setForm({
                  ...form,
                  contactIds: Array.from(event.target.selectedOptions).map(
                    (option) => option.value,
                  ),
                })
              }
            >
              {options.contacts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayName ||
                    item.name ||
                    item.primaryPhone ||
                    item.id}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[10px] text-slate-400">
              Use Ctrl para selecionar varios contatos.
            </span>
          </label>
          <label className="md:col-span-2">
            <span className="mb-1.5 block text-xs font-semibold">
              Valores do template em JSON
            </span>
            <textarea
              rows={6}
              className={`${controlClass} w-full font-mono text-xs`}
              value={form.values}
              onChange={(event) =>
                setForm({ ...form, values: event.target.value })
              }
            />
          </label>
        </div>
      </OperationalModal>

      <OperationalModal
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail?.name || "Campanha"}
        context="Campanha"
        size="xl"
        footer={
          detail && canWrite && (
            <div className="flex flex-wrap justify-end gap-2">
              <button onClick={() => action("pause")} className={buttonClass}>
                <CirclePause size={14} /> Pausar
              </button>
              <button onClick={() => action("resume")} className={buttonClass}>
                <CirclePlay size={14} /> Retomar
              </button>
              <button
                onClick={() => action("reprocess-failures")}
                className={buttonClass}
              >
                <RotateCcw size={14} /> Reprocessar falhas
              </button>
              <button onClick={() => action("cancel")} className={buttonClass}>
                <XCircle size={14} /> Cancelar
              </button>
            </div>
          )
        }
      >
        {!detailData ? (
          <div className="grid min-h-72 place-items-center">
            <Loader2 className="animate-spin text-blue-600" />
          </div>
        ) : (
          <div>
            {detail?.status === "paused" && detail?.qualityPause ? (
              <div className="flex gap-3 border-b border-amber-200 bg-amber-50 p-4 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
                <AlertTriangle size={18} className="mt-0.5 shrink-0" />
                <div className="min-w-0 text-xs leading-relaxed">
                  <div className="text-sm font-semibold">
                    Pausada automaticamente pela qualidade
                  </div>
                  <ul className="mt-1.5 space-y-1">
                    {(detail.qualityPause.reasons || []).map((reason) => (
                      <li key={reason.key}>
                        <span className="font-semibold">{reason.title}.</span>{" "}
                        {reason.message}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 text-amber-800/80 dark:text-amber-300/80">
                    Pausada em {fmtDate(detail.qualityPause.pausedAt)}. Revise a
                    mensagem e a lista antes de retomar.
                  </div>
                </div>
              </div>
            ) : null}
            <MetricStrip metrics={detailData.metrics} />
            <div className="grid border-b border-slate-200 md:grid-cols-3 dark:border-slate-800">
              <div className="p-4">
                <div className="text-[10px] uppercase text-slate-400">
                  Resposta
                </div>
                <div className="mt-1 text-sm font-semibold">
                  {fmtRate(detailData.metrics.replyRate)}
                </div>
              </div>
              <div className="border-l border-slate-200 p-4 dark:border-slate-800">
                <div className="text-[10px] uppercase text-slate-400">
                  Leitura
                </div>
                <div className="mt-1 text-sm font-semibold">
                  {fmtRate(detailData.metrics.readRate)}
                </div>
              </div>
              <div className="border-l border-slate-200 p-4 dark:border-slate-800">
                <div className="text-[10px] uppercase text-slate-400">
                  Qualificacao
                </div>
                <div className="mt-1 text-sm font-semibold">
                  {fmtRate(detailData.metrics.qualificationRate)}
                </div>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500 dark:border-slate-800 dark:bg-slate-950">
                  <tr>
                    <th className="px-4 py-3">Contato</th>
                    <th className="px-4 py-3">Estado</th>
                    <th className="px-4 py-3">Entrega</th>
                    <th className="px-4 py-3">Intencao</th>
                    <th className="px-4 py-3">Processado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {detailData.items.map((item) => (
                    <tr key={item.id}>
                      <td className="px-4 py-3">
                        {item.contactName || item.phoneNumber || item.contactId}
                      </td>
                      <td className="px-4 py-3">{statusLabel(item.status)}</td>
                      <td className="px-4 py-3">
                        {statusLabel(item.deliveryStatus)}
                      </td>
                      <td className="px-4 py-3">{item.intent || "-"}</td>
                      <td className="px-4 py-3">{fmtDate(item.processedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </OperationalModal>
    </div>
  );
};

const emptyStep = () => ({
  delayMinutes: 0,
  action: "send_template",
  templateId: "",
  senderPhoneNumberId: "",
  values: {},
  conditions: null,
  skipIfReplied: true,
  skipIfRead: false,
  nextStepOnPositive: null,
  nextStepOnNegative: null,
  nextStepOnNoResponse: null,
});

const Cadences = ({ canWrite }) => {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState(null);
  const [templates, setTemplates] = useState([]);
  const load = async () => {
    setLoading(true);
    try {
      setItems(
        (await readJson(await apiRequest("/cadences?limit=100"))).items || [],
      );
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);
  const openEditor = async (item = null) => {
    try {
      const setup = await readJson(await apiRequest("/templates/whatsapp"));
      setTemplates(setup?.items || []);
      setEditor(
        item
          ? structuredClone(item)
          : {
              name: "",
              description: "",
              status: "draft",
              timezone: "America/Sao_Paulo",
              allowedWeekdays: [1, 2, 3, 4, 5],
              allowedStartTime: "08:00",
              allowedEndTime: "18:00",
              stopOnReply: true,
              stopOnPositive: true,
              stopOnNegative: true,
              stopOnOptOut: true,
              steps: [emptyStep()],
            },
      );
    } catch (error) {
      toast.error(error.message);
    }
  };
  const save = async () => {
    try {
      const method = editor.id ? "PATCH" : "POST";
      const endpoint = editor.id ? `/cadences/${editor.id}` : "/cadences";
      const payload = { ...editor };
      delete payload.id;
      delete payload.tenantId;
      delete payload.createdAt;
      delete payload.updatedAt;
      delete payload.createdBy;
      delete payload.updatedBy;
      payload.steps = (payload.steps || []).map(({ order: _order, ...step }) => step);
      await readJson(
        await apiRequest(endpoint, { method, body: JSON.stringify(payload) }),
      );
      toast.success("Cadencia salva");
      setEditor(null);
      await load();
    } catch (error) {
      toast.error(error.message);
    }
  };
  const statusAction = async (item, action) => {
    try {
      await readJson(
        await apiRequest(`/cadences/${item.id}/${action}`, { method: "POST" }),
      );
      await load();
    } catch (error) {
      toast.error(error.message);
    }
  };
  const duplicate = async (item) => {
    try {
      await readJson(
        await apiRequest(`/cadences/${item.id}/duplicate`, {
          method: "POST",
          body: JSON.stringify({ name: `${item.name} - copia` }),
        }),
      );
      toast.success("Cadencia duplicada");
      await load();
    } catch (error) {
      toast.error(error.message);
    }
  };
  const updateStep = (index, patch) =>
    setEditor({
      ...editor,
      steps: editor.steps.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    });
  return (
    <div className="border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <SectionHeader
        title="Cadencias"
        action={canWrite ? (
          <button onClick={() => openEditor()} className={primaryClass}>
            <Plus size={14} /> Nova cadencia
          </button>
        ) : null}
      />
      {loading ? (
        <div className="grid min-h-64 place-items-center">
          <Loader2 className="animate-spin text-blue-600" />
        </div>
      ) : (
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {items.map((item) => (
            <div
              key={item.id}
              className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-4 sm:grid-cols-[minmax(0,2fr)_1fr_1fr_auto]"
            >
              <button
                onClick={() => openEditor(item)}
                className="min-w-0 text-left"
              >
                <div className="truncate text-sm font-semibold">
                  {item.name}
                </div>
                <div className="mt-1 font-mono text-[10px] text-slate-400">
                  {item.id}
                </div>
              </button>
              <div className="hidden text-xs text-slate-500 sm:block">
                {statusLabel(item.status)}
              </div>
              <div className="hidden text-xs text-slate-500 sm:block">
                {item.steps?.length || 0} etapas
              </div>
              <div className="flex gap-2">
                {canWrite ? (
                  <>
                    <button
                      onClick={() =>
                        statusAction(
                          item,
                          item.status === "active" ? "pause" : "activate",
                        )
                      }
                      className={buttonClass}
                    >
                      {item.status === "active" ? <CirclePause size={14} /> : <CirclePlay size={14} />}
                    </button>
                    <button onClick={() => duplicate(item)} className={buttonClass} title="Duplicar">
                      <Copy size={14} />
                    </button>
                  </>
                ) : null}
                <button
                  onClick={() => openEditor(item)}
                  className={buttonClass}
                >
                  Detalhes
                </button>
              </div>
            </div>
          ))}
          {!items.length && (
            <div className="px-5 py-16 text-center text-sm text-slate-400">
              Nenhuma cadencia configurada.
            </div>
          )}
        </div>
      )}
      <OperationalModal
        open={Boolean(editor)}
        onClose={() => setEditor(null)}
        title={editor?.id ? "Editar cadencia" : "Nova cadencia"}
        context="Automacao comercial"
        size="xl"
        footer={
          <div className="flex justify-end gap-2">
            <button onClick={() => setEditor(null)} className={buttonClass}>
              Cancelar
            </button>
            {canWrite ? (
              <button onClick={save} disabled={!editor?.name || !editor?.steps?.length} className={primaryClass}>
                <Check size={14} /> Salvar
              </button>
            ) : null}
          </div>
        }
      >
        {editor && (
          <fieldset disabled={!canWrite} className="disabled:opacity-80">
            <div className="grid gap-4 border-b border-slate-200 p-5 md:grid-cols-2 dark:border-slate-800">
              <label>
                <span className="mb-1 block text-xs font-semibold">Nome</span>
                <input
                  className={`${controlClass} w-full`}
                  value={editor.name}
                  onChange={(event) =>
                    setEditor({ ...editor, name: event.target.value })
                  }
                />
              </label>
              <label>
                <span className="mb-1 block text-xs font-semibold">
                  Fuso horario
                </span>
                <input
                  className={`${controlClass} w-full`}
                  value={editor.timezone}
                  onChange={(event) =>
                    setEditor({ ...editor, timezone: event.target.value })
                  }
                />
              </label>
              <label>
                <span className="mb-1 block text-xs font-semibold">
                  Inicio da janela
                </span>
                <input
                  type="time"
                  className={`${controlClass} w-full`}
                  value={editor.allowedStartTime}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      allowedStartTime: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                <span className="mb-1 block text-xs font-semibold">
                  Fim da janela
                </span>
                <input
                  type="time"
                  className={`${controlClass} w-full`}
                  value={editor.allowedEndTime}
                  onChange={(event) =>
                    setEditor({ ...editor, allowedEndTime: event.target.value })
                  }
                />
              </label>
              <div className="md:col-span-2">
                <span className="mb-2 block text-xs font-semibold">Dias permitidos</span>
                <div className="flex flex-wrap gap-2">
                  {["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"].map((label, day) => (
                    <label key={label} className="flex items-center gap-1.5 border border-slate-200 px-2 py-1.5 text-xs dark:border-slate-700">
                      <input
                        type="checkbox"
                        checked={(editor.allowedWeekdays || []).includes(day)}
                        onChange={(event) => setEditor({
                          ...editor,
                          allowedWeekdays: event.target.checked
                            ? [...new Set([...(editor.allowedWeekdays || []), day])].sort()
                            : (editor.allowedWeekdays || []).filter((value) => value !== day),
                        })}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
              <div className="md:col-span-2 grid gap-2 sm:grid-cols-4">
                {[
                  ["stopOnReply", "Parar ao responder"],
                  ["stopOnPositive", "Parar se positivo"],
                  ["stopOnNegative", "Parar se negativo"],
                  ["stopOnOptOut", "Parar no opt-out"],
                ].map(([field, label]) => (
                  <label key={field} className="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={editor[field] !== false} onChange={(event) => setEditor({ ...editor, [field]: event.target.checked })} />
                    {label}
                  </label>
                ))}
              </div>
            </div>
            <SectionHeader
              title="Etapas"
              action={
                <button
                  onClick={() =>
                    setEditor({
                      ...editor,
                      steps: [...editor.steps, emptyStep()],
                    })
                  }
                  className={buttonClass}
                >
                  <Plus size={14} /> Etapa
                </button>
              }
            />
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {editor.steps.map((step, index) => (
                <div
                  key={index}
                  className="grid gap-3 p-4 md:grid-cols-[60px_1fr_150px_40px]"
                >
                  <div className="grid h-9 place-items-center border border-slate-200 text-xs font-semibold dark:border-slate-700">
                    {index + 1}
                  </div>
                  <select
                    className={controlClass}
                    value={
                      step.action === "close_cadence"
                        ? "__close"
                        : step.templateId || ""
                    }
                    onChange={(event) =>
                      setEditor({
                        ...editor,
                        steps: editor.steps.map((item, i) =>
                          i !== index
                            ? item
                            : event.target.value === "__close"
                              ? {
                                  ...item,
                                  templateId: null,
                                  action: "close_cadence",
                                }
                              : {
                                  ...item,
                                  templateId: event.target.value,
                                  action: "send_template",
                                },
                        ),
                      })
                    }
                  >
                    <option value="">Selecione o template</option>
                    {templates
                      .filter((item) =>
                        ["APPROVED", "ACTIVE"].includes(
                          String(item.status || "").toUpperCase(),
                        ),
                      )
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    <option value="__close">Encerrar cadencia</option>
                  </select>
                  <label className="flex items-center gap-2">
                    <input
                      type="number"
                      min="0"
                      className={`${controlClass} w-24`}
                      value={step.delayMinutes}
                      onChange={(event) =>
                        setEditor({
                          ...editor,
                          steps: editor.steps.map((item, i) =>
                            i === index
                              ? {
                                  ...item,
                                  delayMinutes: Number(event.target.value),
                                }
                              : item,
                          ),
                        })
                      }
                    />
                    <span className="text-xs text-slate-400">min</span>
                  </label>
                  <button
                    onClick={() =>
                      setEditor({
                        ...editor,
                        steps: editor.steps.filter((_, i) => i !== index),
                      })
                    }
                    className={buttonClass}
                  >
                    <Trash2 size={14} />
                  </button>
                  <div className="md:col-start-2 md:col-span-3 grid gap-3 border-l-2 border-slate-200 pl-3 sm:grid-cols-2 lg:grid-cols-5 dark:border-slate-700">
                    <label className="flex items-center gap-2 text-xs">
                      <input type="checkbox" checked={step.skipIfReplied !== false} onChange={(event) => updateStep(index, { skipIfReplied: event.target.checked })} />
                      Ignorar se respondeu
                    </label>
                    <label className="flex items-center gap-2 text-xs">
                      <input type="checkbox" checked={step.skipIfRead === true} onChange={(event) => updateStep(index, { skipIfRead: event.target.checked })} />
                      Ignorar se leu
                    </label>
                    {[
                      ["nextStepOnPositive", "Positivo"],
                      ["nextStepOnNegative", "Negativo"],
                      ["nextStepOnNoResponse", "Sem resposta"],
                    ].map(([field, label]) => (
                      <label key={field}>
                        <span className="mb-1 block text-[10px] uppercase text-slate-400">{label}</span>
                        <input
                          type="number"
                          min="1"
                          max={editor.steps.length}
                          placeholder="Proxima"
                          className={`${controlClass} w-full`}
                          value={step[field] ?? ""}
                          onChange={(event) => updateStep(index, { [field]: event.target.value ? Number(event.target.value) : null })}
                        />
                      </label>
                    ))}
                  </div>
                  <div className="md:col-start-2 md:col-span-3 text-[10px] text-slate-400">
                    {step.action === "close_cadence"
                      ? "Preview: encerra a cadencia sem novo envio."
                      : `Preview: apos ${step.delayMinutes || 0} min envia ${templates.find((template) => template.id === step.templateId)?.name || "um template ainda nao selecionado"}.`}
                  </div>
                  {step.action !== "close_cadence" ? (
                    <div className="md:col-start-2 md:col-span-3 grid gap-3 md:grid-cols-3">
                      <label>
                        <span className="mb-1 block text-[10px] uppercase text-slate-400">Remetente opcional</span>
                        <input className={`${controlClass} w-full`} value={step.senderPhoneNumberId || ""} onChange={(event) => updateStep(index, { senderPhoneNumberId: event.target.value || null })} />
                      </label>
                      <label>
                        <span className="mb-1 block text-[10px] uppercase text-slate-400">Valores JSON</span>
                        <textarea
                          rows={3}
                          className={`${controlClass} w-full font-mono text-xs`}
                          defaultValue={JSON.stringify(step.values || {}, null, 2)}
                          onBlur={(event) => {
                            try { updateStep(index, { values: JSON.parse(event.target.value || "{}") }); }
                            catch { toast.error(`JSON de valores invalido na etapa ${index + 1}`); }
                          }}
                        />
                      </label>
                      <label>
                        <span className="mb-1 block text-[10px] uppercase text-slate-400">Condicoes JSON</span>
                        <textarea
                          rows={3}
                          className={`${controlClass} w-full font-mono text-xs`}
                          defaultValue={JSON.stringify(step.conditions || {}, null, 2)}
                          onBlur={(event) => {
                            try { updateStep(index, { conditions: JSON.parse(event.target.value || "{}") }); }
                            catch { toast.error(`JSON de condicoes invalido na etapa ${index + 1}`); }
                          }}
                        />
                      </label>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </fieldset>
        )}
      </OperationalModal>
    </div>
  );
};

const Classifications = () => {
  const [data, setData] = useState({ items: [] });
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [review, setReview] = useState({
    intent: "",
    sentiment: "",
    nextAction: "",
    reason: "",
  });
  const load = async () => {
    setLoading(true);
    try {
      setData(await readJson(await apiRequest("/classifications?limit=100")));
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);
  const open = (item) => {
    setSelected(item);
    setReview({
      intent: item.intent,
      sentiment: item.sentiment,
      nextAction: item.nextAction,
      reason: item.reason || "",
    });
  };
  const save = async () => {
    try {
      await readJson(
        await apiRequest(`/classifications/${selected.id}/review`, {
          method: "POST",
          body: JSON.stringify(review),
        }),
      );
      toast.success("Revisao registrada");
      setSelected(null);
      await load();
    } catch (error) {
      toast.error(error.message);
    }
  };
  const reprocess = async () => {
    try {
      await readJson(
        await apiRequest(`/classifications/${selected.id}/reprocess`, {
          method: "POST",
        }),
      );
      toast.success("Reprocessamento agendado");
      setSelected(null);
    } catch (error) {
      toast.error(error.message);
    }
  };
  return (
    <div className="border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <SectionHeader
        title="Classificacoes"
        action={
          <button onClick={load} className={buttonClass}>
            <RefreshCw size={14} /> Atualizar
          </button>
        }
      />
      {loading ? (
        <div className="grid min-h-64 place-items-center">
          <Loader2 className="animate-spin text-blue-600" />
        </div>
      ) : (
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {data.items.map((item) => (
            <button
              key={item.id}
              onClick={() => open(item)}
              className="grid w-full grid-cols-[1fr_auto] items-center gap-4 px-4 py-4 text-left hover:bg-slate-50 dark:hover:bg-slate-950/50 sm:grid-cols-[minmax(0,2fr)_1fr_1fr_1fr_auto]"
            >
              <div className="min-w-0">
                <div className="truncate text-sm">
                  {item.inputText || "Mensagem sem texto"}
                </div>
                <div className="mt-1 font-mono text-[10px] text-slate-400">
                  {item.id}
                </div>
              </div>
              <div className="hidden text-xs sm:block">{item.intent}</div>
              <div className="hidden text-xs sm:block">
                {Math.round(Number(item.confidence || 0) * 100)}%
              </div>
              <div className="hidden text-xs sm:block">{item.reviewStatus}</div>
              <ChevronRight size={16} className="text-slate-400" />
            </button>
          ))}
          {!data.items.length && (
            <div className="px-5 py-16 text-center text-sm text-slate-400">
              Nenhuma classificacao registrada.
            </div>
          )}
        </div>
      )}
      <OperationalModal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title="Revisar classificacao"
        context="Inteligencia comercial"
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <button onClick={reprocess} className={buttonClass}>
              <RotateCcw size={14} /> Reprocessar
            </button>
            <button onClick={save} className={primaryClass}>
              <Check size={14} /> Confirmar revisao
            </button>
          </div>
        }
      >
        {selected && (
          <div className="grid gap-4 p-5 md:grid-cols-2">
            <div className="md:col-span-2 border-l-2 border-blue-600 bg-slate-50 px-4 py-3 text-sm dark:bg-slate-950">
              {selected.inputText}
            </div>
            <label>
              <span className="mb-1 block text-xs font-semibold">Intencao</span>
              <select
                className={`${controlClass} w-full`}
                value={review.intent}
                onChange={(event) =>
                  setReview({ ...review, intent: event.target.value })
                }
              >
                {[
                  "positivo",
                  "interessado_depois",
                  "pediu_preco",
                  "pediu_demo",
                  "pediu_proposta",
                  "duvida",
                  "negativo",
                  "opt_out",
                  "revisao_humana",
                ].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="mb-1 block text-xs font-semibold">
                Sentimento
              </span>
              <select
                className={`${controlClass} w-full`}
                value={review.sentiment}
                onChange={(event) =>
                  setReview({ ...review, sentiment: event.target.value })
                }
              >
                {["positive", "neutral", "negative", "unknown"].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="mb-1 block text-xs font-semibold">
                Proxima acao
              </span>
              <select
                className={`${controlClass} w-full`}
                value={review.nextAction}
                onChange={(event) =>
                  setReview({ ...review, nextAction: event.target.value })
                }
              >
                {[
                  "notify_sales",
                  "create_task",
                  "schedule_follow_up",
                  "send_automatic_reply",
                  "request_human_review",
                  "stop_cadence",
                  "suppress_contact",
                  "do_nothing",
                ].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="mb-1 block text-xs font-semibold">
                Confianca
              </span>
              <div className={`${controlClass} tabular-nums`}>
                {Math.round(Number(selected.confidence || 0) * 100)}%
              </div>
            </label>
            <label className="md:col-span-2">
              <span className="mb-1 block text-xs font-semibold">
                Justificativa
              </span>
              <textarea
                rows={5}
                className={`${controlClass} w-full`}
                value={review.reason}
                onChange={(event) =>
                  setReview({ ...review, reason: event.target.value })
                }
              />
            </label>
          </div>
        )}
      </OperationalModal>
    </div>
  );
};

const Integration = () => {
  const [status, setStatus] = useState(null);
  const [outbox, setOutbox] = useState({ items: [] });
  const load = async () => {
    try {
      const [nextStatus, nextOutbox] = await Promise.all([
        readJson(await apiRequest("/integrations/turizmo/status")),
        readJson(await apiRequest("/integrations/turizmo/outbox?limit=100")),
      ]);
      setStatus(nextStatus);
      setOutbox(nextOutbox);
    } catch (error) {
      toast.error(error.message);
    }
  };
  useEffect(() => {
    load();
  }, []);
  const retry = async (id) => {
    try {
      await readJson(
        await apiRequest(`/integrations/turizmo/outbox/${id}/retry`, {
          method: "POST",
        }),
      );
      toast.success("Evento reenfileirado");
      await load();
    } catch (error) {
      toast.error(error.message);
    }
  };
  return (
    <div className="border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <SectionHeader
        title="Integracao Turizmo"
        action={
          <button onClick={load} className={buttonClass}>
            <RefreshCw size={14} /> Atualizar
          </button>
        }
      />
      <div className="grid border-b border-slate-200 md:grid-cols-4 dark:border-slate-800">
        {[
          [
            "Estado",
            status?.enabled && status?.configured
              ? "Operacional"
              : "Desativada",
          ],
          ["Pendentes", status?.counts?.pending],
          ["Retentativas", status?.counts?.retry],
          ["Dead letter", status?.counts?.dead_letter],
        ].map(([label, value], index) => (
          <div
            key={label}
            className={`${index ? "border-l border-slate-200 dark:border-slate-800" : ""} p-4`}
          >
            <div className="text-[10px] uppercase text-slate-400">{label}</div>
            <div className="mt-1 text-sm font-semibold">{value ?? "-"}</div>
          </div>
        ))}
      </div>
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {outbox.items.map((item) => (
          <div
            key={item.id}
            className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-3 sm:grid-cols-[minmax(0,2fr)_1fr_1fr_auto]"
          >
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold">
                {item.eventType}
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-slate-400">
                {item.eventId}
              </div>
            </div>
            <div className="hidden text-xs sm:block">{item.status}</div>
            <div className="hidden text-xs sm:block">
              {item.attemptCount || 0} tentativas
            </div>
            {["retry", "dead_letter"].includes(item.status) ? (
              <button onClick={() => retry(item.id)} className={buttonClass}>
                Tentar novamente
              </button>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

const PromptManagement = () => {
  const [items, setItems] = useState([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ version: "", prompt: "", tenantScoped: true, activate: false });

  const load = async () => {
    try {
      const data = await readJson(await apiRequest("/classifications/prompts/versions"));
      setItems(data?.items || []);
    } catch (error) {
      toast.error(error.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    setSaving(true);
    try {
      await readJson(await apiRequest("/classifications/prompts/versions", {
        method: "POST",
        body: JSON.stringify(form),
      }));
      toast.success("Versao de prompt criada");
      setEditorOpen(false);
      setForm({ version: "", prompt: "", tenantScoped: true, activate: false });
      await load();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const activate = async (id) => {
    try {
      await readJson(await apiRequest(`/classifications/prompts/versions/${id}/activate`, { method: "POST" }));
      toast.success("Prompt ativado");
      await load();
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <div className="border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <SectionHeader
        title="Versoes de prompt"
        action={<button onClick={() => setEditorOpen(true)} className={primaryClass}><Plus size={14} /> Nova versao</button>}
      />
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {items.map((item) => (
          <div key={item.id} className="grid items-center gap-4 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_160px_100px_auto]">
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold">{item.version}</div>
              <div className="mt-1 truncate font-mono text-[10px] text-slate-400">{item.id}</div>
            </div>
            <div className="hidden text-xs text-slate-500 sm:block">{item.tenantId ? "Tenant" : "Global"}</div>
            <div className="text-xs font-semibold">{item.active ? "Ativo" : "Inativo"}</div>
            {!item.active ? <button onClick={() => activate(item.id)} className={buttonClass}><CirclePlay size={14} /> Ativar</button> : <span />}
          </div>
        ))}
        {!items.length && <div className="px-5 py-16 text-center text-sm text-slate-400">Nenhuma versao personalizada registrada.</div>}
      </div>
      <OperationalModal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title="Nova versao de prompt"
        context="Classificacao comercial"
        size="lg"
        footer={<div className="flex justify-end gap-2"><button onClick={() => setEditorOpen(false)} className={buttonClass}>Cancelar</button><button onClick={create} disabled={saving || !form.version || form.prompt.trim().length < 20} className={primaryClass}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Salvar versao</button></div>}
      >
        <div className="grid gap-5 p-5 md:grid-cols-2">
          <label><span className="mb-1.5 block text-xs font-semibold">Versao</span><input className={`${controlClass} w-full`} value={form.version} onChange={(event) => setForm({ ...form, version: event.target.value })} placeholder="v1.0.0" /></label>
          <label><span className="mb-1.5 block text-xs font-semibold">Escopo</span><select className={`${controlClass} w-full`} value={form.tenantScoped ? "tenant" : "global"} onChange={(event) => setForm({ ...form, tenantScoped: event.target.value === "tenant" })}><option value="tenant">Tenant selecionado</option><option value="global">Global</option></select></label>
          <label className="md:col-span-2"><span className="mb-1.5 block text-xs font-semibold">Prompt de sistema</span><textarea rows={16} className={`${controlClass} w-full font-mono text-xs`} value={form.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} /></label>
          <label className="flex items-center gap-2 text-xs font-semibold md:col-span-2"><input type="checkbox" checked={form.activate} onChange={(event) => setForm({ ...form, activate: event.target.checked })} /> Ativar imediatamente</label>
        </div>
      </OperationalModal>
    </div>
  );
};

const CommercialOperations = () => {
  const { user } = useAuth();
  const canWrite = ["SUPER_ADMIN", "ADMIN"].includes(user?.role);
  const [capabilities, setCapabilities] = useState({
    campaignRead: user?.role !== "MANAGER",
    cadenceRead: user?.role !== "MANAGER",
  });

  useEffect(() => {
    apiRequest("/outreach/capabilities")
      .then(readJson)
      .then(setCapabilities)
      .catch(() => {
        if (user?.role !== "MANAGER") setCapabilities({ campaignRead: true, cadenceRead: true });
      });
  }, [user?.role]);

  const tabs = useMemo(
    () => [
      ...(capabilities.campaignRead ? [{ id: "campaigns", label: "Campanhas", icon: Send }] : []),
      ...(capabilities.cadenceRead ? [{ id: "cadences", label: "Cadencias", icon: Activity }] : []),
      { id: "classifications", label: "Classificacoes", icon: Bot },
      ...(user?.role === "SUPER_ADMIN"
        ? [
            { id: "prompts", label: "IA", icon: Bot },
            { id: "integration", label: "Turizmo", icon: MessageSquareText },
          ]
        : []),
    ],
    [capabilities.campaignRead, capabilities.cadenceRead, user?.role],
  );
  const [tab, setTab] = useState(user?.role === "MANAGER" ? "classifications" : "campaigns");
  const activeTab = tabs.some((item) => item.id === tab) ? tab : "classifications";
  return (
    <div className="mx-auto w-full max-w-7xl space-y-5">
      <header className="flex flex-col gap-4 border-b border-slate-200 pb-4 dark:border-slate-800 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950 dark:text-white">
            Operacao comercial
          </h1>
        </div>
        <nav className="flex overflow-x-auto border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`inline-flex items-center gap-2 border-r border-slate-200 px-4 py-2.5 text-xs font-semibold last:border-r-0 dark:border-slate-800 ${activeTab === id ? "bg-blue-600 text-white" : "text-slate-500 hover:text-blue-600"}`}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </nav>
      </header>
      {activeTab === "campaigns" && <Campaigns canWrite={canWrite} />}
      {activeTab === "cadences" && <Cadences canWrite={canWrite} />}
      {activeTab === "classifications" && <Classifications />}
      {activeTab === "prompts" && <PromptManagement />}
      {activeTab === "integration" && <Integration />}
    </div>
  );
};

export default CommercialOperations;
