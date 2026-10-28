import adapter from '../../db/DatabaseAdapter.js';
import { markOffline, markOnline } from './userStatus.js';

// Presenca pelo socket: conectou, esta online; a ultima sessao caiu, offline.
//
// Antes so o login e o heartbeat marcavam online, e a lista vive em memoria.
// Todo reinicio do servidor zerava a lista: os paineis reconectavam o socket
// sozinhos, mas o monitoramento mostrava todo mundo offline ate o proximo
// heartbeat ou login. O offline ja vinha do socket; agora o online tambem.

const outrasSessoes = (io, socket) => [...(io?.sockets?.sockets?.values?.() || [])]
  .some((outro) => outro.id !== socket.id && outro.userId === socket.userId);

const avisarTenant = (io, socket, status) => {
  const alvo = socket.tenantId ? io.to(`tenant:${socket.tenantId}`) : io;
  alvo.emit('user_status', { userId: socket.userId, status });
};

export const handleSocketConnected = async (io, socket) => {
  if (!socket?.userId) return false;
  markOnline(socket.userId);
  // Outra aba ou a extensao ja deixavam a pessoa online: nada muda para quem ve.
  if (outrasSessoes(io, socket)) return false;
  await adapter.updateOne('users', { id: socket.userId }, {
    $set: { status: 'online', lastSeen: new Date().toISOString() }
  }).catch(() => {});
  avisarTenant(io, socket, 'online');
  return true;
};

export const handleSocketDisconnected = async (io, socket) => {
  if (!socket?.userId) return false;
  // Nao marca offline se ainda houver outra sessao (browser + extensao).
  if (outrasSessoes(io, socket)) return false;
  markOffline(socket.userId);
  await adapter.updateOne('users', { id: socket.userId }, {
    $set: { status: 'offline', lastSeen: new Date().toISOString() }
  }).catch(() => {});
  avisarTenant(io, socket, 'offline');
  return true;
};
