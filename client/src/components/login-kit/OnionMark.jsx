import onionMark from '../../assets/brand/Onion_logo_mark_v2.png';

const OnionMark = ({ color = '#155DFC', className = '', label }) => (
  <span
    className={`inline-block shrink-0 ${className}`}
    role={label ? 'img' : undefined}
    aria-label={label}
    aria-hidden={label ? undefined : 'true'}
    style={{
      backgroundColor: color,
      WebkitMaskImage: `url(${onionMark})`,
      maskImage: `url(${onionMark})`,
      WebkitMaskPosition: 'center',
      maskPosition: 'center',
      WebkitMaskRepeat: 'no-repeat',
      maskRepeat: 'no-repeat',
      WebkitMaskSize: 'contain',
      maskSize: 'contain'
    }}
  />
);

export default OnionMark;
