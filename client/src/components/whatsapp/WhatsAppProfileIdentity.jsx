import { useCallback, useEffect, useRef, useState } from 'react';
import { ImagePlus, Loader2, MessageCircle, RefreshCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import { apiRequest } from '../../services/api';
import { useDialog } from '../../context/DialogContext';
import { SkeletonBox } from '../LoadingSkeleton';
import { Chip, NAME_STATUS, TONES } from './whatsappLabels';
import { useBrand } from '../../context/BrandingContext';

// Aba "Nome e foto" da Central do WhatsApp: troca a foto de perfil na hora e pede
// novo nome de exibicao, que passa pela analise da Meta.

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png'];

const Card = ({ title, subtitle, children }) => (
  <section className="flex min-w-0 flex-col border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
    <header className="border-b border-gray-100 px-4 py-3 dark:border-gray-800">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h2>
      {subtitle ? <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{subtitle}</p> : null}
    </header>
    <div className="flex-1 px-4 py-4">{children}</div>
  </section>
);

const NEW_NAME_BOX = {
  PENDING_REVIEW: { tone: 'warning', label: 'Em análise pela Meta' },
  DECLINED: { tone: 'critical', label: 'Recusado pela Meta' },
  APPROVED: { tone: 'good', label: 'Aprovado' },
  AVAILABLE_WITHOUT_REVIEW: { tone: 'good', label: 'Aprovado' }
};

export default function WhatsAppProfileIdentity({ q = '' }) {
  const brand = useBrand();
  const { confirm } = useDialog();
  const inputRef = useRef(null);
  const [identity, setIdentity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [photo, setPhoto] = useState(null);
  const [sendingPhoto, setSendingPhoto] = useState(false);
  const [newName, setNewName] = useState('');
  const [sendingName, setSendingName] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest(`/channels/whatsapp/profile-identity${q}`);
      if (!res) return;
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Não foi possível carregar o nome e a foto.');
      setIdentity(data);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [q]);

  useEffect(() => { load(); }, [load]);

  const handlePickFile = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!TYPES.includes(file.type)) return toast.error('Use uma imagem JPG ou PNG.');
    if (file.size > MAX_BYTES) return toast.error('A imagem precisa ter até 5 MB.');
    const reader = new FileReader();
    reader.onload = () => setPhoto({ dataUrl: reader.result, fileName: file.name });
    reader.onerror = () => toast.error('Não deu para ler a imagem.');
    reader.readAsDataURL(file);
  };

  const handleSendPhoto = async () => {
    if (!photo) return;
    setSendingPhoto(true);
    try {
      const res = await apiRequest(`/channels/whatsapp/profile-picture${q}`, { method: 'POST', body: JSON.stringify(photo) });
      const data = res ? await res.json().catch(() => ({})) : null;
      if (!res || !res.ok) throw new Error(data?.error || 'Não foi possível trocar a foto.');
      setIdentity((prev) => ({ ...prev, profilePictureUrl: data.profilePictureUrl || prev?.profilePictureUrl || null }));
      setPhoto(null);
      toast.success('Foto de perfil atualizada');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSendingPhoto(false);
    }
  };

  const handleSendName = async () => {
    const name = newName.replace(/\s+/g, ' ').trim();
    if (name.length < 3) return toast.error('O nome precisa ter pelo menos 3 caracteres.');
    if (identity?.newNameStatus === 'PENDING_REVIEW' && identity?.newDisplayName) {
      const ok = await confirm({
        title: 'Substituir nome em análise',
        message: `O nome "${identity.newDisplayName}" ainda está em análise pela Meta. Enviar "${name}" substitui esse pedido.`,
        confirmText: 'Enviar novo nome',
        type: 'warning'
      });
      if (!ok) return;
    }
    setSendingName(true);
    try {
      const res = await apiRequest(`/channels/whatsapp/display-name${q}`, { method: 'POST', body: JSON.stringify({ name }) });
      const data = res ? await res.json().catch(() => ({})) : null;
      if (!res || !res.ok) throw new Error(data?.error || 'Não foi possível enviar o nome.');
      setIdentity(data.identity || identity);
      setNewName('');
      toast.success('Nome enviado para análise da Meta');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSendingName(false);
    }
  };

  if (loading && !identity) {
    return (
      <div className="grid gap-3 lg:grid-cols-2" aria-busy="true">
        {[0, 1].map((index) => (
          <div key={`perfil_skel_${index}`} className="space-y-3 border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
            <SkeletonBox className="h-4 w-32" />
            <SkeletonBox className="h-24 w-24 rounded-full" />
            <SkeletonBox className="h-3 w-full" />
          </div>
        ))}
      </div>
    );
  }

  if (error && !identity) {
    return (
      <div className="border border-gray-200 bg-white px-6 py-10 text-center dark:border-gray-800 dark:bg-gray-900">
        <p className="text-sm font-medium text-gray-900 dark:text-white">Não deu para carregar o nome e a foto</p>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{error}</p>
        <button type="button" onClick={load} className="mt-4 inline-flex h-9 items-center gap-2 border border-gray-300 px-3 text-xs font-semibold text-gray-700 hover:border-blue-500 hover:text-blue-600 dark:border-gray-600 dark:text-gray-200">
          <RefreshCcw size={14} aria-hidden="true" /> Tentar de novo
        </button>
      </div>
    );
  }

  const currentStatus = NAME_STATUS[identity?.nameStatus];
  const newBox = identity?.newDisplayName ? NEW_NAME_BOX[identity.newNameStatus] : null;
  const used = identity?.nameChanges?.used || 0;
  const limit = identity?.nameChanges?.limit || 10;
  const shownPicture = photo?.dataUrl || identity?.profilePictureUrl || null;

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card title="Foto de perfil" subtitle="Troca na hora, sem análise da Meta">
        <div className="flex flex-wrap items-center gap-5">
          <div className="grid h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-full border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
            {shownPicture
              ? <img src={shownPicture} alt={photo ? 'Prévia da nova foto' : 'Foto de perfil atual'} className="h-full w-full object-cover" />
              : <MessageCircle size={28} className="text-gray-300 dark:text-gray-600" aria-hidden="true" />}
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {photo ? 'Prévia da nova foto. Confira antes de enviar.' : shownPicture ? 'Foto atual do número.' : 'Este número ainda não tem foto.'}
            </p>
            <input ref={inputRef} type="file" accept="image/jpeg,image/png" onChange={handlePickFile} className="hidden" />
            <div className="flex flex-wrap gap-2">
              {photo ? (
                <>
                  <button type="button" onClick={handleSendPhoto} disabled={sendingPhoto} className="inline-flex h-9 items-center gap-2 border border-emerald-600 bg-emerald-600 px-3 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                    {sendingPhoto ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <ImagePlus size={14} aria-hidden="true" />}
                    {sendingPhoto ? 'Enviando...' : 'Enviar foto'}
                  </button>
                  <button type="button" onClick={() => setPhoto(null)} disabled={sendingPhoto} className="inline-flex h-9 items-center border border-gray-300 px-3 text-xs font-semibold text-gray-700 hover:border-gray-400 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200">
                    Cancelar
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => inputRef.current?.click()} className="inline-flex h-9 items-center gap-2 border border-gray-300 px-3 text-xs font-semibold text-gray-700 hover:border-blue-500 hover:text-blue-600 dark:border-gray-600 dark:text-gray-200">
                  <ImagePlus size={14} aria-hidden="true" /> Escolher imagem
                </button>
              )}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">JPG ou PNG, até 5 MB. Prefira imagem quadrada: o WhatsApp mostra a foto em círculo.</p>
          </div>
        </div>
      </Card>

      <Card title="Nome de exibição" subtitle="O nome que o cliente vê no WhatsApp">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-lg font-semibold text-gray-900 dark:text-white">{identity?.verifiedName || '—'}</span>
            {currentStatus ? <Chip tone={currentStatus.tone}>{currentStatus.label}</Chip> : null}
          </div>

          {newBox ? (
            <div className={`border px-3 py-2 text-sm ${TONES[newBox.tone].chip}`}>
              <span className="font-semibold">{newBox.label}:</span> {identity.newDisplayName}
            </div>
          ) : null}

          <div>
            <label htmlFor="novo-nome-exibicao" className="text-xs font-semibold text-gray-600 dark:text-gray-300">Pedir novo nome</label>
            <div className="mt-1 flex gap-2">
              <input
                id="novo-nome-exibicao"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                maxLength={128}
                placeholder="Nome da empresa como o cliente conhece"
                className="min-w-0 flex-1 border border-gray-300 bg-gray-50 px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              />
              <button type="button" onClick={handleSendName} disabled={sendingName || used >= limit || newName.trim().length < 3} className="inline-flex shrink-0 items-center gap-2 border border-blue-600 bg-blue-600 px-3 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                {sendingName ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
                Enviar
              </button>
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{used} de {limit} pedidos feitos pelo {brand.productName} nos últimos 30 dias.</p>
          </div>

          <ul className="space-y-1.5 border-t border-gray-100 pt-3 text-xs leading-relaxed text-gray-500 dark:border-gray-800 dark:text-gray-400">
            <li>A Meta analisa cada nome. O nome precisa ter relação com a empresa; nome genérico ou de pessoa costuma ser recusado.</li>
            <li>
              Depois de aprovado, o número precisa ser registrado de novo em até 14 dias.{' '}
              {identity?.pinStored
                ? `O ${brand.productName} faz isso sozinho, porque tem o PIN deste número.`
                : `O ${brand.productName} não tem o PIN deste número: quando o nome for aprovado, você recebe um alerta para registrar na aba Conexão.`}
            </li>
          </ul>
        </div>
      </Card>
    </div>
  );
}
