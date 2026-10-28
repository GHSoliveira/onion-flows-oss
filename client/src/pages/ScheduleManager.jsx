import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { deleteJSON, getJSON, postJSON } from '../services/api';
import { useTenant } from '../context/TenantContext';
import { useDialog } from '../context/DialogContext';
import { SkeletonBox } from '../components/LoadingSkeleton';
import OperationalModal from '../components/OperationalModal';

import TablePagination, { usePagination } from '../components/TablePagination';
const DAYS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];

const createRules = () => DAYS.reduce((result, day, index) => ({
  ...result,
  [day]: { active: index < 5, start: '08:00', end: '18:00' }
}), {});

const minutesFromTime = (value = '00:00') => {
  const [hours, minutes] = String(value).split(':').map(Number);
  return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
};

const ScheduleManager = () => {
  const [schedules, setSchedules] = useState([]);
  const schedulesPage = usePagination(schedules);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [rules, setRules] = useState(createRules);
  const [bulkStart, setBulkStart] = useState('08:00');
  const [bulkEnd, setBulkEnd] = useState('18:00');
  const { tenant } = useTenant();
  const { confirm } = useDialog();

  useEffect(() => { fetchSchedules(); }, []);

  const fetchSchedules = async () => {
    try {
      setLoading(true);
      const data = await getJSON('/schedules');
      if (Array.isArray(data)) setSchedules(data);
    } catch (error) {
      toast.error('Erro ao carregar horarios');
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setName('');
    setRules(createRules());
    setBulkStart('08:00');
    setBulkEnd('18:00');
  };

  const handleSave = async (event) => {
    event.preventDefault();
    if (!name.trim()) return toast.error('Defina um nome para o grupo.');
    try {
      setSaving(true);
      const payload = { name, rules };
      if (tenant?.id && tenant.id !== 'super_admin') payload.tenantId = tenant.id;
      const newSchedule = await postJSON('/schedules', payload);
      if (newSchedule?.id) {
        setSchedules((current) => [...current, newSchedule]);
        resetForm();
        setShowCreate(false);
        toast.success('Expediente salvo');
      }
    } catch (error) {
      toast.error(`Erro ao salvar: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    const accepted = await confirm({
      title: 'Excluir expediente',
      message: 'Esta acao pode afetar fluxos que dependem deste expediente.',
      confirmText: 'Excluir',
      type: 'danger'
    });
    if (!accepted) return;
    const previous = schedules;
    setSchedules((current) => current.filter((schedule) => schedule.id !== id));
    try {
      await deleteJSON(`/schedules/${id}`);
      toast.success('Expediente removido');
    } catch (error) {
      setSchedules(previous);
      toast.error('Erro ao excluir');
    }
  };

  const applyBulk = () => {
    setRules((current) => Object.fromEntries(Object.entries(current).map(([day, rule]) => [
      day,
      rule.active ? { ...rule, start: bulkStart, end: bulkEnd } : rule
    ])));
  };

  const metrics = useMemo(() => {
    const activeRules = schedules.flatMap((schedule) => DAYS.map((day) => schedule.rules?.[day]).filter((rule) => rule?.active));
    const weeklyMinutes = activeRules.reduce((total, rule) => total + Math.max(0, minutesFromTime(rule.end) - minutesFromTime(rule.start)), 0);
    const coveredDays = new Set(DAYS.filter((day) => schedules.some((schedule) => schedule.rules?.[day]?.active))).size;
    const jsDay = new Date().getDay();
    const today = DAYS[(jsDay + 6) % 7];
    const activeToday = schedules.filter((schedule) => schedule.rules?.[today]?.active).length;
    return {
      groups: schedules.length,
      coveredDays,
      weeklyHours: Math.round((weeklyMinutes / 60) * 10) / 10,
      activeToday
    };
  }, [schedules]);

  if (loading) {
    return (
      <main className='min-h-screen bg-gray-50 p-3 dark:bg-gray-900 sm:p-4 lg:p-6'>
        <div className='mx-auto max-w-[1440px] space-y-6'>
          <SkeletonBox className='h-8 w-40' />
          <SkeletonBox className='h-24 w-full' />
          <div className='space-y-3 border-y border-gray-200 py-5 dark:border-gray-800'>{Array.from({ length: 4 }).map((_, index) => <SkeletonBox key={index} className='h-12 w-full' />)}</div>
        </div>
      </main>
    );
  }

  return (
    <main className='min-h-screen bg-gray-50 p-3 dark:bg-gray-900 sm:p-4 lg:p-6'>
      <div className='mx-auto w-full max-w-[1440px]'>
        <header className='mb-7 flex items-center justify-between gap-4'>
          <h1 className='text-2xl font-semibold tracking-tight text-gray-950 dark:text-white'>Expediente</h1>
          <button type='button' onClick={() => setShowCreate(true)} className='inline-flex h-9 items-center gap-2 border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-600 transition hover:border-blue-500 hover:text-blue-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:text-blue-300'><Plus size={14} /> Novo expediente</button>
        </header>

        <section className='mb-7 border-y border-gray-200 dark:border-gray-800'>
          <div className='grid grid-cols-2 divide-x divide-gray-200 dark:divide-gray-800 lg:grid-cols-4'>
            {[
              ['Grupos', metrics.groups],
              ['Dias cobertos', `${metrics.coveredDays}/7`],
              ['Horas semanais', metrics.weeklyHours],
              ['Ativos hoje', metrics.activeToday]
            ].map(([label, value]) => (
              <div key={label} className='px-4 py-4 first:pl-0 lg:py-5'>
                <div className='text-xs text-gray-500 dark:text-gray-400'>{label}</div>
                <div className='mt-2 text-xl font-semibold text-gray-950 dark:text-white'>{value}</div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className='mb-4 text-base font-semibold text-gray-950 dark:text-white'>Operacao</h2>
          {schedules.length === 0 ? (
            <div className='border-y border-gray-200 py-10 dark:border-gray-800'>
              <div className='text-sm font-medium text-gray-700 dark:text-gray-200'>Nenhum expediente configurado.</div>
              <button type='button' onClick={() => setShowCreate(true)} className='mt-4 h-9 bg-blue-600 px-4 text-xs font-semibold text-white transition hover:bg-blue-700'>Criar expediente</button>
            </div>
          ) : (
            <div className='overflow-x-auto border-y border-gray-200 dark:border-gray-800'>
              <table className='w-full min-w-[820px]'>
                <thead><tr className='border-b border-gray-200 text-left dark:border-gray-800'>{['Nome', 'Dias ativos', 'Primeira abertura', 'Ultimo fechamento', 'Carga semanal', 'Acoes'].map((label) => <th key={label} className='px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400 first:pl-0'>{label}</th>)}</tr></thead>
                <tbody className='divide-y divide-gray-200 dark:divide-gray-800'>
                  {schedulesPage.pageItems.map((schedule) => {
                    const activeRules = DAYS.map((day) => schedule.rules?.[day]).filter((rule) => rule?.active);
                    const starts = activeRules.map((rule) => rule.start).sort();
                    const ends = activeRules.map((rule) => rule.end).sort();
                    const hours = activeRules.reduce((total, rule) => total + Math.max(0, minutesFromTime(rule.end) - minutesFromTime(rule.start)), 0) / 60;
                    return (
                      <tr key={schedule.id} className='transition hover:bg-white dark:hover:bg-gray-800/40'>
                        <td className='px-4 py-4 pl-0'><strong className='block text-sm font-semibold text-gray-900 dark:text-white'>{schedule.name}</strong><span className='mt-1 block text-[11px] text-gray-400'>{schedule.id}</span></td>
                        <td className='px-4 py-4 text-sm text-gray-600 dark:text-gray-300'>{activeRules.length}</td>
                        <td className='px-4 py-4 text-sm text-gray-600 dark:text-gray-300'>{starts[0] || '-'}</td>
                        <td className='px-4 py-4 text-sm text-gray-600 dark:text-gray-300'>{ends.at(-1) || '-'}</td>
                        <td className='px-4 py-4 text-sm text-gray-600 dark:text-gray-300'>{Math.round(hours * 10) / 10}h</td>
                        <td className='px-4 py-4'><button type='button' onClick={() => handleDelete(schedule.id)} className='grid h-8 w-8 place-items-center border border-gray-300 text-gray-500 transition hover:border-blue-500 hover:text-blue-700 dark:border-gray-700 dark:text-gray-400 dark:hover:text-blue-300' aria-label={`Excluir ${schedule.name}`}><Trash2 size={14} /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <TablePagination {...schedulesPage} label='expedientes' />
            </div>
          )}
        </section>

        <OperationalModal open={showCreate} onClose={() => setShowCreate(false)} size='lg' title='Novo expediente'>
          <form onSubmit={handleSave} className='p-5 sm:p-6'>
            <label className='block'>
              <span className='mb-2 block text-xs font-semibold text-gray-600 dark:text-gray-300'>Nome</span>
              <input value={name} onChange={(event) => setName(event.target.value)} required className='h-11 w-full border border-gray-300 bg-white px-3 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15 dark:border-gray-700 dark:bg-gray-950 dark:text-white' />
            </label>

            <div className='mt-6 grid gap-3 border-y border-gray-200 py-4 dark:border-gray-800 sm:grid-cols-[1fr_1fr_auto] sm:items-end'>
              <label><span className='mb-2 block text-xs font-semibold text-gray-600 dark:text-gray-300'>Inicio em massa</span><input type='time' value={bulkStart} onChange={(event) => setBulkStart(event.target.value)} className='h-10 w-full border border-gray-300 bg-white px-3 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-white' /></label>
              <label><span className='mb-2 block text-xs font-semibold text-gray-600 dark:text-gray-300'>Fim em massa</span><input type='time' value={bulkEnd} onChange={(event) => setBulkEnd(event.target.value)} className='h-10 w-full border border-gray-300 bg-white px-3 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-white' /></label>
              <button type='button' onClick={applyBulk} className='h-10 border border-gray-300 px-4 text-xs font-semibold text-gray-600 transition hover:border-blue-500 hover:text-blue-700 dark:border-gray-700 dark:text-gray-300'>Aplicar</button>
            </div>

            <div className='divide-y divide-gray-200 dark:divide-gray-800'>
              {DAYS.map((day) => (
                <div key={day} className='grid gap-3 py-3 sm:grid-cols-[150px_1fr_1fr] sm:items-center'>
                  <label className='inline-flex items-center gap-3 text-sm font-medium text-gray-700 dark:text-gray-200'><input type='checkbox' checked={rules[day].active} onChange={(event) => setRules({ ...rules, [day]: { ...rules[day], active: event.target.checked } })} className='h-4 w-4 accent-blue-600' />{day}</label>
                  <input type='time' disabled={!rules[day].active} value={rules[day].start} onChange={(event) => setRules({ ...rules, [day]: { ...rules[day], start: event.target.value } })} className='h-10 border border-gray-300 bg-white px-3 text-sm disabled:opacity-40 dark:border-gray-700 dark:bg-gray-950 dark:text-white' />
                  <input type='time' disabled={!rules[day].active} value={rules[day].end} onChange={(event) => setRules({ ...rules, [day]: { ...rules[day], end: event.target.value } })} className='h-10 border border-gray-300 bg-white px-3 text-sm disabled:opacity-40 dark:border-gray-700 dark:bg-gray-950 dark:text-white' />
                </div>
              ))}
            </div>

            <div className='mt-5 flex justify-end gap-2 border-t border-gray-200 pt-4 dark:border-gray-800'>
              <button type='button' onClick={() => { resetForm(); setShowCreate(false); }} className='h-9 border border-gray-300 px-4 text-xs font-semibold text-gray-600 transition hover:border-gray-500 dark:border-gray-700 dark:text-gray-300'>Cancelar</button>
              <button type='submit' disabled={saving} className='h-9 bg-blue-600 px-4 text-xs font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50'>{saving ? 'Salvando...' : 'Criar expediente'}</button>
            </div>
          </form>
        </OperationalModal>
      </div>
    </main>
  );
};

export default ScheduleManager;
