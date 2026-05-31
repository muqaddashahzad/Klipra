import { StrictMode, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import Landing from './Landing.jsx'

function Root() {
  const [showApp, setShowApp] = useState(() => {
    return (
      window.location.hash === '#app' ||
      localStorage.getItem('klipra_skip_landing') === '1' ||
      // Migrate users coming from old key
      localStorage.getItem('openshorts_skip_landing') === '1'
    );
  });

  useEffect(() => {
    const handleHashChange = () => {
      setShowApp(window.location.hash === '#app');
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const handleLaunchApp = () => {
    localStorage.setItem('klipra_skip_landing', '1');
    window.location.hash = '#app';
    setShowApp(true);
  };

  if (showApp) {
    return <App />;
  }

  return <Landing onEnterApp={handleLaunchApp} />;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
