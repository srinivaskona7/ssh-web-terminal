import { render } from 'preact';
import '@webssh/ui-kit/tokens.css';
import '@webssh/ui-kit/ui-kit.css';
import './ui/app.css';
import { App } from './ui/App';

if (typeof window !== 'undefined' && 'serviceWorker' in navigator && window.location.protocol === 'https:') {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => {
      // Offline SW registration optional in restricted contexts
    });
  });
}

const root = document.getElementById('app');
if (root) {
  render(<App />, root);
}
