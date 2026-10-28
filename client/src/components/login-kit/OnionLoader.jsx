import './OnionLoader.css';
import petalMajor from '../../assets/brand/Onion-petal-major.png';
import petalMid from '../../assets/brand/Onion-petal-mid.png';
import petalMinor from '../../assets/brand/Onion-petal-minor.png';

const OnionLoader = ({ size = 88, label = 'Carregando', className = '' }) => (
  <div className={`onion-loader ${className}`} role="status" aria-live="polite" aria-label={label}>
    <div className="onion-loader__mark" style={{ '--onion-loader-size': `${size}px` }} aria-hidden="true">
      <span className="onion-loader__aura" />
      <span className="onion-loader__leaf onion-loader__leaf--major" style={{ '--onion-petal': `url(${petalMajor})` }} />
      <span className="onion-loader__leaf onion-loader__leaf--mid" style={{ '--onion-petal': `url(${petalMid})` }} />
      <span className="onion-loader__leaf onion-loader__leaf--minor" style={{ '--onion-petal': `url(${petalMinor})` }} />
    </div>
    {label ? <span className="onion-loader__label">{label}</span> : null}
  </div>
);

export default OnionLoader;
