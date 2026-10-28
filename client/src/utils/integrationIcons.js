import { Calendar, Cloud, CreditCard, Database, FileText, Globe, Mail, Package, Server, ShoppingCart, Store, Truck, Users, Zap } from 'lucide-react';

// Icones que uma integracao pode usar; a chave e o que o servidor guarda.
export const INTEGRATION_ICONS = {
  globe: Globe,
  database: Database,
  cart: ShoppingCart,
  card: CreditCard,
  truck: Truck,
  users: Users,
  calendar: Calendar,
  package: Package,
  mail: Mail,
  cloud: Cloud,
  server: Server,
  zap: Zap,
  store: Store,
  file: FileText
};

export const INTEGRATION_ICON_LABELS = {
  globe: 'Globo', database: 'Banco de dados', cart: 'Carrinho', card: 'Cartão', truck: 'Entrega', users: 'Pessoas', calendar: 'Agenda',
  package: 'Pacote', mail: 'E-mail', cloud: 'Nuvem', server: 'Servidor', zap: 'Raio', store: 'Loja', file: 'Documento'
};

export const integrationIcon = (key) => INTEGRATION_ICONS[key] || Globe;
