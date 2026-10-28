// Ajustes de um fluxo exportado antes de gravar no tenant atual. Ids de
// interactive e de remetente so valem no tenant de onde o fluxo saiu.

// Interactive importado de outro tenant ganha id novo, e o no ainda aponta para
// o id de origem. Troca pelo id local do item que veio dele.
export const remapInteractiveRefs = (nodes, interactiveItems = []) => {
  const items = Array.isArray(interactiveItems) ? interactiveItems : [];
  const localIds = new Set(items.map((item) => String(item.id)));
  const bySourceId = new Map();
  items.forEach((item) => {
    const sourceId = item?.importedFrom?.id;
    if (sourceId && !bySourceId.has(String(sourceId))) bySourceId.set(String(sourceId), item.id);
  });

  return nodes.map((node) => {
    const ref = node?.data?.interactiveTemplateId;
    if (!ref || localIds.has(String(ref)) || !bySourceId.has(String(ref))) return node;
    return { ...node, data: { ...node.data, interactiveTemplateId: bySourceId.get(String(ref)) } };
  });
};

// Remetente fixado que nao e deste tenant sai do no, que passa a usar o numero
// padrao. Remetente do proprio tenant fica.
export const clearForeignSenders = (nodes, tenantSenderIds = []) => {
  const own = new Set((Array.isArray(tenantSenderIds) ? tenantSenderIds : []).filter(Boolean).map(String));
  return nodes.map((node) => {
    const sender = node?.data?.senderPhoneNumberId;
    if (!sender || own.has(String(sender))) return node;
    return { ...node, data: { ...node.data, senderPhoneNumberId: '' } };
  });
};
