import { useState, useEffect } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { getJSON, postJSON, deleteJSON, apiRequest } from '../services/api';
import { useDialog } from '../context/DialogContext';
import { SkeletonBox } from '../components/LoadingSkeleton';
import OperationalModal from '../components/OperationalModal';
import TablePagination, { usePagination } from '../components/TablePagination';

const EMPTY_FORM = {
  name: '',
  type: 'text',
  defaultValue: '',
  description: '',
  isRoot: false,
  enabled: true
};

const VariableManager = () => {
  const { confirm } = useDialog();
  const [variables, setVariables] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const variablesPage = usePagination(variables);

  useEffect(() => { fetchVariables(); }, []);

  const fetchVariables = async () => {
    try {
      const data = await getJSON('/variables');
      setVariables(data || []);
    } catch (error) {
      console.error('Erro:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (event) => {
    event.preventDefault();
    try {
      setSaving(true);
      const created = await postJSON('/variables', form);
      setVariables((prev) => [...prev, created]);
      setForm(EMPTY_FORM);
      setShowCreate(false);
      toast.success('Variavel criada');
    } catch {
      toast.error('Erro ao criar variavel');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    const confirmed = await confirm({
      title: 'Excluir variavel',
      message: 'Tem certeza que deseja excluir esta variavel?',
      confirmText: 'Excluir',
      type: 'danger'
    });
    if (!confirmed) return;
    const previous = variables;
    setVariables((prev) => prev.filter((item) => item.id !== id));
    try {
      await deleteJSON(`/variables/${id}`);
      toast.success('Variavel removida');
    } catch {
      setVariables(previous);
      toast.error('Erro ao excluir');
    }
  };

  const handleToggle = async (variable, patch) => {
    try {
      const { _id, id, ...rest } = variable;
      const response = await apiRequest(`/variables/${variable.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...rest, ...patch })
      });
      if (!response?.ok) {
        const payload = response ? await response.json() : null;
        toast.error(payload?.error || 'Erro ao atualizar variavel');
        return;
      }
      setVariables((prev) => prev.map((item) => (item.id === variable.id ? { ...item, ...patch } : item)));
    } catch {
      toast.error('Erro ao atualizar variavel');
    }
  };

  if (loading) {
    return (
      <main className='min-h-screen bg-gray-50 p-3 dark:bg-gray-900 sm:p-4 lg:p-6'>
        <div className='mx-auto max-w-[1440px] space-y-6'>
          <SkeletonBox className='h-8 w-40' />
          <SkeletonBox className='h-11 w-full' />
          <div className='space-y-3 border-y border-gray-200 py-5 dark:border-gray-800'>
            {Array.from({ length: 6 }).map((_, index) => <SkeletonBox key={`variable_skel_${index}`} className='h-10 w-full' />)}
          </div>
        </div>
      </main>
    );
  }

  const stats = [
    ['Total', variables.length],
    ['Ativas', variables.filter((variable) => variable.enabled !== false).length],
    ['Visiveis no atendimento', variables.filter((variable) => variable.isRoot === true).length],
    ['Tipos em uso', new Set(variables.map((variable) => variable.type)).size],
    ['Com valor padrao', variables.filter((variable) => variable.defaultValue !== '' && variable.defaultValue != null).length]
  ];

  return (
    <main className='min-h-screen bg-gray-50 p-3 dark:bg-gray-900 sm:p-4 lg:p-6'>
      <div className='mx-auto w-full max-w-[1440px]'>
        <header className='mb-7 flex items-center justify-between gap-4'>
          <h1 className='text-2xl font-semibold tracking-tight text-gray-950 dark:text-white'>Variaveis</h1>
          <button type='button' onClick={() => setShowCreate(true)} className='inline-flex h-9 items-center gap-2 border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-600 transition hover:border-blue-500 hover:text-blue-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:text-blue-300'>
            <Plus size={14} /> Nova variavel
          </button>
        </header>

        <section className='mb-7 border-y border-gray-200 dark:border-gray-800'>
          <div className='grid grid-cols-2 divide-x divide-gray-200 dark:divide-gray-800 lg:grid-cols-5'>
            {stats.map(([label, value], index) => (
              <div key={label} className={`px-4 py-4 first:pl-0 lg:py-5 ${index === 4 ? 'col-span-2 border-t border-gray-200 dark:border-gray-800 lg:col-span-1 lg:border-t-0' : ''}`}>
                <div className='text-xs text-gray-500 dark:text-gray-400'>{label}</div>
                <div className='mt-2 text-xl font-semibold text-gray-950 dark:text-white'>{value}</div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className='mb-4 text-base font-semibold text-gray-950 dark:text-white'>Operacao</h2>
          {variables.length === 0 ? (
            <div className='border-y border-gray-200 py-10 dark:border-gray-800'>
              <div className='text-sm font-medium text-gray-700 dark:text-gray-200'>Nenhuma variavel configurada.</div>
              <button type='button' onClick={() => setShowCreate(true)} className='mt-4 h-9 bg-blue-600 px-4 text-xs font-semibold text-white transition hover:bg-blue-700'>Criar variavel</button>
            </div>
          ) : (
            <div className='overflow-x-auto border-y border-gray-200 dark:border-gray-800'>
              <table className='w-full min-w-[760px]'>
                <thead><tr className='border-b border-gray-200 text-left dark:border-gray-800'>{['Nome', 'Tipo', 'Valor padrao', 'Visivel no atendimento', 'Estado', 'Acoes'].map((label) => <th key={label} className='px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400 first:pl-0'>{label}</th>)}</tr></thead>
                <tbody className='divide-y divide-gray-200 dark:divide-gray-800'>
                  {variablesPage.pageItems.map((variable) => (
                    <tr key={variable.id} className='transition hover:bg-white dark:hover:bg-gray-800/40'>
                      <td className='px-4 py-4 pl-0 text-sm font-semibold text-gray-900 dark:text-white'>{variable.name}</td>
                      <td className='px-4 py-4 text-xs uppercase text-gray-500 dark:text-gray-300'>{variable.type}</td>
                      <td className='max-w-[280px] truncate px-4 py-4 text-sm text-gray-600 dark:text-gray-300'>{variable.defaultValue === '' || variable.defaultValue == null ? '-' : String(variable.defaultValue)}</td>
                      <td className='px-4 py-4'><input aria-label={`Visivel no atendimento: ${variable.name}`} type='checkbox' checked={variable.isRoot === true} onChange={(event) => handleToggle(variable, { isRoot: event.target.checked })} className='h-4 w-4 accent-blue-600' /></td>
                      <td className='px-4 py-4'><label className='inline-flex items-center gap-2 text-xs text-gray-500 dark:text-gray-300'><input type='checkbox' checked={variable.enabled !== false} onChange={(event) => handleToggle(variable, { enabled: event.target.checked })} className='h-4 w-4 accent-blue-600' />{variable.enabled !== false ? 'Ativa' : 'Inativa'}</label></td>
                      <td className='px-4 py-4'><button type='button' onClick={() => handleDelete(variable.id)} className='grid h-8 w-8 place-items-center border border-gray-300 text-gray-500 transition hover:border-blue-500 hover:text-blue-700 dark:border-gray-700 dark:text-gray-400 dark:hover:text-blue-300' aria-label={`Excluir ${variable.name}`}><Trash2 size={14} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <TablePagination {...variablesPage} label='variaveis' />
            </div>
          )}
        </section>

        <OperationalModal open={showCreate} onClose={() => setShowCreate(false)} size='md' title='Nova variavel'>
          <form onSubmit={handleSave} className='p-5 sm:p-6'>
            <div className='grid gap-5 md:grid-cols-2'>
              <label className='block'>
                <span className='mb-2 block text-xs font-semibold text-gray-600 dark:text-gray-300'>Nome</span>
                <input type='text' required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className='h-11 w-full border border-gray-300 bg-white px-3 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15 dark:border-gray-700 dark:bg-gray-950 dark:text-white' />
              </label>
              <label className='block'>
                <span className='mb-2 block text-xs font-semibold text-gray-600 dark:text-gray-300'>Tipo</span>
                <select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })} className='h-11 w-full border border-gray-300 bg-white px-3 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15 dark:border-gray-700 dark:bg-gray-950 dark:text-white'>
                  <option value='text'>Texto</option>
                  <option value='number'>Numero</option>
                  <option value='boolean'>Boolean</option>
                  <option value='json'>JSON</option>
                </select>
              </label>
              <label className='block md:col-span-2'>
                <span className='mb-2 block text-xs font-semibold text-gray-600 dark:text-gray-300'>Valor padrao</span>
                <input type='text' value={form.defaultValue} onChange={(event) => setForm({ ...form, defaultValue: event.target.value })} className='h-11 w-full border border-gray-300 bg-white px-3 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15 dark:border-gray-700 dark:bg-gray-950 dark:text-white' />
              </label>
            </div>
            <div className='mt-6 flex flex-wrap gap-6 border-t border-gray-200 pt-5 text-sm text-gray-600 dark:border-gray-800 dark:text-gray-300'>
              <label className='inline-flex items-center gap-2'>
                <input type='checkbox' checked={form.isRoot} onChange={(event) => setForm({ ...form, isRoot: event.target.checked })} className='h-4 w-4 accent-blue-600' /> Disponibilizar no atendimento
              </label>
              <label className='inline-flex items-center gap-2'>
                <input type='checkbox' checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} className='h-4 w-4 accent-blue-600' /> Ativa
              </label>
            </div>
            <div className='mt-6 flex justify-end gap-2 border-t border-gray-200 pt-4 dark:border-gray-800'>
              <button type='button' onClick={() => { setForm(EMPTY_FORM); setShowCreate(false); }} className='h-9 border border-gray-300 px-4 text-xs font-semibold text-gray-600 transition hover:border-gray-500 dark:border-gray-700 dark:text-gray-300'>Cancelar</button>
              <button type='submit' disabled={saving} className='h-9 bg-blue-600 px-4 text-xs font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50'>{saving ? 'Criando...' : 'Criar variavel'}</button>
            </div>
          </form>
        </OperationalModal>
      </div>
    </main>
  );
};

export default VariableManager;
