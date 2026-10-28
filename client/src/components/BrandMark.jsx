import { useEffect, useState } from 'react';
import OnionMark from './login-kit/OnionMark';
import { useBrand } from '../context/BrandingContext';
import { brandInitial, initialColors } from '../utils/brandInitial';

// Logo da marca do painel. Sem logo cadastrado (ou se a imagem nao carregar):
// marca padrao usa a cebola da Onion; marca de agencia usa a inicial do nome.
const BrandMark = ({ className = '', color = null, label = undefined }) => {
  const brand = useBrand();
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [brand.logoUrl]);
  const name = label ?? brand.productName;

  if (brand.logoUrl && !failed) {
    return <img src={brand.logoUrl} alt={name} className={`shrink-0 object-contain ${className}`} onError={() => setFailed(true)} />;
  }
  if (brand.custom) {
    const { bg, fg } = initialColors(color, brand.primaryColor);
    return (
      <svg viewBox="0 0 100 100" role="img" aria-label={name} className={`shrink-0 ${className}`}>
        <rect width="100" height="100" rx="22" fill={bg} />
        <text x="50" y="52" textAnchor="middle" dominantBaseline="central" fontSize="58" fontWeight="700" fill={fg} style={{ fontFamily: 'inherit' }}>{brandInitial(name)}</text>
      </svg>
    );
  }
  return <OnionMark color={color || brand.primaryColor || '#155DFC'} className={className} label={name} />;
};

export default BrandMark;
